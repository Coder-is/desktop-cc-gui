//! ccpl 账号：在桌面端注册 / 登录自建的 ccpl 号池，拿到名下的 `sk-ccpl-…` 令牌，
//! 或直接粘贴已申请的令牌（先用 `GET /v1/me` 验证），
//! 再查这个令牌的每日额度和用量（`GET /v1/me`）。
//! 一个令牌只属于 ccpl 的一个分组，登录时顺带认出分组类型，页面只写这个引擎的渠道。
//!
//! 只做用户在「设置 → ccpl 账号」里主动点的事：不在挂载、聚焦或定时器里发请求。
//! 账号（服务器地址、用户名、令牌）存在 `<app_home>/ccpl-account.json`；
//! 这些命令只注册给桌面窗口，不进网页访问的命令分发（web/dispatch.rs），
//! 手机端看不到也调不到。

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const ACCOUNT_FILE: &str = "ccpl-account.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAccount {
    base_url: String,
    username: String,
    token: String,
    /// 写渠道时令牌所在分组的类型（见 [`provider_from_status`]）；空串表示没认出来。
    #[serde(default)]
    provider: String,
}

/// 给页面看的账号状态：不带令牌原文，只带头尾提示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcplAccountStatus {
    signed_in: bool,
    base_url: String,
    username: String,
    token_hint: String,
    /// 上次写渠道时令牌所在分组的类型，页面拿它和 `/v1/me` 里的现值比，发现分组被改了就提示重新登录。
    provider: String,
}

/// 登录 / 注册成功后返回：令牌原文只在这一次交给页面，用来写入它能用的那个引擎的渠道。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcplSession {
    base_url: String,
    username: String,
    token: String,
    quota_pending: bool,
    /// 令牌所在分组的类型：`anthropic` / `codex` / `grok` / `antigravity`，认不出时为空串。
    provider: String,
}

/// ccpl 一个令牌只属于一个分组，分组类型决定它能接哪个引擎。
const KNOWN_PROVIDERS: [&str; 4] = ["anthropic", "codex", "grok", "antigravity"];

/// 新版 ccpl 在登录、注册和 `/v1/me` 的回复里直接带 `provider`。
fn provider_from_status(reply: &Value) -> Option<String> {
    let provider = reply.get("provider")?.as_str()?.trim();
    KNOWN_PROVIDERS.contains(&provider).then(|| provider.to_string())
}

/// 旧版 ccpl 没有 `provider` 字段：`GET /v1/models` 按令牌所在分组列模型，
/// `owned_by` 是分组类型的固定映射（anthropic / openai / xai / google）。列表为空认不出。
fn provider_from_models(models: &Value) -> Option<String> {
    let owner = models.pointer("/data/0/owned_by")?.as_str()?;
    let provider = match owner {
        "anthropic" => "anthropic",
        "openai" => "codex",
        "xai" => "grok",
        "google" => "antigravity",
        _ => return None,
    };
    Some(provider.to_string())
}

