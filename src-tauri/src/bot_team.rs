//! Bot 团队（内测）：定时任务（Routines）与 Bot 群聊的存储，以及它们的
//! 后台 agent 轮次入口。设计见 docs/plans/bots-upgrade-plan.zh-CN.md §4.6 /
//! §4.7 / §10 / §11.2。
//!
//! 存储：`<app_home>/bot-team/` 下的 JSON 文件，都是用户可读、可删的明文：
//!
//!   routines.json              全部定时任务
//!   groups.json                全部群聊
//!   runs/<routineId>.json      某个定时任务最近的运行记录（上限 RUNS_KEPT 条）
//!   messages/<groupId>.json    某个群聊的消息（上限 MESSAGES_KEPT 条）
//!
//! 调度在前端进行（拼 Bot 提示词、续接会话都在前端），但「这一次触发由谁
//! 执行」由这里裁决：`bot_routine_claim` 在进程级互斥锁下比较并写入
//! `lastSlotAt`，多个窗口同时到点也只有一个拿到执行权。
//!
//! agent 轮次复用宿主引擎管线，事件走 `mission-agent://event` 流（前端按
//! run id 路由）。run id 前缀 `botteam-`，与 mission / translate 互不可中断。
//! 后台轮次没人能中途点确认，所以 Bot 的权限设置这样映射（fail-closed）：
//!
//!   ask       → 只读工具白名单（引擎兑现不了就直接拒绝启动，不降级）
//!   auto-safe → 引擎的 auto 档
//!   full      → 引擎的 bypass 档（引擎不支持时由 resolve_permission 回落）
//!
//! 这些命令不进 web 访问的 dispatch 白名单：只在桌面端可用。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::engine;

const RUN_ID_PREFIX: &str = "botteam-";
const PARSE_RUN_ID_PREFIX: &str = "botteam-parse-";
const RUNS_KEPT: usize = 50;
const MESSAGES_KEPT: usize = 500;
const MAX_PROMPT_CHARS: usize = 200_000;
const MAX_NAME_CHARS: usize = 80;
const MAX_ROUTINE_PROMPT_CHARS: usize = 10_000;
const MAX_MESSAGE_CHARS: usize = 100_000;
const MIN_INTERVAL_MINUTES: u32 = 5;
const MAX_INTERVAL_MINUTES: u32 = 7 * 24 * 60;
const MIN_GROUP_MEMBERS: usize = 2;
const MAX_GROUP_MEMBERS: usize = 6;

