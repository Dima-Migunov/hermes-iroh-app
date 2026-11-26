use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;

use crate::metadata::normalize_response_metadata;
use crate::protocol::{MessageRole, MessageStatus, SessionSummary, StoredError, StoredMessage};
use crate::storage::atomic_file::write_file_atomic;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HistoryIndex {
    pub active_session_id: Option<String>,
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndexLoadResult {
    pub index: HistoryIndex,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionLoadResult {
    pub messages: Vec<StoredMessage>,
    pub warning: Option<String>,
}

#[derive(Clone)]
pub struct HistoryStore {
    history_dir: Arc<PathBuf>,
}

impl HistoryStore {
    pub fn new(history_dir: impl Into<PathBuf>) -> Self {
        Self {
            history_dir: Arc::new(history_dir.into()),
        }
    }

    pub fn history_dir(&self) -> &Path {
        &self.history_dir
    }

    pub fn index_path(&self) -> PathBuf {
        self.history_dir.join("index.json")
    }

    pub fn session_path(&self, session_id: &str) -> PathBuf {
        self.history_dir.join(format!("{session_id}.json"))
    }

    pub fn load_index(&self) -> IndexLoadResult {
        let path = self.index_path();
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return IndexLoadResult {
                    index: HistoryIndex::default(),
                    warning: None,
                };
            }
            Err(error) => {
                return IndexLoadResult {
                    index: HistoryIndex::default(),
                    warning: Some(format!("Chat history could not be loaded: {error}")),
                };
            }
        };

        match parse_index(&raw) {
            Ok(index) => IndexLoadResult {
                index,
                warning: None,
            },
            Err(error) => {
                preserve_corrupt_file(&path);
                IndexLoadResult {
                    index: HistoryIndex::default(),
                    warning: Some(format!(
                        "Chat history index was invalid and has been reset. The original file was preserved. ({error})"
                    )),
                }
            }
        }
    }

    pub fn index_document(index: &HistoryIndex) -> Result<Vec<u8>, String> {
        #[derive(Serialize)]
        struct IndexDocument<'a> {
            version: u8,
            #[serde(rename = "activeSessionId")]
            active_session_id: Option<&'a String>,
            sessions: &'a [SessionSummary],
        }

        serialize_document(&IndexDocument {
            version: 1,
            active_session_id: index.active_session_id.as_ref(),
            sessions: &index.sessions,
        })
    }

    pub fn save_index(&self, index: &HistoryIndex) -> Result<(), String> {
        let bytes = Self::index_document(index)?;
        write_document(&self.index_path(), &bytes)
    }

    pub fn load_session(&self, session_id: &str) -> SessionLoadResult {
        let path = self.session_path(session_id);
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return SessionLoadResult {
                    messages: Vec::new(),
                    warning: None,
                };
            }
            Err(error) => {
                return SessionLoadResult {
                    messages: Vec::new(),
                    warning: Some(format!(
                        "Chat history for a session could not be loaded: {error}"
                    )),
                };
            }
        };

        match parse_session(&raw) {
            Ok(messages) => SessionLoadResult {
                messages,
                warning: None,
            },
            Err(error) => {
                preserve_corrupt_file(&path);
                SessionLoadResult {
                    messages: Vec::new(),
                    warning: Some(format!(
                        "Chat history for a session was invalid and has been reset. The original file was preserved. ({error})"
                    )),
                }
            }
        }
    }

    pub fn session_document(
        session_id: &str,
        messages: &[StoredMessage],
    ) -> Result<Vec<u8>, String> {
        #[derive(Serialize)]
        struct SessionDocument<'a> {
            version: u8,
            #[serde(rename = "sessionId")]
            session_id: &'a str,
            messages: &'a [StoredMessage],
        }

        serialize_document(&SessionDocument {
            version: 1,
            session_id,
            messages,
        })
    }

    pub fn save_session(&self, session_id: &str, messages: &[StoredMessage]) -> Result<(), String> {
        let bytes = Self::session_document(session_id, messages)?;
        write_document(&self.session_path(session_id), &bytes)
    }
}

/// Serializes a document to compact JSON bytes so the caller can write it off the runtime.
pub fn serialize_document<T: Serialize>(document: &T) -> Result<Vec<u8>, String> {
    let serialized = serde_json::to_string(document).map_err(|error| error.to_string())?;
    Ok(format!("{serialized}\n").into_bytes())
}

/// Writes pre-serialized document bytes atomically.
pub fn write_document(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_file_atomic(path, bytes, None).map_err(|error| error.to_string())
}