/// 认令牌所在分组的类型：先看回复里的 `provider`，没有再查一次 `/v1/models`
/// （只读、不过客户端门禁）。查不到不算登录失败，返回空串让页面按旧办法写全部渠道。
async fn detect_provider(base: &str, token: &str, reply: &Value) -> String {
    if let Some(provider) = provider_from_status(reply) {
        return provider;
    }
    let Ok(http) = client() else { return String::new() };
    match send(http.get(format!("{base}/v1/models")).bearer_auth(token)).await {
        Ok(models) => provider_from_models(&models).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

fn account_path() -> PathBuf {
    crate::paths::app_home().join(ACCOUNT_FILE)
}

fn read_account() -> Option<StoredAccount> {
    let raw = std::fs::read_to_string(account_path()).ok()?;
    let account: StoredAccount = serde_json::from_str(&raw).ok()?;
    if account.token.trim().is_empty() {
        return None;
    }
    Some(account)
}

fn write_account(account: &StoredAccount) -> Result<(), String> {
    let path = account_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create app home: {e}"))?;
    }
    let body = serde_json::to_vec_pretty(account).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("write account: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("write account: {e}"))
}

fn token_hint(token: &str) -> String {
    let t = token.trim();
    if t.len() <= 12 || !t.is_ascii() {
        return "****".to_string();
    }
    format!("{}…{}", &t[..8], &t[t.len() - 4..])
}

/// 规整服务器地址：只收 http(s)，去掉末尾的 `/` 和误填的 `/v1`。
/// 明文 http 只允许本机地址，免得密码和令牌在网络上裸奔。
fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed).trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed).map_err(|_| "invalid_url".to_string())?;
    match url.scheme() {
        "https" => {}
        "http" => {
            let local = matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
            );
            if !local {
                return Err("insecure_url".to_string());
            }
        }
        _ => return Err("invalid_url".to_string()),
    }
    if url.host_str().is_none() {
        return Err("invalid_url".to_string());
    }
    Ok(trimmed.to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

/// 把 ccpl 的错误响应转成页面能解析的 JSON 字符串：
/// `{"status":401,"message":"…","captchaRequired":true,"retryAfter":60}`。
fn error_text(status: u16, body: &Value) -> String {
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    serde_json::json!({
        "status": status,
        "message": message,
        "captchaRequired": body.get("captchaRequired").and_then(Value::as_bool).unwrap_or(false),
        "retryAfter": body.get("retryAfter").and_then(Value::as_u64),
    })
    .to_string()
}

fn network_error(e: reqwest::Error) -> String {
    serde_json::json!({ "status": 0, "message": "", "network": e.to_string() }).to_string()
}

async fn send(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(network_error)?;
    let status = response.status();
    let text = response.text().await.map_err(network_error)?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    // 404：这个服务器没有该接口（ccpl 对未知路径回 `{"error":{"message":"未知路径"}}`），
    // 和下面的非 JSON 回复同一类问题，统一报「不是 ccpl 账号接口」。
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(not_ccpl_api(404));
    }
    if !status.is_success() {
        return Err(error_text(status.as_u16(), &body));
    }
    // 2xx 但不是 JSON 对象：多半是地址指到了网页前端（SPA 对未知路径回 index.html），
    // 或服务器版本没有这个接口。当成功交出 null 会让页面读字段时崩掉，这里明确报错。
    if !body.is_object() {
        return Err(not_ccpl_api(status.as_u16()));
    }
    Ok(body)
}

fn not_ccpl_api(status: u16) -> String {
    serde_json::json!({ "status": status, "message": "not_ccpl_api" }).to_string()
}

#[tauri::command]
pub fn ccpl_account_status() -> CcplAccountStatus {
    match read_account() {
        Some(a) => CcplAccountStatus {
            signed_in: true,
            token_hint: token_hint(&a.token),
            base_url: a.base_url,
            username: a.username,
            provider: a.provider,
        },
        None => CcplAccountStatus {
            signed_in: false,
            base_url: String::new(),
            username: String::new(),
            token_hint: String::new(),
            provider: String::new(),
        },
    }
}

/// 服务器是否开放注册、要不要邀请码。
#[tauri::command]
pub async fn ccpl_server_info(base_url: String) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    send(client()?.get(format!("{base}/client/api/config"))).await
}

/// 取一张验证码图片（data URL）和它的编号。
#[tauri::command]
pub async fn ccpl_captcha(base_url: String) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    send(client()?.get(format!("{base}/admin/api/captcha"))).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcplCredentials {
    base_url: String,
    username: String,
    password: String,
    #[serde(default)]
    invite_code: String,
    #[serde(default)]
    captcha_id: String,
    #[serde(default)]
    captcha_code: String,
}

async fn sign_in(path: &str, form: CcplCredentials) -> Result<CcplSession, String> {
    let base = normalize_base_url(&form.base_url)?;
    let body = serde_json::json!({
        "username": form.username.trim(),
        "password": form.password,
        "inviteCode": form.invite_code.trim(),
        "captchaId": form.captcha_id,
        "captchaCode": form.captcha_code.trim(),
    });
    let reply = send(client()?.post(format!("{base}{path}")).json(&body)).await?;
    let token = reply.get("token").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !token.starts_with("sk-") {
        return Err(error_text(502, &Value::Null));
    }
    let username = reply
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or(form.username.trim())
        .to_string();
    let provider = detect_provider(&base, &token, &reply).await;
    write_account(&StoredAccount {
        base_url: base.clone(),
        username: username.clone(),
        token: token.clone(),
        provider: provider.clone(),
    })?;
    Ok(CcplSession {
        base_url: base,
        username,
        token,
        quota_pending: reply.get("quotaPending").and_then(Value::as_bool).unwrap_or(false),
        provider,
    })
}

#[tauri::command]
pub async fn ccpl_register(form: CcplCredentials) -> Result<CcplSession, String> {
    sign_in("/client/api/register", form).await
}