/// 只读白名单（claude 工具名），与任务工作台只读节点一致。
const READ_ONLY_TOOLS: &[&str] = &["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

/// 进程级锁：所有文件读改写都在它下面，claim 的比较-写入因此是原子的。
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ---------------------------------------------------------------- model ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSchedule {
    /// "interval" | "daily" | "weekly"
    pub kind: String,
    /// interval：每隔多少分钟。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_minutes: Option<u32>,
    /// daily / weekly：本地时间 "HH:MM"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    /// weekly：0=周日 … 6=周六。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weekdays: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub bot_id: String,
    pub name: String,
    pub prompt: String,
    pub schedule: RoutineSchedule,
    pub engine: String,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub enabled: bool,
    /// "skip" | "run_once"
    pub missed_policy: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    /// 最近一次被认领的计划时刻（毫秒）。claim 只接受更晚的时刻。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_slot_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<u64>,
    /// "ok" | "error" | "cancelled"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRun {
    pub id: String,
    pub routine_id: String,
    pub bot_id: String,
    /// "schedule" | "manual" | "catchup"
    pub trigger: String,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    /// "running" | "ok" | "error" | "cancelled"
    pub status: String,
    #[serde(default)]
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotGroup {
    pub id: String,
    pub name: String,
    pub member_bot_ids: Vec<String>,
    pub engine: String,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub max_rounds: u32,
    pub max_bot_messages_per_send: u32,
    /// 每个成员在该群里的引擎会话 id（续接用）。
    #[serde(default)]
    pub member_sessions: std::collections::BTreeMap<String, String>,
    /// 有成员 @user 后置位，用户下一次发言清除。
    #[serde(default)]
    pub needs_user: bool,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupMessage {
    pub id: String,
    pub group_id: String,
    /// "user" 或成员 bot id。
    pub author: String,
    pub text: String,
    pub created_at: u64,
    /// "ok" | "error"（成员运行失败时也留一条，如实展示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BotTeamState {
    pub routines: Vec<Routine>,
    pub groups: Vec<BotGroup>,
}

// ---------------------------------------------------------------- paths ---

fn team_dir() -> PathBuf {
    crate::paths::app_home().join("bot-team")
}

fn routines_file(root: &Path) -> PathBuf {
    root.join("routines.json")
}

fn groups_file(root: &Path) -> PathBuf {
    root.join("groups.json")
}

fn runs_file(root: &Path, routine_id: &str) -> PathBuf {
    root.join("runs").join(format!("{routine_id}.json"))
}

fn messages_file(root: &Path, group_id: &str) -> PathBuf {
    root.join("messages").join(format!("{group_id}.json"))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ------------------------------------------------------------------ io ---

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(T::default()),
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("Failed to parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(format!("Failed to read {}: {e}", path.display())),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    crate::settings::atomic_write(path, &format!("{text}\n"))
}

/// ids 由前端生成，会拼进文件名：只允许安全字符。
fn validate_id(id: &str, what: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid {what} id"))
    }
}

fn clean_name(name: &str, what: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("{what} name is required"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("{what} name is too long"));
    }
    Ok(name.to_string())
}

fn clean_optional(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_hhmm(value: &str) -> Option<(u8, u8)> {
    let (h, m) = value.trim().split_once(':')?;
    let h: u8 = h.parse().ok()?;
    let m: u8 = m.parse().ok()?;
    (h < 24 && m < 60).then_some((h, m))
}

fn validate_schedule(schedule: &RoutineSchedule) -> Result<RoutineSchedule, String> {
    match schedule.kind.as_str() {
        "interval" => {
            let every = schedule.every_minutes.unwrap_or(0);
            if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&every) {
                return Err(format!(
                    "Interval must be between {MIN_INTERVAL_MINUTES} and {MAX_INTERVAL_MINUTES} minutes"
                ));
            }
            Ok(RoutineSchedule {
                kind: "interval".into(),
                every_minutes: Some(every),
                time: None,
                weekdays: Vec::new(),
            })
        }
        kind @ ("daily" | "weekly") => {
            let time = schedule.time.as_deref().unwrap_or("");
            let (h, m) = parse_hhmm(time).ok_or("Time must be HH:MM")?;
            let mut weekdays: Vec<u8> = Vec::new();
            if kind == "weekly" {
                for day in &schedule.weekdays {
                    if *day > 6 {
                        return Err("Weekday must be 0-6".into());
                    }
                    if !weekdays.contains(day) {
                        weekdays.push(*day);
                    }
                }
                weekdays.sort_unstable();
                if weekdays.is_empty() {
                    return Err("Pick at least one weekday".into());
                }
            }
            Ok(RoutineSchedule {
                kind: kind.to_string(),
                every_minutes: None,
                time: Some(format!("{h:02}:{m:02}")),
                weekdays,
            })
        }
        other => Err(format!("Unknown schedule kind: {other}")),
    }
}

fn validate_routine(input: &Routine) -> Result<Routine, String> {
    validate_id(&input.id, "routine")?;
    validate_id(&input.bot_id, "bot")?;
    let prompt = input.prompt.trim();
    if prompt.is_empty() {
        return Err("Routine prompt is required".into());
    }
    if prompt.chars().count() > MAX_ROUTINE_PROMPT_CHARS {
        return Err("Routine prompt is too long".into());
    }
    if input.engine.trim().is_empty() {
        return Err("Engine is required".into());
    }
    if input.workspace_path.trim().is_empty() {
        return Err("Working directory is required".into());
    }
    let missed = match input.missed_policy.as_str() {
        "" | "run_once" => "run_once",
        "skip" => "skip",
        other => return Err(format!("Unknown missed policy: {other}")),
    };
    Ok(Routine {
        id: input.id.clone(),
        bot_id: input.bot_id.clone(),
        name: clean_name(&input.name, "Routine")?,
        prompt: prompt.to_string(),
        schedule: validate_schedule(&input.schedule)?,
        engine: input.engine.trim().to_string(),
        workspace_path: input.workspace_path.trim().to_string(),
        model: clean_optional(&input.model),
        provider_id: clean_optional(&input.provider_id),
        enabled: input.enabled,
        missed_policy: missed.to_string(),
        created_at: input.created_at,
        updated_at: input.updated_at,
        last_slot_at: input.last_slot_at,
        last_run_at: input.last_run_at,
        last_status: input.last_status.clone(),
        last_error: input.last_error.clone(),
    })
}

fn validate_group(input: &BotGroup) -> Result<BotGroup, String> {
    validate_id(&input.id, "group")?;
    let mut members: Vec<String> = Vec::new();
    for id in &input.member_bot_ids {
        validate_id(id, "bot")?;
        if !members.contains(id) {
            members.push(id.clone());
        }
    }
    if !(MIN_GROUP_MEMBERS..=MAX_GROUP_MEMBERS).contains(&members.len()) {
        return Err(format!(
            "A group needs {MIN_GROUP_MEMBERS}-{MAX_GROUP_MEMBERS} bots"
        ));
    }
    if input.engine.trim().is_empty() {
        return Err("Engine is required".into());
    }
    if input.workspace_path.trim().is_empty() {
        return Err("Working directory is required".into());
    }
    // 成员会话只留现任成员的。
    let member_sessions = input
        .member_sessions
        .iter()
        .filter(|(bot, _)| members.contains(bot))
        .map(|(bot, session)| (bot.clone(), session.clone()))
        .collect();
    Ok(BotGroup {
        id: input.id.clone(),
        name: clean_name(&input.name, "Group")?,
        member_bot_ids: members,
        engine: input.engine.trim().to_string(),
        workspace_path: input.workspace_path.trim().to_string(),
        model: clean_optional(&input.model),
        provider_id: clean_optional(&input.provider_id),
        max_rounds: input.max_rounds.clamp(1, 10),
        max_bot_messages_per_send: input.max_bot_messages_per_send.clamp(1, 30),
        member_sessions,
        needs_user: input.needs_user,
        created_at: input.created_at,
        updated_at: input.updated_at,
    })
}

// ------------------------------------------------------- store (by root) ---

fn load_in(root: &Path) -> Result<BotTeamState, String> {
    Ok(BotTeamState {
        routines: read_json(&routines_file(root))?,
        groups: read_json(&groups_file(root))?,
    })
}

fn routine_save_in(root: &Path, input: Routine) -> Result<Routine, String> {
    let mut routine = validate_routine(&input)?;
    let mut routines: Vec<Routine> = read_json(&routines_file(root))?;
    let now = now_millis();
    match routines.iter_mut().find(|r| r.id == routine.id) {
        Some(existing) => {
            // 调度状态以存储为准：编辑表单不能把 claim 写回旧值。
            routine.created_at = existing.created_at;
            routine.last_slot_at = existing.last_slot_at;
            routine.last_run_at = existing.last_run_at;
            routine.last_status = existing.last_status.clone();
            routine.last_error = existing.last_error.clone();
            routine.updated_at = now;
            *existing = routine.clone();
        }
        None => {
            routine.created_at = now;
            routine.updated_at = now;
            // 新建的任务从现在开始算，不补跑「过去的」时刻。
            routine.last_slot_at = Some(now);
            routines.push(routine.clone());
        }
    }
    write_json(&routines_file(root), &routines)?;
    Ok(routine)
}

fn routine_delete_in(root: &Path, id: &str) -> Result<bool, String> {
    validate_id(id, "routine")?;
    let mut routines: Vec<Routine> = read_json(&routines_file(root))?;
    let before = routines.len();
    routines.retain(|r| r.id != id);
    if routines.len() == before {
        return Ok(false);
    }
    write_json(&routines_file(root), &routines)?;
    let _ = std::fs::remove_file(runs_file(root, id));
    Ok(true)
}

/// 比较并写入：只有 slot_at 晚于已认领的时刻才成功。
fn routine_claim_in(root: &Path, id: &str, slot_at: u64) -> Result<Option<Routine>, String> {
    validate_id(id, "routine")?;
    let mut routines: Vec<Routine> = read_json(&routines_file(root))?;
    let Some(routine) = routines.iter_mut().find(|r| r.id == id) else {
        return Ok(None);
    };
    if routine.last_slot_at.is_some_and(|last| last >= slot_at) {
        return Ok(None);
    }
    routine.last_slot_at = Some(slot_at);
    routine.last_run_at = Some(now_millis());
    let claimed = routine.clone();
    write_json(&routines_file(root), &routines)?;
    Ok(Some(claimed))
}

fn routine_finish_in(
    root: &Path,
    id: &str,
    status: &str,
    error: Option<String>,
) -> Result<Option<Routine>, String> {
    validate_id(id, "routine")?;
    let status = match status {
        s @ ("ok" | "error" | "cancelled") => s.to_string(),
        other => return Err(format!("Unknown status: {other}")),
    };
    let mut routines: Vec<Routine> = read_json(&routines_file(root))?;
    let Some(routine) = routines.iter_mut().find(|r| r.id == id) else {
        return Ok(None);
    };
    routine.last_status = Some(status);
    // 手动「立即运行」不经过 claim，这里同样记一次运行时间。
    routine.last_run_at = Some(now_millis());
    routine.last_error = error.filter(|e| !e.trim().is_empty());
    let updated = routine.clone();
    write_json(&routines_file(root), &routines)?;
    Ok(Some(updated))
}

fn runs_in(root: &Path, routine_id: &str) -> Result<Vec<RoutineRun>, String> {
    validate_id(routine_id, "routine")?;
    read_json(&runs_file(root, routine_id))
}

fn run_save_in(root: &Path, run: RoutineRun) -> Result<(), String> {
    validate_id(&run.routine_id, "routine")?;
    validate_id(&run.id, "run")?;
    let path = runs_file(root, &run.routine_id);
    let mut runs: Vec<RoutineRun> = read_json(&path)?;
    let mut run = run;
    if run.output.chars().count() > MAX_MESSAGE_CHARS {
        run.output = run.output.chars().take(MAX_MESSAGE_CHARS).collect();
    }
    match runs.iter_mut().find(|r| r.id == run.id) {
        Some(existing) => *existing = run,
        None => runs.push(run),
    }
    runs.sort_by_key(|r| r.started_at);
    if runs.len() > RUNS_KEPT {
        let excess = runs.len() - RUNS_KEPT;
        runs.drain(..excess);
    }
    write_json(&path, &runs)
}

fn group_save_in(root: &Path, input: BotGroup) -> Result<BotGroup, String> {
    let mut group = validate_group(&input)?;
    let mut groups: Vec<BotGroup> = read_json(&groups_file(root))?;
    let now = now_millis();
    match groups.iter_mut().find(|g| g.id == group.id) {
        Some(existing) => {
            group.created_at = existing.created_at;
            group.updated_at = now;
            *existing = group.clone();
        }
        None => {
            group.created_at = now;
            group.updated_at = now;
            groups.push(group.clone());
        }
    }
    write_json(&groups_file(root), &groups)?;
    Ok(group)
}

fn group_delete_in(root: &Path, id: &str) -> Result<bool, String> {
    validate_id(id, "group")?;
    let mut groups: Vec<BotGroup> = read_json(&groups_file(root))?;
    let before = groups.len();
    groups.retain(|g| g.id != id);
    if groups.len() == before {
        return Ok(false);
    }
    write_json(&groups_file(root), &groups)?;
    let _ = std::fs::remove_file(messages_file(root, id));
    Ok(true)
}

fn messages_in(root: &Path, group_id: &str) -> Result<Vec<GroupMessage>, String> {
    validate_id(group_id, "group")?;
    read_json(&messages_file(root, group_id))
}

fn messages_append_in(root: &Path, group_id: &str, incoming: Vec<GroupMessage>) -> Result<(), String> {
    validate_id(group_id, "group")?;
    let path = messages_file(root, group_id);
    let mut messages: Vec<GroupMessage> = read_json(&path)?;
    for mut message in incoming {
        validate_id(&message.id, "message")?;
        if message.group_id != group_id {
            return Err("Message belongs to another group".into());
        }
        if message.text.chars().count() > MAX_MESSAGE_CHARS {
            message.text = message.text.chars().take(MAX_MESSAGE_CHARS).collect();
        }
        match messages.iter_mut().find(|m| m.id == message.id) {
            Some(existing) => *existing = message,
            None => messages.push(message),
        }
    }
    if messages.len() > MESSAGES_KEPT {
        let excess = messages.len() - MESSAGES_KEPT;
        messages.drain(..excess);
    }
    write_json(&path, &messages)
}

fn messages_clear_in(root: &Path, group_id: &str) -> Result<(), String> {
    validate_id(group_id, "group")?;
    match std::fs::remove_file(messages_file(root, group_id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to clear messages: {e}")),
    }
}

// ------------------------------------------------------------- commands ---

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        f(&team_dir())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn bot_team_load() -> Result<BotTeamState, String> {
    blocking(load_in).await
}

#[tauri::command]
pub async fn bot_routine_save(routine: Routine) -> Result<Routine, String> {
    blocking(move |root| routine_save_in(root, routine)).await
}

#[tauri::command]
pub async fn bot_routine_delete(id: String) -> Result<bool, String> {
    blocking(move |root| routine_delete_in(root, &id)).await
}

/// 认领一次计划触发；返回 None 表示已被（别的窗口）认领或任务已删除。
#[tauri::command]
pub async fn bot_routine_claim(id: String, slot_at: u64) -> Result<Option<Routine>, String> {
    blocking(move |root| routine_claim_in(root, &id, slot_at)).await
}

#[tauri::command]
pub async fn bot_routine_finish(
    id: String,
    status: String,
    error: Option<String>,
) -> Result<Option<Routine>, String> {
    blocking(move |root| routine_finish_in(root, &id, &status, error)).await
}

#[tauri::command]
pub async fn bot_routine_runs(routine_id: String) -> Result<Vec<RoutineRun>, String> {
    blocking(move |root| runs_in(root, &routine_id)).await
}

#[tauri::command]
pub async fn bot_routine_run_save(run: RoutineRun) -> Result<(), String> {
    blocking(move |root| run_save_in(root, run)).await
}

#[tauri::command]
pub async fn bot_group_save(group: BotGroup) -> Result<BotGroup, String> {
    blocking(move |root| group_save_in(root, group)).await
}

#[tauri::command]
pub async fn bot_group_delete(id: String) -> Result<bool, String> {
    blocking(move |root| group_delete_in(root, &id)).await
}

#[tauri::command]
pub async fn bot_group_messages(group_id: String) -> Result<Vec<GroupMessage>, String> {
    blocking(move |root| messages_in(root, &group_id)).await
}

#[tauri::command]
pub async fn bot_group_messages_append(
    group_id: String,
    messages: Vec<GroupMessage>,
) -> Result<(), String> {
    blocking(move |root| messages_append_in(root, &group_id, messages)).await
}

#[tauri::command]
pub async fn bot_group_messages_clear(group_id: String) -> Result<(), String> {
    blocking(move |root| messages_clear_in(root, &group_id)).await
}

// --------------------------------------------------------- agent turns ---

fn owns_run_id(run_id: &str) -> bool {
    run_id.starts_with(RUN_ID_PREFIX)
}

/// 一次后台轮次的启动方案：由 Bot 权限与引擎决定。
#[derive(Debug, PartialEq)]
struct TurnPlan {
    permission: Option<String>,
    allowed_tools: Option<Vec<String>>,
    /// 能否续接会话。Codex 只读档每次都是新线程。
    resumable: bool,
    /// 是否挂 Bot 的记忆工具。只读（ask）轮次不写任何东西，记忆也不挂。
    memory: bool,
}

/// Bot 权限 → 启动方案（fail-closed）：
///   ask       → claude 等支持白名单的引擎：只读白名单；codex：经审计的只读档
///               （不续接）；其余引擎由 prepare_launch 拒绝（不降级）
///   auto-safe → 引擎 auto 档
///   full      → 引擎 bypass 档
fn plan_for(mode: &str, engine: &str) -> Result<TurnPlan, String> {
    match mode {
        "" | "ask" if engine == "codex" => Ok(TurnPlan {
            permission: Some(engine::codex_read_only_permission().to_string()),
            allowed_tools: None,
            resumable: false,
            memory: false,
        }),
        "" | "ask" => Ok(TurnPlan {
            permission: None,
            allowed_tools: Some(READ_ONLY_TOOLS.iter().map(|t| t.to_string()).collect()),
            resumable: true,
            memory: false,
        }),
        "auto-safe" => Ok(TurnPlan {
            permission: Some("auto".into()),
            allowed_tools: None,
            resumable: true,
            memory: true,
        }),
        "full" => Ok(TurnPlan {
            permission: Some("bypass".into()),
            allowed_tools: None,
            resumable: true,
            memory: true,
        }),
        other => Err(format!("Unknown permission mode: {other}")),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotTurnStarted {
    pub run_id: String,
    pub session_id: Option<String>,
    /// 前端据此决定是否记住会话 id、下次是否还要带 Bot 提示词块。
    pub resumable: bool,
    /// 这一轮是否挂了记忆工具（提示词里的记忆说明要与之一致）。
    pub memory: bool,
}

/// 一个 Bot 后台轮次的参数（定时任务或群聊成员）。
#[derive(Debug, Clone)]
pub struct BotTurnRequest {
    pub run_id: String,
    pub engine: String,
    pub workspace_path: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub provider_id: Option<String>,
    /// Bot 的权限设置："ask" | "auto-safe" | "full"。
    pub permission_mode: String,
    pub memory_bot: Option<String>,
}

/// 启动一个 Bot 后台轮次。只依赖 AppState（命令与集成测试共用，测试用
/// MockRuntime 构造 state，不经过 Wry 的 AppHandle）。
pub async fn start_bot_turn(
    state: &crate::AppState,
    req: BotTurnRequest,
) -> Result<BotTurnStarted, String> {
    let BotTurnRequest {
        run_id,
        engine,
        workspace_path,
        session_id,
        prompt,
        model,
        provider_id,
        permission_mode,
        memory_bot,
    } = req;
    if !owns_run_id(&run_id) || run_id.starts_with(PARSE_RUN_ID_PREFIX) {
        return Err(format!("run id {run_id:?} is not a bot team run id"));
    }
    if prompt.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("prompt is too long".into());
    }
    if workspace_path.trim().is_empty() || !Path::new(&workspace_path).is_dir() {
        return Err(format!("working directory does not exist: {workspace_path}"));
    }
    let plan = plan_for(&permission_mode, &engine)?;
    let session_id = session_id
        .filter(|s| !s.trim().is_empty())
        .filter(|_| plan.resumable);
    let memory_bot = memory_bot
        .filter(|b| !b.trim().is_empty())
        .filter(|_| plan.memory);
    let memory = memory_bot.is_some();
    let result = engine::bot_team_agent_send(
        state,
        engine,
        workspace_path,
        session_id,
        prompt,
        model.filter(|m| !m.trim().is_empty()),
        plan.permission,
        provider_id.filter(|p| !p.trim().is_empty()),
        run_id,
        memory_bot,
        plan.allowed_tools,
    )
    .await?;
    Ok(BotTurnStarted {
        run_id: result.run_id,
        session_id: result.session_id,
        resumable: plan.resumable,
        memory,
    })
}

/// 启动一个 Bot 后台轮次（定时任务或群聊成员）。前端先注册事件监听再
/// invoke；run id 必须带 `botteam-` 前缀。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bot_agent_start(
    app: tauri::AppHandle,
    run_id: String,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    model: Option<String>,
    provider_id: Option<String>,
    permission_mode: String,
    memory_bot: Option<String>,
) -> Result<BotTurnStarted, String> {
    let state = app.state::<crate::AppState>();
    start_bot_turn(
        state.inner(),
        BotTurnRequest {
            run_id,
            engine,
            workspace_path,
            session_id,
            prompt,
            model,
            provider_id,
            permission_mode,
            memory_bot,
        },
    )
    .await
}

/// 空沙盒目录：一句话解析定时任务用，不落在任何工作区。
fn parse_sandbox_dir() -> Result<PathBuf, String> {
    let dir = team_dir().join("parse-sandbox");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create parse sandbox: {e}"))?;
    Ok(dir)
}

/// 零工具纯文本轮次：把用户的一句话解析成定时任务草稿（JSON）。
pub async fn start_parse_turn(
    state: &crate::AppState,
    run_id: String,
    engine: String,
    prompt: String,
    model: Option<String>,
    provider_id: Option<String>,
) -> Result<engine::SendResult, String> {
    if !run_id.starts_with(PARSE_RUN_ID_PREFIX) {
        return Err(format!("run id {run_id:?} is not a bot team parse run id"));
    }
    if prompt.trim().is_empty() || prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("prompt is empty or too long".into());
    }
    let workspace = parse_sandbox_dir()?;
    engine::translate_text_send(
        state,
        engine,
        workspace.to_string_lossy().into_owned(),
        prompt,
        model.filter(|m| !m.trim().is_empty()),
        None,
        provider_id.filter(|p| !p.trim().is_empty()),
        run_id,
    )
    .await
}

#[tauri::command]
pub async fn bot_team_parse_start(
    app: tauri::AppHandle,
    run_id: String,
    engine: String,
    prompt: String,
    model: Option<String>,
    provider_id: Option<String>,
) -> Result<engine::SendResult, String> {
    let state = app.state::<crate::AppState>();
    start_parse_turn(state.inner(), run_id, engine, prompt, model, provider_id).await
}

/// 中断 Bot 团队的轮次；不接受聊天/插件/任务工作台/翻译的 run id。
#[tauri::command]
pub async fn bot_agent_interrupt(app: tauri::AppHandle, run_id: String) -> Result<bool, String> {
    if !owns_run_id(&run_id) {
        return Err(format!("run id {run_id:?} is not owned by bot team"));
    }
    let state = app.state::<crate::AppState>();
    let registry = std::sync::Arc::clone(&state.processes);
    tauri::async_runtime::spawn_blocking(move || registry.kill(&run_id))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- tests ---

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ccgui-bot-team-{name}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn routine(id: &str) -> Routine {
        Routine {
            id: id.into(),
            bot_id: "bot1".into(),
            name: "Daily digest".into(),
            prompt: "Summarize".into(),
            schedule: RoutineSchedule {
                kind: "daily".into(),
                every_minutes: None,
                time: Some("9:05".into()),
                weekdays: vec![],
            },
            engine: "claude".into(),
            workspace_path: "/tmp".into(),
            model: Some("  ".into()),
            provider_id: None,
            enabled: true,
            missed_policy: String::new(),
            created_at: 0,
            updated_at: 0,
            last_slot_at: None,
            last_run_at: None,
            last_status: None,
            last_error: None,
        }
    }

    fn group(id: &str, members: &[&str]) -> BotGroup {
        BotGroup {
            id: id.into(),
            name: "Team".into(),
            member_bot_ids: members.iter().map(|m| m.to_string()).collect(),
            engine: "claude".into(),
            workspace_path: "/tmp".into(),
            model: None,
            provider_id: None,
            max_rounds: 99,
            max_bot_messages_per_send: 0,
            member_sessions: Default::default(),
            needs_user: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn save_normalizes_and_round_trips() {
        let root = TempRoot::new("save");
        let saved = routine_save_in(&root.0, routine("r1")).unwrap();
        assert_eq!(saved.schedule.time.as_deref(), Some("09:05"));
        assert_eq!(saved.missed_policy, "run_once");
        assert_eq!(saved.model, None);
        assert!(saved.last_slot_at.is_some(), "new routines start from now");
        let state = load_in(&root.0).unwrap();
        assert_eq!(state.routines, vec![saved]);
    }

    #[test]
    fn schedule_validation() {
        let mut r = routine("r1");
        r.schedule = RoutineSchedule {
            kind: "interval".into(),
            every_minutes: Some(1),
            time: None,
            weekdays: vec![],
        };
        assert!(validate_routine(&r).is_err(), "too frequent");
        r.schedule.every_minutes = Some(30);
        assert!(validate_routine(&r).is_ok());
        r.schedule = RoutineSchedule {
            kind: "weekly".into(),
            every_minutes: None,
            time: Some("25:00".into()),
            weekdays: vec![1],
        };
        assert!(validate_routine(&r).is_err(), "bad time");
        r.schedule.time = Some("08:00".into());
        r.schedule.weekdays = vec![];
        assert!(validate_routine(&r).is_err(), "no weekday");
        r.schedule.weekdays = vec![5, 1, 5];
        assert_eq!(validate_routine(&r).unwrap().schedule.weekdays, vec![1, 5]);
        r.schedule.weekdays = vec![7];
        assert!(validate_routine(&r).is_err());
    }

    #[test]
    fn ids_cannot_escape_the_store() {
        let root = TempRoot::new("ids");
        let mut r = routine("../evil");
        assert!(routine_save_in(&root.0, r.clone()).is_err());
        r.id = "ok".into();
        r.bot_id = "a/b".into();
        assert!(routine_save_in(&root.0, r).is_err());
        assert!(runs_in(&root.0, "..").is_err());
        assert!(messages_in(&root.0, "x\\y").is_err());
    }

    #[test]
    fn claim_is_compare_and_set() {
        let root = TempRoot::new("claim");
        let saved = routine_save_in(&root.0, routine("r1")).unwrap();
        let start = saved.last_slot_at.unwrap();
        assert!(routine_claim_in(&root.0, "r1", start).unwrap().is_none(), "same slot");
        let claimed = routine_claim_in(&root.0, "r1", start + 1).unwrap().unwrap();
        assert_eq!(claimed.last_slot_at, Some(start + 1));
        assert!(routine_claim_in(&root.0, "r1", start + 1).unwrap().is_none(), "second window loses");
        assert!(routine_claim_in(&root.0, "missing", start + 5).unwrap().is_none());
    }

    #[test]
    fn edits_keep_scheduler_state() {
        let root = TempRoot::new("edit");
        let saved = routine_save_in(&root.0, routine("r1")).unwrap();
        let slot = saved.last_slot_at.unwrap() + 10;
        routine_claim_in(&root.0, "r1", slot).unwrap().unwrap();
        routine_finish_in(&root.0, "r1", "error", Some("boom".into())).unwrap();
        let mut edit = saved.clone();
        edit.name = "Renamed".into();
        edit.last_slot_at = Some(0);
        edit.last_status = None;
        let updated = routine_save_in(&root.0, edit).unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.last_slot_at, Some(slot));
        assert_eq!(updated.last_status.as_deref(), Some("error"));
        assert_eq!(updated.last_error.as_deref(), Some("boom"));
        assert!(routine_finish_in(&root.0, "r1", "weird", None).is_err());
    }

    #[test]
    fn runs_are_capped_and_upserted() {
        let root = TempRoot::new("runs");
        for i in 0..(RUNS_KEPT + 5) {
            run_save_in(
                &root.0,
                RoutineRun {
                    id: format!("run{i}"),
                    routine_id: "r1".into(),
                    bot_id: "bot1".into(),
                    trigger: "manual".into(),
                    started_at: i as u64,
                    finished_at: None,
                    status: "running".into(),
                    output: String::new(),
                    error: None,
                    session_id: None,
                },
            )
            .unwrap();
        }
        let mut runs = runs_in(&root.0, "r1").unwrap();
        assert_eq!(runs.len(), RUNS_KEPT);
        assert_eq!(runs[0].id, "run5", "oldest dropped");
        let mut last = runs.pop().unwrap();
        last.status = "ok".into();
        run_save_in(&root.0, last.clone()).unwrap();
        let runs = runs_in(&root.0, "r1").unwrap();
        assert_eq!(runs.len(), RUNS_KEPT);
        assert_eq!(runs.last().unwrap().status, "ok");
    }

    #[test]
    fn delete_removes_routine_and_its_runs() {
        let root = TempRoot::new("delete");
        routine_save_in(&root.0, routine("r1")).unwrap();
        assert!(routine_delete_in(&root.0, "r1").unwrap());
        assert!(!routine_delete_in(&root.0, "r1").unwrap());
        assert!(load_in(&root.0).unwrap().routines.is_empty());
    }

    #[test]
    fn groups_validate_members_and_clamp_limits() {
        let root = TempRoot::new("groups");
        assert!(group_save_in(&root.0, group("g1", &["a"])).is_err(), "one member");
        assert!(
            group_save_in(&root.0, group("g1", &["a", "b", "c", "d", "e", "f", "g"])).is_err(),
            "seven members"
        );
        let mut g = group("g1", &["a", "b", "a"]);
        g.member_sessions.insert("a".into(), "s-a".into());
        g.member_sessions.insert("gone".into(), "s-x".into());
        let saved = group_save_in(&root.0, g).unwrap();
        assert_eq!(saved.member_bot_ids, vec!["a", "b"]);
        assert_eq!(saved.max_rounds, 10);
        assert_eq!(saved.max_bot_messages_per_send, 1);
        assert_eq!(saved.member_sessions.len(), 1);
        assert!(group_delete_in(&root.0, "g1").unwrap());
    }

    #[test]
    fn messages_append_upsert_and_scope() {
        let root = TempRoot::new("messages");
        let msg = |id: &str, group: &str, text: &str| GroupMessage {
            id: id.into(),
            group_id: group.into(),
            author: "user".into(),
            text: text.into(),
            created_at: 1,
            status: None,
        };
        messages_append_in(&root.0, "g1", vec![msg("m1", "g1", "hi"), msg("m2", "g1", "yo")]).unwrap();
        messages_append_in(&root.0, "g1", vec![msg("m2", "g1", "edited")]).unwrap();
        let messages = messages_in(&root.0, "g1").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].text, "edited");
        assert!(messages_append_in(&root.0, "g1", vec![msg("m3", "g2", "x")]).is_err());
        messages_clear_in(&root.0, "g1").unwrap();
        assert!(messages_in(&root.0, "g1").unwrap().is_empty());
        messages_clear_in(&root.0, "g1").unwrap();
    }

    #[test]
    fn permission_mapping_fails_closed() {
        let ask = plan_for("ask", "claude").unwrap();
        assert_eq!(ask.permission, None);
        assert_eq!(ask.allowed_tools.unwrap(), READ_ONLY_TOOLS);
        assert!(ask.resumable);
        assert!(!ask.memory, "read-only runs never mount the memory writer");

        let codex = plan_for("", "codex").unwrap();
        assert_eq!(codex.permission.as_deref(), Some(engine::codex_read_only_permission()));
        assert_eq!(codex.allowed_tools, None);
        assert!(!codex.resumable && !codex.memory);

        let auto = plan_for("auto-safe", "codex").unwrap();
        assert_eq!(auto.permission.as_deref(), Some("auto"));
        assert!(auto.resumable && auto.memory);
        assert_eq!(plan_for("full", "claude").unwrap().permission.as_deref(), Some("bypass"));
        assert!(plan_for("root", "claude").is_err());
    }

    #[test]
    fn run_id_ownership() {
        assert!(owns_run_id("botteam-abc"));
        assert!(!owns_run_id("mission-abc"));
        assert!(!owns_run_id("translate-abc"));
    }
}
