use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::errors::AppError;
use crate::prompt::PromptSubmission;
use crate::protocol::{
    AppNotice, ClientConfig, ConnectionStatus, PromptSubmissionResult, SessionSnapshot,
    SessionSummary,
};
use crate::state::AppState;

const SESSION_ID_LIMIT: usize = 128;
const PROMPT_TEXT_LIMIT: usize = 200_000;
const CONFIG_FIELD_LIMIT: usize = 4_096;
const CLIPBOARD_TEXT_LIMIT: usize = 2_000_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityResponse {
    pub node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptPayload {
    session_id: String,
    text: String,
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), AppError> {
    ensure_main_window_label(window.label())
}

fn ensure_main_window_label(label: &str) -> Result<(), AppError> {
    if label == "main" {
        Ok(())
    } else {
        Err(AppError::configuration(
            "The IPC request did not come from the application window.",
        ))
    }
}

fn require_length(
    value: &str,
    field: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), AppError> {
    let length = value.chars().count();
    if length < minimum || length > maximum {
        return Err(AppError::configuration(format!(
            "Invalid request: {field} must be between {minimum} and {maximum} characters."
        )));
    }
    Ok(())
}

fn parse_config(value: Value) -> Result<ClientConfig, AppError> {
    let object = value.as_object().ok_or_else(|| {
        AppError::configuration("Invalid request on config:save: payload must be an object.")
    })?;

    for key in object.keys() {
        if !["serverTicket", "serverNodeId", "relayUrl"].contains(&key.as_str()) {
            return Err(AppError::configuration(format!(
                "Invalid request on config:save: unknown field `{key}`"
            )));
        }
    }

    let server_ticket = read_required_nullable(object, "serverTicket")?;
    let server_node_id = read_required_nullable(object, "serverNodeId")?;
    let relay_url = read_required_nullable(object, "relayUrl")?;

    for (field, value) in [
        ("serverTicket", server_ticket.as_deref()),
        ("serverNodeId", server_node_id.as_deref()),
        ("relayUrl", relay_url.as_deref()),
    ] {
        if let Some(value) = value {
            require_length(value, field, 0, CONFIG_FIELD_LIMIT)?;
        }
    }

    Ok(ClientConfig {
        server_ticket,
        server_node_id,
        relay_url,
    })
}

fn read_required_nullable(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<String>, AppError> {
    match object.get(field) {
        None => Err(AppError::configuration(format!(
            "Invalid request on config:save: missing field `{field}`"
        ))),
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(AppError::configuration(format!(
            "Invalid request on config:save: field `{field}` must be a string or null"
        ))),
    }
}

fn parse_session_id(value: Value) -> Result<String, AppError> {
    let session_id = value.as_str().ok_or_else(|| {
        AppError::configuration("Invalid request: the session id must be a string.")
    })?;
    require_length(session_id, "sessionId", 1, SESSION_ID_LIMIT)?;
    Ok(session_id.to_owned())
}

fn parse_prompt(value: Value) -> Result<PromptSubmission, AppError> {
    let payload: PromptPayload = serde_json::from_value(value).map_err(|error| {
        AppError::configuration(format!("Invalid request on prompt:send: {error}"))
    })?;
    require_length(&payload.session_id, "sessionId", 1, SESSION_ID_LIMIT)?;
    require_length(&payload.text, "text", 1, PROMPT_TEXT_LIMIT)?;
    Ok(PromptSubmission {
        session_id: payload.session_id,
        text: payload.text,
    })
}

fn parse_clipboard_text(value: Value) -> Result<String, AppError> {
    let text = value.as_str().ok_or_else(|| {
        AppError::configuration("Invalid request: the clipboard text must be a string.")
    })?;
    require_length(text, "text", 0, CLIPBOARD_TEXT_LIMIT)?;
    Ok(text.to_owned())
}

#[tauri::command]
pub async fn identity_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<IdentityResponse, AppError> {
    ensure_main_window(&window)?;
    Ok(IdentityResponse {
        node_id: state.node_id.clone(),
    })
}

#[tauri::command]
pub async fn config_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ClientConfig, AppError> {
    ensure_main_window(&window)?;
    Ok(state.config())
}

#[tauri::command]
pub async fn config_save(
    window: WebviewWindow,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<ClientConfig, AppError> {
    ensure_main_window(&window)?;
    let config = parse_config(payload)?;

    let (previous, saved) = {
        let mut store = state
            .config_store
            .write()
            .map_err(|_| AppError::internal("The configuration lock is unavailable."))?;
        let previous = store.get_cached();
        let saved = store.save(config)?;
        (previous, saved)
    };

    if previous.server_ticket != saved.server_ticket
        || previous.server_node_id != saved.server_node_id
        || previous.relay_url != saved.relay_url
    {
        state.client.disconnect().await;
    }

    Ok(saved)
}

#[tauri::command]
pub async fn connection_status(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, AppError> {
    ensure_main_window(&window)?;
    Ok(state.client.get_status())
}

#[tauri::command]
pub async fn connection_connect(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, AppError> {
    ensure_main_window(&window)?;
    Ok(state.client.connect().await)
}

#[tauri::command]
pub async fn connection_disconnect(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    ensure_main_window(&window)?;
    state.client.disconnect().await;
    Ok(())
}

#[tauri::command]
pub async fn sessions_list(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, AppError> {
    ensure_main_window(&window)?;
    Ok(state.sessions.list().await)
}

#[tauri::command]
pub async fn sessions_create(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<SessionSummary, AppError> {
    ensure_main_window(&window)?;
    state.sessions.create().await
}

#[tauri::command]
pub async fn sessions_activate(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: Value,
) -> Result<SessionSnapshot, AppError> {
    ensure_main_window(&window)?;
    let session_id = parse_session_id(session_id)?;
    state.sessions.activate(&session_id).await
}

#[tauri::command]
pub async fn sessions_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
    session_id: Value,
) -> Result<SessionSnapshot, AppError> {
    ensure_main_window(&window)?;
    let session_id = parse_session_id(session_id)?;
    state.sessions.get_snapshot(&session_id).await
}

#[tauri::command]
pub async fn sessions_get_active(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<SessionSnapshot, AppError> {
    ensure_main_window(&window)?;
    state.sessions.get_active_snapshot().await
}

#[tauri::command]
pub async fn prompt_send(
    window: WebviewWindow,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<PromptSubmissionResult, AppError> {
    ensure_main_window(&window)?;
    let input = parse_prompt(payload)?;
    state.coordinator.send_prompt(input).await
}

#[tauri::command]
pub async fn prompt_cancel(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<bool, AppError> {
    ensure_main_window(&window)?;
    Ok(state.coordinator.cancel_prompt().await)
}

#[tauri::command]
pub async fn clipboard_write(
    window: WebviewWindow,
    state: State<'_, AppState>,
    text: Value,
) -> Result<(), AppError> {
    ensure_main_window(&window)?;
    let text = parse_clipboard_text(text)?;
    state.app.clipboard().write_text(text).map_err(|error| {
        AppError::internal(format!("The clipboard could not be updated. ({error})"))
    })
}

#[tauri::command]
pub async fn notices_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<AppNotice>, AppError> {
    ensure_main_window(&window)?;
    Ok(state
        .notices
        .iter()
        .map(|message| AppNotice::warning(message.clone()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorCode;
    use serde_json::json;

    #[test]
    fn parses_a_valid_configuration() {
        let config = parse_config(json!({
            "serverTicket": "ticket",
            "serverNodeId": null,
            "relayUrl": null
        }))
        .expect("config");
        assert_eq!(config.server_ticket.as_deref(), Some("ticket"));
    }

    #[test]
    fn rejects_unknown_configuration_fields() {
        let error = parse_config(json!({
            "serverTicket": "ticket",
            "serverNodeId": null,
            "relayUrl": null,
            "extra": true
        }))
        .expect_err("unknown field");
        assert_eq!(error.code, ErrorCode::Configuration);
    }

    #[test]
    fn rejects_missing_configuration_fields() {
        let error = parse_config(json!({ "serverTicket": "ticket" })).expect_err("missing");
        assert_eq!(error.code, ErrorCode::Configuration);
    }

    #[test]
    fn rejects_oversized_configuration_fields() {
        let error = parse_config(json!({
            "serverTicket": "x".repeat(CONFIG_FIELD_LIMIT + 1),
            "serverNodeId": null,
            "relayUrl": null
        }))
        .expect_err("oversized");
        assert_eq!(error.code, ErrorCode::Configuration);
    }

    #[test]
    fn rejects_a_malformed_prompt() {
        assert_eq!(
            parse_prompt(json!({ "sessionId": "session-1" }))
                .expect_err("missing text")
                .code,
            ErrorCode::Configuration
        );
        assert_eq!(
            parse_prompt(json!({ "sessionId": "session-1", "text": 5 }))
                .expect_err("wrong text type")
                .code,
            ErrorCode::Configuration
        );
    }

    #[test]
    fn rejects_oversized_prompt_fields() {
        assert_eq!(
            parse_prompt(json!({ "sessionId": "x".repeat(SESSION_ID_LIMIT + 1), "text": "hi" }))
                .expect_err("oversized session")
                .code,
            ErrorCode::Configuration
        );
        assert_eq!(
            parse_prompt(json!({
                "sessionId": "session-1",
                "text": "x".repeat(PROMPT_TEXT_LIMIT + 1)
            }))
            .expect_err("oversized prompt")
            .code,
            ErrorCode::Configuration
        );
    }

    #[test]
    fn rejects_a_non_string_session_id() {
        let error = parse_session_id(json!(42)).expect_err("invalid session id");
        assert_eq!(error.code, ErrorCode::Configuration);
    }

    #[test]
    fn rejects_non_string_clipboard_values() {
        let error = parse_clipboard_text(json!({ "text": "no" })).expect_err("invalid clipboard");
        assert_eq!(error.code, ErrorCode::Configuration);
    }

    #[test]
    fn accepts_only_the_main_window_as_a_caller() {
        ensure_main_window_label("main").expect("main window");

        let error = ensure_main_window_label("secondary").expect_err("other window");
        assert_eq!(error.code, ErrorCode::Configuration);
        assert!(error
            .message
            .contains("did not come from the application window"));
    }

    #[test]
    fn parses_a_clipboard_text_within_the_limit() {
        assert_eq!(
            parse_clipboard_text(json!("copy me")).expect("clipboard text"),
            "copy me"
        );
        assert_eq!(
            parse_clipboard_text(json!(null))
                .expect_err("non-string clipboard")
                .code,
            ErrorCode::Configuration
        );
    }

    #[test]
    fn parses_and_validates_session_ids() {
        assert_eq!(
            parse_session_id(json!("session-1")).expect("session id"),
            "session-1"
        );
        assert_eq!(
            parse_session_id(json!(""))
                .expect_err("empty session id")
                .code,
            ErrorCode::Configuration
        );
    }
}