fn parse_index(raw: &str) -> Result<HistoryIndex, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let document = parsed
        .as_object()
        .ok_or_else(|| "The history index is not an object.".to_owned())?;

    let sessions: Vec<SessionSummary> = document
        .get("sessions")
        .and_then(Value::as_array)
        .map(|sessions| {
            sessions
                .iter()
                .filter(|value| is_session_summary(value))
                .filter(|value| {
                    value
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(is_safe_session_id)
                })
                .filter_map(|value| serde_json::from_value(value.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    let active_session_id = document
        .get("activeSessionId")
        .and_then(Value::as_str)
        .filter(|id| sessions.iter().any(|session| session.id == *id))
        .map(ToOwned::to_owned)
        .or_else(|| sessions.first().map(|session| session.id.clone()));

    Ok(HistoryIndex {
        active_session_id,
        sessions,
    })
}

fn parse_session(raw: &str) -> Result<Vec<StoredMessage>, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let document = parsed
        .as_object()
        .ok_or_else(|| "The session document is not an object.".to_owned())?;
    let messages = document
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "The session document has invalid messages.".to_owned())?;

    if !messages.iter().all(is_stored_message) {
        return Err("The session document has invalid messages.".to_owned());
    }

    Ok(messages
        .iter()
        .map(normalize_stored_message)
        .collect::<Vec<_>>())
}

const SESSION_ID_LIMIT: usize = 128;

/// Session ids become file names, so a persisted index may only name safe single components.
fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= SESSION_ID_LIMIT
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn is_session_summary(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };
    ["id", "title", "createdAt", "updatedAt"]
        .iter()
        .all(|key| record.get(*key).is_some_and(Value::is_string))
}

fn is_stored_message(value: &Value) -> bool {
    let Some(record) = value.as_object() else {
        return false;
    };

    let role_valid = matches!(
        record.get("role").and_then(Value::as_str),
        Some("user" | "assistant")
    );
    let status_valid = matches!(
        record.get("status").and_then(Value::as_str),
        Some("complete" | "streaming" | "failed" | "interrupted")
    );

    ["id", "content", "createdAt"]
        .iter()
        .all(|key| record.get(*key).is_some_and(Value::is_string))
        && role_valid
        && status_valid
}

fn normalize_stored_message(value: &Value) -> StoredMessage {
    let record = value.as_object().expect("validated message object");
    let role = match record.get("role").and_then(Value::as_str) {
        Some("user") => MessageRole::User,
        _ => MessageRole::Assistant,
    };
    let status = match record.get("status").and_then(Value::as_str) {
        Some("streaming") => MessageStatus::Streaming,
        Some("failed") => MessageStatus::Failed,
        Some("interrupted") => MessageStatus::Interrupted,
        _ => MessageStatus::Complete,
    };

    StoredMessage {
        id: record
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        role,
        content: record
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        created_at: record
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        status,
        error: record.get("error").and_then(parse_stored_error),
        metadata: record.get("metadata").and_then(normalize_response_metadata),
    }
}

fn parse_stored_error(value: &Value) -> Option<StoredError> {
    let record = value.as_object()?;
    let code = record.get("code")?.as_str()?.to_owned();
    let message = record.get("message")?.as_str()?.to_owned();
    Some(StoredError { code, message })
}

