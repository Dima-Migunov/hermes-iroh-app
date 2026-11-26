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
use crate::storage::config::normalize_config;

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
pub struct PromptPayload {
    session_id: String,
    text: String,
}

/// A configuration field that must be present and is either a string or `null`.
/// The inner option holds the value; the outer flag records whether the key was present.
#[derive(Debug, Default)]
pub struct Present<T> {
    pub present: bool,
    pub value: Option<T>,
}

impl<'de, T> Deserialize<'de> for Present<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(|value| Present {
            present: true,
            value,
        })
    }
}

/// Typed configuration payload: every field must be present and is a string or null.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigPayload {
    #[serde(default)]
    server_ticket: Present<String>,
    #[serde(default)]
    server_node_id: Present<String>,
    #[serde(default)]
    relay_url: Present<String>,
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

fn parse_config(payload: ConfigPayload) -> Result<ClientConfig, AppError> {
    for (field, present) in [
        ("serverTicket", payload.server_ticket.present),
        ("serverNodeId", payload.server_node_id.present),
        ("relayUrl", payload.relay_url.present),
    ] {
        if !present {
            return Err(AppError::configuration(format!(
                "Invalid request on config:save: missing field `{field}`"
            )));
        }
    }

    let config = ClientConfig {
        server_ticket: payload.server_ticket.value,
        server_node_id: payload.server_node_id.value,
        relay_url: payload.relay_url.value,
    };

    // The ticket wins over a bare NodeId, exactly as on the disk path.
    let config = normalize_config(&config);

    for (field, value) in [
        ("serverTicket", config.server_ticket.as_deref()),
        ("serverNodeId", config.server_node_id.as_deref()),
        ("relayUrl", config.relay_url.as_deref()),
    ] {
        if let Some(value) = value {
            require_length(value, field, 0, CONFIG_FIELD_LIMIT)?;
        }
    }

    Ok(config)
}

fn parse_session_id(value: Value) -> Result<String, AppError> {
    let session_id = value.as_str().ok_or_else(|| {
        AppError::configuration("Invalid request: the session id must be a string.")
    })?;
    validate_session_id(session_id)?;
    Ok(session_id.to_owned())
}

/// A session id becomes a file name, so it must stay inside the history directory and
/// resolve to a single component on every supported platform.
pub fn validate_session_id(session_id: &str) -> Result<(), AppError> {
    let length = session_id.len();
    if length == 0 || length > SESSION_ID_LIMIT {
        return Err(AppError::configuration(format!(
            "Invalid request: sessionId must be between 1 and {SESSION_ID_LIMIT} characters."
        )));
    }
    let valid = session_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if !valid {
        return Err(AppError::configuration(
            "Invalid request: sessionId may only contain letters, digits, underscores, and hyphens.",
        ));
    }
    Ok(())
}

fn parse_prompt(payload: PromptPayload) -> Result<PromptSubmission, AppError> {
    validate_session_id(&payload.session_id)?;
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
    payload: ConfigPayload,
) -> Result<ClientConfig, AppError> {
    ensure_main_window(&window)?;
    let config = parse_config(payload)?;

    let (previous, saved) = {
        let mut store = state.write_config_store();
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
    payload: PromptPayload,
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

    fn config_payload(value: serde_json::Value) -> ConfigPayload {
        serde_json::from_value(value).expect("config payload")
    }

    fn prompt_payload(value: serde_json::Value) -> PromptPayload {
        serde_json::from_value(value).expect("prompt payload")
    }

    #[test]
    fn parses_a_valid_configuration() {
        let config = parse_config(config_payload(json!({
            "serverTicket": "ticket",
            "serverNodeId": null,
            "relayUrl": null
        })))
        .expect("config");
        assert_eq!(config.server_ticket.as_deref(), Some("ticket"));
    }

    #[test]
    fn rejects_unknown_configuration_fields() {
        let error = serde_json::from_value::<ConfigPayload>(json!({
            "serverTicket": "ticket",
            "serverNodeId": null,
            "relayUrl": null,
            "extra": true
        }))
        .expect_err("unknown field");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn rejects_missing_configuration_fields() {
        let error = parse_config(config_payload(json!({
            "serverTicket": "ticket",
            "serverNodeId": null
        })))
        .expect_err("missing");
        assert_eq!(error.code, ErrorCode::Configuration);
        assert!(error.message.contains("relayUrl"));
    }

    #[test]
    fn rejects_a_wrong_type_configuration_field() {
        let error = serde_json::from_value::<ConfigPayload>(json!({
            "serverTicket": 3,
            "serverNodeId": null,
            "relayUrl": null
        }))
        .expect_err("wrong type");
        assert!(
            error.to_string().contains("expected a string"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rejects_oversized_configuration_fields() {
        let error = parse_config(config_payload(json!({
            "serverTicket": "x".repeat(CONFIG_FIELD_LIMIT + 1),
            "serverNodeId": null,
            "relayUrl": null
        })))
        .expect_err("oversized");
        assert_eq!(error.code, ErrorCode::Configuration);
    }

    #[test]
    fn rejects_a_malformed_prompt() {
        assert!(
            serde_json::from_value::<PromptPayload>(json!({ "sessionId": "session-1" })).is_err()
        );
        assert!(serde_json::from_value::<PromptPayload>(
            json!({ "sessionId": "session-1", "text": 5 })
        )
        .is_err());
    }

    #[test]
    fn rejects_oversized_prompt_fields() {
        assert_eq!(
            parse_prompt(prompt_payload(json!({
                "sessionId": "x".repeat(SESSION_ID_LIMIT + 1),
                "text": "hi"
            })))
            .expect_err("oversized session")
            .code,
            ErrorCode::Configuration
        );
        assert_eq!(
            parse_prompt(prompt_payload(json!({
                "sessionId": "session-1",
                "text": "x".repeat(PROMPT_TEXT_LIMIT + 1)
            })))
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

    #[test]
    fn rejects_session_ids_that_could_escape_the_history_directory() {
        for id in [
            "../escape",
            "..",
            "a/b",
            "a\\b",
            "with space",
            "nul\0",
            "",
            &"x".repeat(SESSION_ID_LIMIT + 1),
        ] {
            let error = parse_session_id(json!(id)).expect_err("unsafe session id");
            assert_eq!(
                error.code,
                ErrorCode::Configuration,
                "session id {id:?} must be rejected"
            );
        }
    }

    #[test]
    fn accepts_uuid_style_session_ids() {
        for id in [
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "session_1",
            "ABC-123_x",
        ] {
            assert_eq!(parse_session_id(json!(id)).expect("valid session id"), id);
        }
    }

    #[test]
    fn rejects_an_unsafe_session_id_supplied_through_prompt_send() {
        let error = parse_prompt(prompt_payload(json!({
            "sessionId": "../../etc/passwd",
            "text": "hi"
        })))
        .expect_err("unsafe prompt session");
        assert_eq!(error.code, ErrorCode::Configuration);
    }
    #[test]
    fn accepts_a_typed_prompt_payload_without_a_second_conversion() {
        let payload = prompt_payload(json!({ "sessionId": "session-1", "text": "hello" }));
        let submission = parse_prompt(payload).expect("prompt");
        assert_eq!(submission.session_id, "session-1");
        assert_eq!(submission.text, "hello");
    }

    #[test]
    fn accepts_a_short_prompt_at_the_boundary() {
        let title_source = "x".repeat(PROMPT_TEXT_LIMIT);
        let payload = prompt_payload(json!({ "sessionId": "session-1", "text": title_source }));
        assert!(parse_prompt(payload).is_ok());
    }
}
