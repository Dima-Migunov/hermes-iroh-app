use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use crate::errors::ErrorCode;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    #[serde(default)]
    pub server_ticket: Option<String>,
    #[serde(default)]
    pub server_node_id: Option<String>,
    #[serde(default)]
    pub relay_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ConnectionStatus {
    pub fn disconnected() -> Self {
        Self {
            state: ConnectionState::Disconnected,
            message: None,
        }
    }

    pub fn connecting() -> Self {
        Self {
            state: ConnectionState::Connecting,
            message: None,
        }
    }

    pub fn connected() -> Self {
        Self {
            state: ConnectionState::Connected,
            message: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            state: ConnectionState::Error,
            message: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Complete,
    Streaming,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<Number>,
}

impl TokenUsage {
    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none()
            && self.output_tokens.is_none()
            && self.total_tokens.is_none()
            && self.reasoning_tokens.is_none()
            && self.cache_read_tokens.is_none()
            && self.cache_write_tokens.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_calls: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost_usd: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_percent: Option<Number>,
}

impl SessionUsage {
    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none()
            && self.output_tokens.is_none()
            && self.total_tokens.is_none()
            && self.api_calls.is_none()
            && self.estimated_cost_usd.is_none()
            && self.cost_status.is_none()
            && self.cost_source.is_none()
            && self.context_tokens.is_none()
            && self.context_length.is_none()
            && self.context_percent.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanGauge {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_bp: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at_ms: Option<Number>,
}

impl PlanGauge {
    pub fn is_empty(&self) -> bool {
        self.id.is_none()
            && self.label.is_none()
            && self.used_bp.is_none()
            && self.resets_at_ms.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountBalance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_micros: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_usd: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_micros: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_usd: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_limit_usd: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchased_micros: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchased_usd: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paid_access: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub as_of_ms: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_gauge: Option<PlanGauge>,
}

impl AccountBalance {
    pub fn is_empty(&self) -> bool {
        self.provider.is_none()
            && self.remaining_micros.is_none()
            && self.remaining_usd.is_none()
            && self.subscription_micros.is_none()
            && self.subscription_usd.is_none()
            && self.subscription_limit_usd.is_none()
            && self.purchased_micros.is_none()
            && self.purchased_usd.is_none()
            && self.paid_access.is_none()
            && self.as_of_ms.is_none()
            && self.plan_gauge.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseMetadata {
    pub schema: i64,
    pub generated_at: String,
    pub latency_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_usage: Option<SessionUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<AccountBalance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub arguments: Value,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
    pub line_index: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: String,
    pub created_at: String,
    pub status: MessageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StoredError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ResponseMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub custom_title: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub session: SessionSummary,
    pub messages: Vec<StoredMessage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionResult {
    pub sessions: Vec<SessionSummary>,
    pub active_session: SessionSnapshot,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PromptEvent {
    Start {
        request_id: String,
        session_id: String,
    },
    Delta {
        request_id: String,
        content: String,
    },
    Tool {
        request_id: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        name: String,
        arguments: Value,
        truncated: bool,
        line_index: usize,
    },
    Done {
        request_id: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<Box<ResponseMetadata>>,
    },
    Cancelled {
        request_id: String,
        session_id: String,
    },
    Error {
        request_id: String,
        session_id: String,
        code: ErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeLevel {
    Info,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppNotice {
    pub level: NoticeLevel,
    pub message: String,
}

impl AppNotice {
    pub fn warning(message: impl Into<String>) -> Self {
        Self {
            level: NoticeLevel::Warning,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServerFrame {
    Start {
        session_id: String,
    },
    Delta {
        content: String,
    },
    Tool {
        id: Option<String>,
        name: String,
        arguments: Value,
        truncated: bool,
    },
    Done {
        metadata: Option<Box<ResponseMetadata>>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptSubmissionResult {
    #[serde(rename = "requestId")]
    pub request_id: String,
}

#[derive(Serialize)]
struct ClientPromptFrame<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    session_id: &'a str,
    text: &'a str,
}

pub fn serialize_prompt(session_id: &str, text: &str) -> String {
    let frame = ClientPromptFrame {
        kind: "prompt",
        session_id,
        text,
    };
    format!(
        "{}\n",
        serde_json::to_string(&frame).expect("the prompt frame is serializable")
    )
}

pub fn parse_server_frame(line: &str) -> Result<Option<ServerFrame>, crate::errors::AppError> {
    use crate::errors::AppError;
    use crate::metadata::normalize_response_metadata;

    let parsed: Value = serde_json::from_str(line).map_err(|_| {
        AppError::protocol("The server sent a response line that is not valid JSON.")
    })?;

    let record = parsed.as_object().ok_or_else(|| {
        AppError::protocol("The server sent a response frame without a valid type.")
    })?;
    let frame_type = record.get("type").and_then(Value::as_str).ok_or_else(|| {
        AppError::protocol("The server sent a response frame without a valid type.")
    })?;

    match frame_type {
        "start" => {
            let session_id = record
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::protocol("The server start frame is missing a valid session_id.")
                })?;
            Ok(Some(ServerFrame::Start {
                session_id: session_id.to_owned(),
            }))
        }
        "delta" => {
            let content = record
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::protocol("The server delta frame is missing valid content.")
                })?;
            Ok(Some(ServerFrame::Delta {
                content: content.to_owned(),
            }))
        }
        "tool" => {
            let name = record
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let Some(arguments) = record.get("arguments").filter(|value| value.is_object()) else {
                return Ok(None);
            };
            if name.is_empty() {
                return Ok(None);
            }
            Ok(Some(ServerFrame::Tool {
                id: record.get("id").and_then(Value::as_str).map(str::to_owned),
                name: name.to_owned(),
                arguments: arguments.clone(),
                truncated: record
                    .get("truncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }))
        }
        "done" => {
            let metadata = record
                .get("metadata")
                .and_then(normalize_response_metadata)
                .map(Box::new);
            Ok(Some(ServerFrame::Done { metadata }))
        }
        "error" => {
            let message = record
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::protocol("The server error frame is missing a valid message.")
                })?;
            Ok(Some(ServerFrame::Error {
                message: message.to_owned(),
            }))
        }
        _ => Ok(None),
    }
}

pub struct PromptStateMachine<'a> {
    request_id: String,
    expected_session_id: String,
    emit: Box<dyn FnMut(PromptEvent) + Send + 'a>,
    started: bool,
    terminal: bool,
    pending_tools: Vec<PendingTool>,
    line_count: usize,
    at_line_start: bool,
}

const MAX_PENDING_TOOLS: usize = 64;

struct PendingTool {
    id: Option<String>,
    name: String,
    arguments: Value,
    truncated: bool,
}

impl<'a> PromptStateMachine<'a> {
    pub fn new(
        request_id: impl Into<String>,
        expected_session_id: impl Into<String>,
        emit: impl FnMut(PromptEvent) + Send + 'a,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            expected_session_id: expected_session_id.into(),
            emit: Box::new(emit),
            started: false,
            terminal: false,
            pending_tools: Vec::new(),
            line_count: 0,
            at_line_start: true,
        }
    }

    pub fn is_settled(&self) -> bool {
        self.terminal
    }

    pub fn handle_frame(&mut self, frame: ServerFrame) {
        if self.terminal {
            return;
        }

        match frame {
            ServerFrame::Start { session_id } => {
                if self.started {
                    self.fail(
                        ErrorCode::Protocol,
                        "The server sent more than one start frame.",
                    );
                    return;
                }
                if session_id != self.expected_session_id {
                    self.fail(
                        ErrorCode::Protocol,
                        format!(
                            "The server responded for session \"{session_id}\" instead of \"{}\".",
                            self.expected_session_id
                        ),
                    );
                    return;
                }
                self.started = true;
                (self.emit)(PromptEvent::Start {
                    request_id: self.request_id.clone(),
                    session_id,
                });
            }
            ServerFrame::Delta { content } => {
                if !self.started {
                    self.fail(
                        ErrorCode::Protocol,
                        "The server sent response content before the start frame.",
                    );
                    return;
                }
                self.emit_tool_matches(&content);
                (self.emit)(PromptEvent::Delta {
                    request_id: self.request_id.clone(),
                    content,
                });
            }
            ServerFrame::Tool {
                id,
                name,
                arguments,
                truncated,
            } => {
                if !self.started {
                    return;
                }
                if self.pending_tools.len() >= MAX_PENDING_TOOLS {
                    self.pending_tools.clear();
                    return;
                }
                self.pending_tools.push(PendingTool {
                    id,
                    name,
                    arguments,
                    truncated,
                });
            }
            ServerFrame::Done { metadata } => {
                if !self.started {
                    self.fail(
                        ErrorCode::Protocol,
                        "The server sent a done frame before the start frame.",
                    );
                    return;
                }
                self.pending_tools.clear();
                self.terminal = true;
                (self.emit)(PromptEvent::Done {
                    request_id: self.request_id.clone(),
                    session_id: self.expected_session_id.clone(),
                    metadata,
                });
            }
            ServerFrame::Error { message } => {
                self.pending_tools.clear();
                self.terminal = true;
                (self.emit)(PromptEvent::Error {
                    request_id: self.request_id.clone(),
                    session_id: self.expected_session_id.clone(),
                    code: ErrorCode::Server,
                    message,
                });
            }
        }
    }

    fn emit_tool_matches(&mut self, content: &str) {
        let segments: Vec<&str> = content.split('\n').collect();
        let base = self.line_count;
        let mut candidates = Vec::new();
        for (position, segment) in segments.iter().enumerate() {
            let is_new = position > 0 || self.at_line_start;
            if is_new && !segment.trim().is_empty() {
                candidates.push(base + position);
            }
        }

        let matched = self.pending_tools.len().min(candidates.len());
        let tools: Vec<PendingTool> = self.pending_tools.drain(..matched).collect();
        for (tool, line_index) in tools.into_iter().zip(candidates) {
            (self.emit)(PromptEvent::Tool {
                request_id: self.request_id.clone(),
                session_id: self.expected_session_id.clone(),
                id: tool.id,
                name: tool.name,
                arguments: tool.arguments,
                truncated: tool.truncated,
                line_index,
            });
        }

        self.line_count += segments.len() - 1;
        self.at_line_start = content.is_empty() || content.ends_with('\n');
    }

    pub fn handle_eof(&mut self) {
        if self.terminal {
            return;
        }
        if self.started {
            self.fail(
                ErrorCode::ConnectionClosed,
                "The server closed the connection before the response finished.",
            );
        } else {
            self.fail(
                ErrorCode::ConnectionClosed,
                crate::errors::early_close_message(),
            );
        }
    }

    pub fn handle_transport_error(&mut self, error: &(dyn std::error::Error + 'static)) {
        if self.terminal {
            return;
        }
        let mapped = crate::errors::map_iroh_error_with(error, !self.started);
        self.fail(mapped.code, mapped.message);
    }

    fn fail(&mut self, code: ErrorCode, message: impl Into<String>) {
        self.pending_tools.clear();
        self.terminal = true;
        (self.emit)(PromptEvent::Error {
            request_id: self.request_id.clone(),
            session_id: self.expected_session_id.clone(),
            code,
            message: message.into(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::AppError;

    #[test]
    fn serializes_custom_titles_and_deletion_results() {
        let summary = SessionSummary {
            id: "session-1".to_owned(),
            title: "Chat".to_owned(),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
            custom_title: false,
        };
        let value = serde_json::to_value(&summary).expect("serialize");
        assert!(value.get("customTitle").is_none());

        let mut custom = summary.clone();
        custom.custom_title = true;
        let value = serde_json::to_value(&custom).expect("serialize");
        assert_eq!(value["customTitle"], true);

        let legacy: SessionSummary = serde_json::from_value(serde_json::json!({
            "id": "session-1",
            "title": "Chat",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }))
        .expect("legacy summary");
        assert!(!legacy.custom_title);

        let result = SessionDeletionResult {
            sessions: vec![custom],
            active_session: SessionSnapshot {
                session: summary,
                messages: Vec::new(),
            },
        };
        let value = serde_json::to_value(&result).expect("serialize result");
        assert!(value.get("activeSession").is_some());
        assert!(value.get("active_session").is_none());
    }

    #[test]
    fn serializes_the_exact_protocol_line() {
        assert_eq!(
            serialize_prompt("s1", "hello"),
            "{\"type\":\"prompt\",\"session_id\":\"s1\",\"text\":\"hello\"}\n"
        );
    }

    #[test]
    fn escapes_special_characters_and_emits_one_trailing_newline() {
        let line = serialize_prompt("session\"1", "line 1\nline \"2\"\\");

        assert!(line.ends_with('\n'));
        assert_eq!(line.find('\n'), Some(line.len() - 1));
        let parsed: Value = serde_json::from_str(&line).expect("json");
        assert_eq!(parsed["type"], "prompt");
        assert_eq!(parsed["session_id"], "session\"1");
        assert_eq!(parsed["text"], "line 1\nline \"2\"\\");
    }

    #[test]
    fn parses_all_documented_frames() {
        assert_eq!(
            parse_server_frame("{\"type\":\"start\",\"session_id\":\"s1\"}")
                .expect("start")
                .expect("frame"),
            ServerFrame::Start {
                session_id: "s1".to_owned()
            }
        );
        assert_eq!(
            parse_server_frame("{\"type\":\"delta\",\"content\":\"a\"}")
                .expect("delta")
                .expect("frame"),
            ServerFrame::Delta {
                content: "a".to_owned()
            }
        );
        assert_eq!(
            parse_server_frame("{\"type\":\"done\"}")
                .expect("done")
                .expect("frame"),
            ServerFrame::Done { metadata: None }
        );
        assert_eq!(
            parse_server_frame("{\"type\":\"error\",\"message\":\"nope\"}")
                .expect("error")
                .expect("frame"),
            ServerFrame::Error {
                message: "nope".to_owned()
            }
        );
    }

    #[test]
    fn ignores_unknown_frame_types() {
        assert!(parse_server_frame("{\"type\":\"heartbeat\"}")
            .expect("unknown")
            .is_none());
    }

    #[test]
    fn parses_a_tool_frame_with_every_field() {
        let frame = parse_server_frame(
            r#"{"type":"tool","id":"call-1","name":"web_search","arguments":{"query":"rust"},"truncated":true}"#,
        )
        .expect("tool")
        .expect("frame");

        assert_eq!(
            frame,
            ServerFrame::Tool {
                id: Some("call-1".to_owned()),
                name: "web_search".to_owned(),
                arguments: serde_json::json!({ "query": "rust" }),
                truncated: true,
            }
        );
    }

    #[test]
    fn normalizes_invalid_optional_tool_fields() {
        let frame = parse_server_frame(
            r#"{"type":"tool","id":7,"name":"web_search","arguments":{},"truncated":"yes"}"#,
        )
        .expect("tool")
        .expect("frame");

        assert_eq!(
            frame,
            ServerFrame::Tool {
                id: None,
                name: "web_search".to_owned(),
                arguments: serde_json::json!({}),
                truncated: false,
            }
        );
    }

    #[test]
    fn ignores_unusable_tool_frames() {
        for line in [
            r#"{"type":"tool","arguments":{}}"#,
            r#"{"type":"tool","name":"","arguments":{}}"#,
            r#"{"type":"tool","name":5,"arguments":{}}"#,
            r#"{"type":"tool","name":"web_search"}"#,
            r#"{"type":"tool","name":"web_search","arguments":[]}"#,
            r#"{"type":"tool","name":"web_search","arguments":"query"}"#,
            r#"{"type":"tool","name":"web_search","arguments":null}"#,
        ] {
            assert!(
                parse_server_frame(line).expect("usable JSON").is_none(),
                "expected unusable tool frame to be ignored: {line}"
            );
        }
    }

    #[test]
    fn rejects_malformed_json() {
        let error = parse_server_frame("not json").expect_err("invalid");
        assert_eq!(error.code, ErrorCode::Protocol);
    }

    #[test]
    fn rejects_recognized_frames_with_missing_fields() {
        assert!(parse_server_frame("{\"type\":\"start\"}").is_err());
        assert!(parse_server_frame("{\"type\":\"delta\",\"content\":5}").is_err());
        assert!(parse_server_frame("{\"type\":\"error\"}").is_err());
        assert!(parse_server_frame("{\"kind\":\"done\"}").is_err());
    }

    #[test]
    fn attaches_normalized_metadata_to_a_done_frame() {
        let line = r#"{"type":"done","metadata":{"schema":1,"generated_at":"2026-11-21T12:00:00.000Z","latency_ms":812}}"#;
        let frame = parse_server_frame(line).expect("done").expect("frame");
        match frame {
            ServerFrame::Done { metadata } => {
                let metadata = metadata.expect("metadata");
                assert_eq!(metadata.schema, 1);
                assert_eq!(metadata.latency_ms, 812);
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn drops_invalid_metadata_and_keeps_a_bare_done_frame() {
        for line in [
            "{\"type\":\"done\",\"metadata\":{\"schema\":1}}",
            "{\"type\":\"done\",\"metadata\":\"invalid\"}",
            "{\"type\":\"done\",\"metadata\":null}",
        ] {
            assert_eq!(
                parse_server_frame(line).expect("done").expect("frame"),
                ServerFrame::Done { metadata: None }
            );
        }
    }

    fn run(action: impl FnOnce(&mut PromptStateMachine<'_>)) -> (Vec<PromptEvent>, bool) {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&events);
        let mut machine = PromptStateMachine::new("req-1", "session-1", move |event| {
            sink.lock().expect("events").push(event)
        });

        action(&mut machine);
        let settled = machine.is_settled();
        drop(machine);

        let events = events.lock().expect("events").clone();
        (events, settled)
    }

    fn event_types(events: &[PromptEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|event| match event {
                PromptEvent::Start { .. } => "start",
                PromptEvent::Delta { .. } => "delta",
                PromptEvent::Tool { .. } => "tool",
                PromptEvent::Done { .. } => "done",
                PromptEvent::Cancelled { .. } => "cancelled",
                PromptEvent::Error { .. } => "error",
            })
            .collect()
    }

    #[test]
    fn emits_start_deltas_and_one_done_in_order() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_frame(ServerFrame::Delta {
                content: "a".to_owned(),
            });
            machine.handle_frame(ServerFrame::Delta {
                content: "b".to_owned(),
            });
            machine.handle_frame(ServerFrame::Done { metadata: None });
            machine.handle_frame(ServerFrame::Delta {
                content: "ignored".to_owned(),
            });
            machine.handle_frame(ServerFrame::Done { metadata: None });
        });

        assert_eq!(
            event_types(&events),
            vec!["start", "delta", "delta", "done"]
        );
        assert!(settled);
    }

    #[test]
    fn rejects_a_delta_before_start() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Delta {
                content: "early".to_owned(),
            });
        });

        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            PromptEvent::Error {
                code: ErrorCode::Protocol,
                ..
            }
        ));
        assert!(settled);
    }

    #[test]
    fn rejects_a_mismatched_session_id() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "other".to_owned(),
            });
        });

        match &events[0] {
            PromptEvent::Error { code, message, .. } => {
                assert_eq!(*code, ErrorCode::Protocol);
                assert!(message.contains("other"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert!(settled);
    }

    #[test]
    fn rejects_a_duplicate_start_frame() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
        });

        assert_eq!(event_types(&events), vec!["start", "error"]);
        assert!(matches!(
            &events[1],
            PromptEvent::Error {
                code: ErrorCode::Protocol,
                ..
            }
        ));
        assert!(settled);
    }

    #[test]
    fn reports_eof_as_a_connection_closed_error_with_the_allowlist_hint() {
        let (events, settled) = run(|machine| machine.handle_eof());

        assert_eq!(events.len(), 1);
        match &events[0] {
            PromptEvent::Error { code, message, .. } => {
                assert_eq!(*code, ErrorCode::ConnectionClosed);
                assert!(message.contains("/iroh_allow"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert!(settled);
    }

    #[test]
    fn reports_eof_after_start_without_the_allowlist_hint() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_eof();
        });

        assert_eq!(event_types(&events), vec!["start", "error"]);
        match &events[1] {
            PromptEvent::Error { code, message, .. } => {
                assert_eq!(*code, ErrorCode::ConnectionClosed);
                assert!(
                    !message.contains("/iroh_allow"),
                    "the allowlist hint only applies before any response began"
                );
                assert!(message.contains("before the response finished"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert!(settled);
    }

    #[test]
    fn reports_eof_after_deltas_as_a_close_after_start() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_frame(ServerFrame::Delta {
                content: "partial".to_owned(),
            });
            machine.handle_eof();
        });

        assert_eq!(event_types(&events), vec!["start", "delta", "error"]);
        assert!(matches!(
            &events[2],
            PromptEvent::Error {
                code: ErrorCode::ConnectionClosed,
                message,
                ..
            } if !message.contains("/iroh_allow")
        ));
        assert!(settled);
    }

    #[test]
    fn rejects_a_done_frame_before_start_as_a_protocol_violation() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Done { metadata: None });
        });

        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            PromptEvent::Error {
                code: ErrorCode::Protocol,
                message,
                ..
            } if message.contains("before the start frame")
        ));
        assert!(settled);
    }

    #[test]
    fn accepts_done_after_start() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_frame(ServerFrame::Done { metadata: None });
        });

        assert_eq!(event_types(&events), vec!["start", "done"]);
        assert!(settled);
    }

    #[test]
    fn ignores_transport_failures_after_a_terminal_event() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_frame(ServerFrame::Done { metadata: None });
            machine.handle_transport_error(&AppError::protocol("late failure"));
        });

        assert_eq!(event_types(&events), vec!["start", "done"]);
        assert!(settled);
    }

    #[test]
    fn preserves_a_server_error_message_and_ignores_later_frames() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_frame(ServerFrame::Error {
                message: "model overloaded".to_owned(),
            });
            machine.handle_frame(ServerFrame::Delta {
                content: "ignored".to_owned(),
            });
        });

        assert_eq!(event_types(&events), vec!["start", "error"]);
        assert!(matches!(
            &events[1],
            PromptEvent::Error {
                code: ErrorCode::Server,
                message,
                ..
            } if message == "model overloaded"
        ));
        assert!(settled);
    }

    #[test]
    fn forwards_metadata_exactly_once() {
        let metadata: ResponseMetadata = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812
        }))
        .expect("metadata");
        let second_metadata = ResponseMetadata {
            schema: 2,
            ..metadata.clone()
        };

        let (events, settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_frame(ServerFrame::Done {
                metadata: Some(Box::new(metadata.clone())),
            });
            machine.handle_frame(ServerFrame::Done {
                metadata: Some(Box::new(second_metadata)),
            });
            machine.handle_transport_error(&AppError::protocol("late failure"));
        });

        assert_eq!(event_types(&events), vec!["start", "done"]);
        assert!(matches!(
            &events[1],
            PromptEvent::Done {
                metadata: Some(value),
                ..
            } if value.as_ref() == &metadata
        ));
        assert!(settled);
    }

    #[test]
    fn emits_a_bare_done_without_a_metadata_property() {
        let (events, _settled) = run(|machine| {
            machine.handle_frame(ServerFrame::Start {
                session_id: "session-1".to_owned(),
            });
            machine.handle_frame(ServerFrame::Done { metadata: None });
        });

        assert_eq!(
            events[1],
            PromptEvent::Done {
                request_id: "req-1".to_owned(),
                session_id: "session-1".to_owned(),
                metadata: None,
            }
        );
    }

    fn tool(name: &str) -> ServerFrame {
        ServerFrame::Tool {
            id: Some(format!("call-{name}")),
            name: name.to_owned(),
            arguments: serde_json::json!({ "query": name }),
            truncated: false,
        }
    }

    fn start(machine: &mut PromptStateMachine<'_>) {
        machine.handle_frame(ServerFrame::Start {
            session_id: "session-1".to_owned(),
        });
    }

    fn delta(machine: &mut PromptStateMachine<'_>, content: &str) {
        machine.handle_frame(ServerFrame::Delta {
            content: content.to_owned(),
        });
    }

    fn reconstructed(events: &[PromptEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                PromptEvent::Delta { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect()
    }

    fn tool_matches(events: &[PromptEvent]) -> Vec<(&str, usize)> {
        events
            .iter()
            .filter_map(|event| match event {
                PromptEvent::Tool {
                    name, line_index, ..
                } => Some((name.as_str(), *line_index)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn ignores_tool_frames_before_start() {
        let (events, settled) = run(|machine| {
            machine.handle_frame(tool("web_search"));
            start(machine);
            delta(machine, "hello");
        });

        assert_eq!(event_types(&events), vec!["start", "delta"]);
        assert!(tool_matches(&events).is_empty());
        assert_eq!(reconstructed(&events), "hello");
        assert!(!settled);
    }

    #[test]
    fn ignores_tool_frames_after_a_terminal_frame() {
        let (events, settled) = run(|machine| {
            start(machine);
            machine.handle_frame(ServerFrame::Done { metadata: None });
            machine.handle_frame(tool("web_search"));
            delta(machine, "late");
        });

        assert_eq!(event_types(&events), vec!["start", "done"]);
        assert!(tool_matches(&events).is_empty());
        assert_eq!(reconstructed(&events), "");
        assert!(settled);
    }

    #[test]
    fn emits_a_tool_before_the_delta_that_introduces_its_line() {
        let (events, _settled) = run(|machine| {
            start(machine);
            machine.handle_frame(tool("web_search"));
            delta(machine, "Searching the web");
        });

        assert_eq!(event_types(&events), vec!["start", "tool", "delta"]);
        assert_eq!(tool_matches(&events), vec![("web_search", 0)]);
        match &events[1] {
            PromptEvent::Tool {
                request_id,
                session_id,
                id,
                arguments,
                truncated,
                ..
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(session_id, "session-1");
                assert_eq!(id.as_deref(), Some("call-web_search"));
                assert_eq!(arguments, &serde_json::json!({ "query": "web_search" }));
                assert!(!truncated);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn skips_blank_lines_when_matching_tools() {
        let (events, _settled) = run(|machine| {
            start(machine);
            machine.handle_frame(tool("web_search"));
            delta(machine, "\n  \nresult");
        });

        assert_eq!(event_types(&events), vec!["start", "tool", "delta"]);
        assert_eq!(tool_matches(&events), vec![("web_search", 2)]);
        assert_eq!(reconstructed(&events), "\n  \nresult");
    }

    #[test]
    fn does_not_match_a_continuation_delta() {
        let (events, _settled) = run(|machine| {
            start(machine);
            delta(machine, "partial");
            machine.handle_frame(tool("web_search"));
            delta(machine, " continuation");
            delta(machine, "\nnext");
        });

        assert_eq!(
            event_types(&events),
            vec!["start", "delta", "delta", "tool", "delta"]
        );
        assert_eq!(tool_matches(&events), vec![("web_search", 1)]);
        assert_eq!(reconstructed(&events), "partial continuation\nnext");
    }

    #[test]
    fn matches_a_line_split_across_deltas_on_its_first_fragment() {
        let (events, _settled) = run(|machine| {
            start(machine);
            machine.handle_frame(tool("web_search"));
            delta(machine, "par");
            delta(machine, "tial\nnext");
        });

        assert_eq!(
            event_types(&events),
            vec!["start", "tool", "delta", "delta"]
        );
        assert_eq!(tool_matches(&events), vec![("web_search", 0)]);
        assert_eq!(reconstructed(&events), "partial\nnext");
    }

    #[test]
    fn counts_earlier_lines_when_indexing() {
        let (events, _settled) = run(|machine| {
            start(machine);
            delta(machine, "one\ntwo\n");
            machine.handle_frame(tool("web_search"));
            delta(machine, "three");
        });

        assert_eq!(tool_matches(&events), vec![("web_search", 2)]);
        assert_eq!(reconstructed(&events), "one\ntwo\nthree");
    }

    #[test]
    fn matches_multiple_tools_to_successive_new_lines() {
        let (events, _settled) = run(|machine| {
            start(machine);
            machine.handle_frame(tool("first"));
            machine.handle_frame(tool("second"));
            delta(machine, "alpha\nbeta");
        });

        assert_eq!(event_types(&events), vec!["start", "tool", "tool", "delta"]);
        assert_eq!(tool_matches(&events), vec![("first", 0), ("second", 1)]);
    }

    #[test]
    fn retains_unmatched_tools_for_later_deltas() {
        let (events, _settled) = run(|machine| {
            start(machine);
            machine.handle_frame(tool("first"));
            machine.handle_frame(tool("second"));
            delta(machine, "alpha");
            delta(machine, "\nbeta");
        });

        assert_eq!(
            event_types(&events),
            vec!["start", "tool", "delta", "tool", "delta"]
        );
        assert_eq!(tool_matches(&events), vec![("first", 0), ("second", 1)]);
    }

    #[test]
    fn discards_unmatched_tools_at_done() {
        let (events, settled) = run(|machine| {
            start(machine);
            machine.handle_frame(tool("web_search"));
            machine.handle_frame(ServerFrame::Done { metadata: None });
        });

        assert_eq!(event_types(&events), vec!["start", "done"]);
        assert!(tool_matches(&events).is_empty());
        assert!(settled);
    }

    #[test]
    fn clears_pending_tools_when_the_cap_is_exceeded() {
        let (events, _settled) = run(|machine| {
            start(machine);
            for _ in 0..=MAX_PENDING_TOOLS {
                machine.handle_frame(tool("web_search"));
            }
            delta(machine, "line");
        });

        assert_eq!(event_types(&events), vec!["start", "delta"]);
        assert!(tool_matches(&events).is_empty());
        assert_eq!(reconstructed(&events), "line");
    }

    #[test]
    fn empty_deltas_do_not_change_reconstructed_content() {
        let (events, _settled) = run(|machine| {
            start(machine);
            delta(machine, "");
            machine.handle_frame(tool("web_search"));
            delta(machine, "x");
            delta(machine, "");
            delta(machine, "\n");
            delta(machine, "y");
        });

        assert_eq!(tool_matches(&events), vec![("web_search", 0)]);
        assert_eq!(reconstructed(&events), "x\ny");
    }

    #[test]
    fn whitespace_only_lines_do_not_consume_tools() {
        let (events, _settled) = run(|machine| {
            start(machine);
            delta(machine, "a\n \t \n");
            machine.handle_frame(tool("web_search"));
            delta(machine, "b");
        });

        assert_eq!(tool_matches(&events), vec![("web_search", 2)]);
        assert_eq!(reconstructed(&events), "a\n \t \nb");
    }

    #[test]
    fn drops_a_tool_with_no_following_text_at_a_terminal_error() {
        let (events, settled) = run(|machine| {
            start(machine);
            delta(machine, "partial");
            machine.handle_frame(tool("web_search"));
            machine.handle_frame(ServerFrame::Error {
                message: "model overloaded".to_owned(),
            });
        });

        assert_eq!(event_types(&events), vec!["start", "delta", "error"]);
        assert!(tool_matches(&events).is_empty());
        assert_eq!(reconstructed(&events), "partial");
        assert!(settled);
    }
}
