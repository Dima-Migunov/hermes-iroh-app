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
pub struct StoredMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: String,
    pub created_at: String,
    pub status: MessageStatus,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub session: SessionSummary,
    pub messages: Vec<StoredMessage>,
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
                (self.emit)(PromptEvent::Delta {
                    request_id: self.request_id.clone(),
                    content,
                });
            }
            ServerFrame::Done { metadata } => {
                self.terminal = true;
                (self.emit)(PromptEvent::Done {
                    request_id: self.request_id.clone(),
                    session_id: self.expected_session_id.clone(),
                    metadata,
                });
            }
            ServerFrame::Error { message } => {
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

    pub fn handle_eof(&mut self) {
        if self.terminal {
            return;
        }
        self.fail(
            ErrorCode::ConnectionClosed,
            crate::errors::early_close_message(),
        );
    }

    pub fn handle_transport_error(&mut self, error: &(dyn std::error::Error + 'static)) {
        if self.terminal {
            return;
        }
        let mapped = crate::errors::map_iroh_error_with(error, !self.started);
        self.fail(mapped.code, mapped.message);
    }

    fn fail(&mut self, code: ErrorCode, message: impl Into<String>) {
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
}