fn preserve_corrupt_file(path: &Path) {
    let suffix = Utc::now().format("%Y%m%d%H%M%S%3f").to_string();
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "history".to_owned());
    let target = path.with_file_name(format!("{file_name}.corrupt-{suffix}"));
    let _ = fs::rename(path, target);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ResponseMetadata, SessionSummary, StoredMessage};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn temporary_directory() -> PathBuf {
        tempfile::tempdir().expect("temp dir").keep()
    }

    fn summary(id: &str) -> SessionSummary {
        SessionSummary {
            id: id.to_owned(),
            title: "Chat".to_owned(),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
            custom_title: false,
        }
    }

    fn message(id: &str) -> StoredMessage {
        StoredMessage {
            id: id.to_owned(),
            role: MessageRole::Assistant,
            content: "hello".to_owned(),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            status: MessageStatus::Complete,
            error: None,
            metadata: None,
        }
    }

    #[test]
    fn round_trips_the_index() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        let index = HistoryIndex {
            active_session_id: Some("session-1".to_owned()),
            sessions: vec![summary("session-1"), summary("session-2")],
        };

        store.save_index(&index).expect("save");
        let loaded = store.load_index();

        assert_eq!(loaded.index, index);
        assert!(loaded.warning.is_none());
    }

    #[test]
    fn loads_an_index_without_custom_title_metadata() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        fs::write(
            store.index_path(),
            r#"{"version":1,"activeSessionId":"session-1","sessions":[{"id":"session-1","title":"Old chat","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]}"#,
        )
        .expect("seed");

        let loaded = store.load_index();

        assert!(loaded.warning.is_none());
        assert_eq!(loaded.index.sessions.len(), 1);
        assert!(!loaded.index.sessions[0].custom_title);
        assert_eq!(loaded.index.sessions[0].title, "Old chat");
    }

    #[test]
    fn round_trips_custom_title_metadata() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        let mut renamed = summary("session-1");
        renamed.title = "Renamed".to_owned();
        renamed.custom_title = true;
        let index = HistoryIndex {
            active_session_id: Some("session-1".to_owned()),
            sessions: vec![renamed],
        };

        store.save_index(&index).expect("save");
        let loaded = store.load_index();

        assert_eq!(loaded.index, index);
        assert!(loaded.index.sessions[0].custom_title);
    }

    #[test]
    fn treats_a_missing_index_as_empty() {
        let directory = temporary_directory();
        let loaded = HistoryStore::new(&directory).load_index();
        assert_eq!(loaded.index, HistoryIndex::default());
    }

    #[test]
    fn preserves_a_corrupt_index() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        fs::write(store.index_path(), "not json").expect("seed");

        let loaded = store.load_index();

        assert!(loaded.index.sessions.is_empty());
        assert!(loaded.warning.is_some());
        assert!(fs::read_dir(&directory)
            .expect("dir")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
    }

    #[test]
    fn round_trips_a_session() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        let messages = vec![message("message-1")];

        store.save_session("session-1", &messages).expect("save");
        let loaded = store.load_session("session-1");

        assert_eq!(loaded.messages, messages);
        assert!(loaded.warning.is_none());
    }

    #[test]
    fn preserves_a_corrupt_session() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        fs::write(store.session_path("session-1"), "{not json").expect("seed");

        let loaded = store.load_session("session-1");

        assert!(loaded.messages.is_empty());
        assert!(loaded.warning.is_some());
        assert!(fs::read_dir(&directory)
            .expect("dir")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
    }

    #[test]
    fn rejects_a_session_with_invalid_messages() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        fs::write(
            store.session_path("session-1"),
            json!({ "version": 1, "sessionId": "session-1", "messages": [{ "id": "x" }] })
                .to_string(),
        )
        .expect("seed");

        let loaded = store.load_session("session-1");

        assert!(loaded.messages.is_empty());
        assert!(loaded.warning.is_some());
    }

    #[test]
    fn loads_a_pre_metadata_document() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        fs::write(
            store.session_path("session-1"),
            r#"{"version":1,"sessionId":"session-1","messages":[{"id":"old-message","role":"assistant","content":"old answer","createdAt":"2025-01-01T00:00:00.000Z","status":"complete"}]}"#,
        )
        .expect("seed");

        let loaded = store.load_session("session-1");

        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].id, "old-message");
        assert!(loaded.messages[0].metadata.is_none());
        assert!(loaded.warning.is_none());
    }

    #[test]
    fn keeps_a_message_with_unusable_metadata() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        fs::write(
            store.session_path("session-1"),
            r#"{"version":1,"sessionId":"session-1","messages":[{"id":"kept","role":"assistant","content":"kept answer","createdAt":"2026-01-01T00:00:00.000Z","status":"complete","metadata":{"schema":"1","generated_at":"not a date","latency_ms":-1}}]}"#,
        )
        .expect("seed");

        let loaded = store.load_session("session-1");

        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].id, "kept");
        assert!(loaded.messages[0].metadata.is_none());
        assert!(loaded.warning.is_none());
    }

    #[test]
    fn drops_unknown_metadata_fields() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        fs::write(
            store.session_path("session-1"),
            r#"{"version":1,"sessionId":"session-1","messages":[{"id":"m1","role":"assistant","content":"answer","createdAt":"2026-01-01T00:00:00.000Z","status":"complete","metadata":{"schema":1,"generated_at":"2026-11-21T12:00:00.000Z","latency_ms":812,"unknown_top":"dropped","usage":{"input_tokens":1200,"unknown_counter":4}}}]}"#,
        )
        .expect("seed");

        let loaded = store.load_session("session-1");
        let metadata: &ResponseMetadata = loaded.messages[0].metadata.as_ref().expect("metadata");

        let usage = metadata.usage.as_ref().expect("usage");
        assert_eq!(
            usage.input_tokens.as_ref().map(|value| value.to_string()),
            Some("1200".to_owned())
        );
        assert!(usage.output_tokens.is_none());
    }
    #[test]
    fn drops_persisted_index_entries_with_traversal_ids() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        let raw = json!({
            "version": 1,
            "activeSessionId": "../escape",
            "sessions": [
                { "id": "safe-session", "title": "Safe", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
                { "id": "../escape", "title": "Escape", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
                { "id": "a/b", "title": "Slash", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            ]
        })
        .to_string();
        fs::write(store.index_path(), raw).expect("seed");

        let loaded = store.load_index();

        assert_eq!(
            loaded
                .index
                .sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            vec!["safe-session"]
        );
        assert_eq!(
            loaded.index.active_session_id.as_deref(),
            Some("safe-session"),
            "an unsafe active id must fall back to the first safe session"
        );
    }

    #[test]
    fn keeps_loading_when_every_persisted_id_is_unsafe() {
        let directory = temporary_directory();
        let store = HistoryStore::new(&directory);
        let raw = json!({
            "version": 1,
            "activeSessionId": "../../../etc/passwd",
            "sessions": [
                { "id": "../../../etc/passwd", "title": "Escape", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
            ]
        })
        .to_string();
        fs::write(store.index_path(), raw).expect("seed");

        let loaded = store.load_index();

        assert!(loaded.index.sessions.is_empty());
        assert!(loaded.index.active_session_id.is_none());
    }
}
