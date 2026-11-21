//! ccpl 账号：在桌面端注册 / 登录自建的 ccpl 号池，拿到名下的 `sk-ccpl-…` 令牌，
//! 再查这个令牌的每日额度和用量（`GET /v1/me`）。
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
}

/// 给页面看的账号状态：不带令牌原文，只带头尾提示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcplAccountStatus {
    signed_in: bool,
    base_url: String,
    username: String,
    token_hint: String,
}

/// 登录 / 注册成功后返回：令牌原文只在这一次交给页面，用来写入 Claude / Codex / Grok 渠道。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcplSession {
    base_url: String,
    username: String,
    token: String,
    quota_pending: bool,
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
    if !status.is_success() {
        return Err(error_text(status.as_u16(), &body));
    }
    Ok(body)
}

#[tauri::command]
pub fn ccpl_account_status() -> CcplAccountStatus {
    match read_account() {
        Some(a) => CcplAccountStatus {
            signed_in: true,
            token_hint: token_hint(&a.token),
            base_url: a.base_url,
            username: a.username,
        },
        None => CcplAccountStatus {
            signed_in: false,
            base_url: String::new(),
            username: String::new(),
            token_hint: String::new(),
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
    write_account(&StoredAccount { base_url: base.clone(), username: username.clone(), token: token.clone() })?;
    Ok(CcplSession {
        base_url: base,
        username,
        token,
        quota_pending: reply.get("quotaPending").and_then(Value::as_bool).unwrap_or(false),
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

/// 退出：只删本地保存的账号，已经写进渠道的令牌留着（用户可能还要用）。
#[tauri::command]
pub fn ccpl_logout() -> Result<(), String> {
    match std::fs::remove_file(account_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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
}