#[tauri::command]
pub async fn ccpl_login(form: CcplCredentials) -> Result<CcplSession, String> {
    sign_in("/client/api/login", form).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CcplTokenForm {
    base_url: String,
    token: String,
}

/// 令牌格式检查：ccpl 发的令牌都是 `sk-` 开头，且不能夹空白（多半是粘贴错了）。
fn validate_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();
    if !token.starts_with("sk-") || token.len() <= 3 || token.chars().any(char::is_whitespace) {
        return Err("invalid_token".to_string());
    }
    Ok(token.to_string())
}

/// `/v1/me` 的回复里取账号名：优先 username，其次令牌备注 label，都没有就留空。
fn username_from_me(me: &Value) -> String {
    ["username", "label"]
        .iter()
        .find_map(|key| {
            me.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("")
        .to_string()
}

/// 用已有令牌登录（例如在 ccpl 网页端申请的令牌）：先拿它查一次 `GET /v1/me`，
/// 服务器认这个令牌才保存账号，再把令牌交给页面写入渠道。无效令牌原样报错，不落盘。
#[tauri::command]
pub async fn ccpl_token_login(form: CcplTokenForm) -> Result<CcplSession, String> {
    let base = normalize_base_url(&form.base_url)?;
    let token = validate_token(&form.token)?;
    let me = send(
        client()?
            .get(format!("{base}/v1/me?range=24h"))
            .bearer_auth(&token),
    )
    .await?;
    let username = username_from_me(&me);
    let provider = detect_provider(&base, &token, &me).await;
    write_account(&StoredAccount {
        base_url: base.clone(),
        username: username.clone(),
        token: token.clone(),
        provider: provider.clone(),
    })?;
    Ok(CcplSession {
        base_url: base,
        username,
        token,
        quota_pending: me.get("quotaPending").and_then(Value::as_bool).unwrap_or(false),
        provider,
    })
}

/// 用保存的令牌查额度和用量。range 是 24h / 7d / 30d。
#[tauri::command]
pub async fn ccpl_me(range: Option<String>) -> Result<Value, String> {
    let account = read_account().ok_or_else(|| error_text(401, &Value::Null))?;
    let range = match range.as_deref() {
        Some("7d") => "7d",
        Some("30d") => "30d",
        _ => "24h",
    };
    send(
        client()?
            .get(format!("{}/v1/me?range={range}", account.base_url))
            .bearer_auth(&account.token),
    )
    .await
}

/// 用保存的令牌看完整用量排行（`GET /v1/ranking`）：每人的名次、名字和用量。range 是 today / 7d / 30d。
#[tauri::command]
pub async fn ccpl_ranking(range: Option<String>) -> Result<Value, String> {
    let account = read_account().ok_or_else(|| error_text(401, &Value::Null))?;
    let range = match range.as_deref() {
        Some("today") => "today",
        Some("30d") => "30d",
        _ => "7d",
    };
    send(
        client()?
            .get(format!("{}/v1/ranking?range={range}", account.base_url))
            .bearer_auth(&account.token),
    )
    .await
}

/// 用保存的令牌切号池（`POST /v1/me/pool`）：只能在 `/v1/me` 给出的 groups 里选，服务端会再校验。
/// 成功回令牌信息，其中 group 是切换后的号池。
#[tauri::command]
pub async fn ccpl_set_pool(group_id: String) -> Result<Value, String> {
    let account = read_account().ok_or_else(|| error_text(401, &Value::Null))?;
    let body = serde_json::json!({ "groupId": group_id });
    send(
        client()?
            .post(format!("{}/v1/me/pool", account.base_url))
            .bearer_auth(&account.token)
            .json(&body),
    )
    .await
}

/// 退出：只删本地保存的账号，已经写进渠道的令牌留着（用户可能还要用）。
#[tauri::command]
pub fn ccpl_logout() -> Result<(), String> {
    match std::fs::remove_file(account_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 账号页的用量统计（按 CLI × 模型），数据来自本机各 CLI 自己的会话日志
/// （usage_stats，只读、只在本地）。产品决定：没登录账号就不给看，所以这里先查登录态。
/// 只在用户打开 / 刷新账号页时调用，不启动插件那套后台定时扫描。
#[tauri::command]
pub async fn account_usage_query(
    app: tauri::AppHandle,
    query: crate::usage_stats::QueryRequest,
) -> Result<crate::usage_stats::QueryResponse, String> {
    if read_account().is_none() {
        return Err(error_text(401, &Value::Null));
    }
    crate::usage_stats::query_for_page(&app, query).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_normalized() {
        assert_eq!(normalize_base_url("https://cc.example.com:9443/").unwrap(), "https://cc.example.com:9443");
        assert_eq!(normalize_base_url("https://cc.example.com/v1/").unwrap(), "https://cc.example.com");
        assert_eq!(normalize_base_url("http://127.0.0.1:8787").unwrap(), "http://127.0.0.1:8787");
        assert_eq!(normalize_base_url("http://localhost:8787/v1").unwrap(), "http://localhost:8787");
    }

    #[test]
    fn plain_http_only_for_loopback() {
        assert_eq!(normalize_base_url("http://cc.example.com").unwrap_err(), "insecure_url");
        assert_eq!(normalize_base_url("ftp://cc.example.com").unwrap_err(), "invalid_url");
        assert_eq!(normalize_base_url("not a url").unwrap_err(), "invalid_url");
    }

    #[test]
    fn error_text_carries_captcha_hint() {
        let body = serde_json::json!({"error": {"message": "请输入验证码"}, "captchaRequired": true, "retryAfter": 30});
        let parsed: Value = serde_json::from_str(&error_text(401, &body)).unwrap();
        assert_eq!(parsed["status"], 401);
        assert_eq!(parsed["message"], "请输入验证码");
        assert_eq!(parsed["captchaRequired"], true);
        assert_eq!(parsed["retryAfter"], 30);
    }

    #[test]
    fn token_hint_hides_the_middle() {
        assert_eq!(token_hint("sk-ccpl-0123456789abcdef"), "sk-ccpl-…cdef");
        assert_eq!(token_hint("short"), "****");
    }

    #[test]
    fn non_api_reply_is_a_clear_error() {
        let parsed: Value = serde_json::from_str(&not_ccpl_api(200)).unwrap();
        assert_eq!(parsed["status"], 200);
        assert_eq!(parsed["message"], "not_ccpl_api");
    }

    #[test]
    fn token_must_look_like_a_ccpl_key() {
        assert_eq!(validate_token("  sk-ccpl-abc123 \n").unwrap(), "sk-ccpl-abc123");
        assert_eq!(validate_token("").unwrap_err(), "invalid_token");
        assert_eq!(validate_token("sk-").unwrap_err(), "invalid_token");
        assert_eq!(validate_token("abc123").unwrap_err(), "invalid_token");
        assert_eq!(validate_token("sk-ccpl abc").unwrap_err(), "invalid_token");
    }

    #[test]
    fn provider_comes_from_the_status_field_when_present() {
        assert_eq!(provider_from_status(&serde_json::json!({"provider": "codex"})).as_deref(), Some("codex"));
        assert_eq!(provider_from_status(&serde_json::json!({"provider": "something"})), None);
        assert_eq!(provider_from_status(&serde_json::json!({"hint": "sk-…"})), None);
    }

    #[test]
    fn provider_falls_back_to_model_owner() {
        let models = |owner: &str| serde_json::json!({"object": "list", "data": [{"id": "m", "owned_by": owner}]});
        assert_eq!(provider_from_models(&models("anthropic")).as_deref(), Some("anthropic"));
        assert_eq!(provider_from_models(&models("openai")).as_deref(), Some("codex"));
        assert_eq!(provider_from_models(&models("xai")).as_deref(), Some("grok"));
        assert_eq!(provider_from_models(&models("google")).as_deref(), Some("antigravity"));
        assert_eq!(provider_from_models(&models("meta")), None);
        assert_eq!(provider_from_models(&serde_json::json!({"object": "list", "data": []})), None);
    }

    #[test]
    fn old_account_file_without_provider_still_loads() {
        let account: StoredAccount =
            serde_json::from_str(r#"{"baseUrl":"https://cc.example.com","username":"a","token":"sk-x"}"#).unwrap();
        assert_eq!(account.provider, "");
    }

    #[test]
    fn username_prefers_account_name_then_label() {
        assert_eq!(username_from_me(&serde_json::json!({"username": "alice", "label": "laptop"})), "alice");
        assert_eq!(username_from_me(&serde_json::json!({"username": " ", "label": "laptop"})), "laptop");
        assert_eq!(username_from_me(&serde_json::json!({"hint": "sk-…"})), "");
    }
}
