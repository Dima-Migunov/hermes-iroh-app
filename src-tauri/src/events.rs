use tauri::{AppHandle, Emitter};

use crate::protocol::{AppNotice, ConnectionStatus, PromptEvent};

pub const PROMPT_EVENT: &str = "prompt:event";
pub const CONNECTION_STATUS_CHANGED: &str = "connection:status-changed";
pub const HISTORY_CHANGED: &str = "history:changed";
pub const APP_NOTICE: &str = "app:notice";

pub trait EventSink: Send + Sync {
    fn prompt_event(&self, event: PromptEvent);
    fn connection_status(&self, status: ConnectionStatus);
    fn history_changed(&self);
    fn notice(&self, notice: AppNotice);
}

pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn prompt_event(&self, event: PromptEvent) {
        let _ = self.app.emit(PROMPT_EVENT, event);
    }

    fn connection_status(&self, status: ConnectionStatus) {
        let _ = self.app.emit(CONNECTION_STATUS_CHANGED, status);
    }

    fn history_changed(&self) {
        let _ = self.app.emit(HISTORY_CHANGED, ());
    }

    fn notice(&self, notice: AppNotice) {
        let _ = self.app.emit(APP_NOTICE, notice);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorCode;
    use crate::protocol::ConnectionState;
    use serde_json::json;

    #[test]
    fn serializes_prompt_events_with_renderer_field_names() {
        assert_eq!(
            serde_json::to_value(PromptEvent::Start {
                request_id: "request-1".to_owned(),
                session_id: "session-1".to_owned(),
            })
            .expect("start"),
            json!({
                "type": "start",
                "requestId": "request-1",
                "sessionId": "session-1"
            })
        );

        assert_eq!(
            serde_json::to_value(PromptEvent::Delta {
                request_id: "request-1".to_owned(),
                content: "hello".to_owned(),
            })
            .expect("delta"),
            json!({
                "type": "delta",
                "requestId": "request-1",
                "content": "hello"
            })
        );

        assert_eq!(
            serde_json::to_value(PromptEvent::Done {
                request_id: "request-1".to_owned(),
                session_id: "session-1".to_owned(),
                metadata: None,
            })
            .expect("done"),
            json!({
                "type": "done",
                "requestId": "request-1",
                "sessionId": "session-1"
            })
        );

        assert_eq!(
            serde_json::to_value(PromptEvent::Cancelled {
                request_id: "request-1".to_owned(),
                session_id: "session-1".to_owned(),
            })
            .expect("cancelled"),
            json!({
                "type": "cancelled",
                "requestId": "request-1",
                "sessionId": "session-1"
            })
        );

        assert_eq!(
            serde_json::to_value(PromptEvent::Error {
                request_id: "request-1".to_owned(),
                session_id: "session-1".to_owned(),
                code: ErrorCode::ConnectionClosed,
                message: "closed".to_owned(),
            })
            .expect("error"),
            json!({
                "type": "error",
                "requestId": "request-1",
                "sessionId": "session-1",
                "code": "connection-closed",
                "message": "closed"
            })
        );
    }

    #[test]
    fn serializes_status_and_notice_payloads() {
        assert_eq!(
            serde_json::to_value(ConnectionStatus {
                state: ConnectionState::Connected,
                message: None,
            })
            .expect("status"),
            json!({ "state": "connected" })
        );

        assert_eq!(
            serde_json::to_value(AppNotice::warning("history warning")).expect("notice"),
            json!({ "level": "warning", "message": "history warning" })
        );
    }

    #[test]
    fn uses_the_documented_event_channels() {
        assert_eq!(PROMPT_EVENT, "prompt:event");
        assert_eq!(CONNECTION_STATUS_CHANGED, "connection:status-changed");
        assert_eq!(HISTORY_CHANGED, "history:changed");
        assert_eq!(APP_NOTICE, "app:notice");
    }
}
