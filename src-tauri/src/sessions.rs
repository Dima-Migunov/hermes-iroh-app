use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::errors::{AppError, ErrorCode};
use crate::protocol::{
    MessageRole, MessageStatus, ResponseMetadata, SessionSnapshot, SessionSummary, StoredError,
    StoredMessage,
};
use crate::storage::history::{HistoryIndex, HistoryStore};

pub const FALLBACK_TITLE: &str = "New chat";
const TITLE_LIMIT: usize = 60;
const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(250);

pub type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;
pub type IdFactory = Arc<dyn Fn() -> String + Send + Sync>;
pub type ChangeListener = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct SessionStoreOptions {
    pub debounce: Duration,
    pub now: Option<Clock>,
    pub id_factory: Option<IdFactory>,
}

impl Default for SessionStoreOptions {
    fn default() -> Self {
        Self {
            debounce: DEFAULT_DEBOUNCE,
            now: None,
            id_factory: None,
        }
    }
}

struct Inner {
    history: HistoryStore,
    now: Clock,
    id_factory: IdFactory,
    debounce: Duration,
    index: HistoryIndex,
    messages: HashMap<String, Vec<StoredMessage>>,
    timers: HashMap<String, u64>,
    warnings: Vec<String>,
    listener: Option<ChangeListener>,
}

#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<Inner>>,
}

impl SessionStore {
    pub fn new(history: HistoryStore, options: SessionStoreOptions) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                history,
                now: options.now.unwrap_or_else(|| Arc::new(Utc::now)),
                id_factory: options
                    .id_factory
                    .unwrap_or_else(|| Arc::new(|| Uuid::new_v4().to_string())),
                debounce: options.debounce,
                index: HistoryIndex::default(),
                messages: HashMap::new(),
                timers: HashMap::new(),
                warnings: Vec::new(),
                listener: None,
            })),
        }
    }

    pub async fn initialize(&self) -> Result<(), AppError> {
        let mut inner = self.inner.lock().await;

        let loaded = inner.history.load_index();
        if let Some(warning) = loaded.warning {
            inner.warnings.push(warning);
        }
        inner.index = loaded.index;

        if inner.index.sessions.is_empty() {
            let session = build_session(&inner);
            inner.index.sessions.push(session.clone());
            inner.index.active_session_id = Some(session.id.clone());
            inner.messages.insert(session.id.clone(), Vec::new());
            inner
                .history
                .save_session(&session.id, &[])
                .map_err(history_save_error)?;
            inner
                .history
                .save_index(&inner.index)
                .map_err(history_save_error)?;
        }

        let active_is_valid = inner
            .index
            .active_session_id
            .as_ref()
            .is_some_and(|active| {
                inner
                    .index
                    .sessions
                    .iter()
                    .any(|session| &session.id == active)
            });

        if !active_is_valid {
            inner.index.active_session_id = inner
                .index
                .sessions
                .first()
                .map(|session| session.id.clone());
        }

        if let Some(active) = inner.index.active_session_id.clone() {
            load_session_locked(&mut inner, &active);
        }

        inner
            .history
            .save_index(&inner.index)
            .map_err(history_save_error)?;

        Ok(())
    }

    pub async fn get_warnings(&self) -> Vec<String> {
        self.inner.lock().await.warnings.clone()
    }

    pub async fn set_change_listener(&self, listener: ChangeListener) {
        self.inner.lock().await.listener = Some(listener);
    }

    pub async fn list(&self) -> Vec<SessionSummary> {
        let inner = self.inner.lock().await;
        let mut sessions = inner.index.sessions.clone();
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        sessions
    }

    pub async fn get_active_session_id(&self) -> Option<String> {
        self.inner.lock().await.index.active_session_id.clone()
    }

    pub async fn has_session(&self, session_id: &str) -> bool {
        self.inner
            .lock()
            .await
            .index
            .sessions
            .iter()
            .any(|session| session.id == session_id)
    }

    pub async fn get_snapshot(&self, session_id: &str) -> Result<SessionSnapshot, AppError> {
        let mut inner = self.inner.lock().await;
        ensure_session(&inner, session_id)?;
        load_session_locked(&mut inner, session_id);
        snapshot_locked(&inner, session_id)
    }

    pub async fn get_active_snapshot(&self) -> Result<SessionSnapshot, AppError> {
        let mut inner = self.inner.lock().await;
        let session_id = inner
            .index
            .active_session_id
            .clone()
            .ok_or_else(|| AppError::not_found("No active session is available."))?;
        ensure_session(&inner, &session_id)?;
        load_session_locked(&mut inner, &session_id);
        snapshot_locked(&inner, &session_id)
    }

    pub async fn create(&self) -> Result<SessionSummary, AppError> {
        let (session, listener) = {
            let mut inner = self.inner.lock().await;
            let session = build_session(&inner);
            inner.index.sessions.push(session.clone());
            inner.index.active_session_id = Some(session.id.clone());
            inner.messages.insert(session.id.clone(), Vec::new());
            inner
                .history
                .save_session(&session.id, &[])
                .map_err(history_save_error)?;
            inner
                .history
                .save_index(&inner.index)
                .map_err(history_save_error)?;
            (session, inner.listener.clone())
        };

        notify(listener);
        Ok(session)
    }

    pub async fn activate(&self, session_id: &str) -> Result<SessionSnapshot, AppError> {
        let (snapshot, listener) = {
            let mut inner = self.inner.lock().await;
            ensure_session(&inner, session_id)?;
            load_session_locked(&mut inner, session_id);
            inner.index.active_session_id = Some(session_id.to_owned());
            inner
                .history
                .save_index(&inner.index)
                .map_err(history_save_error)?;
            (snapshot_locked(&inner, session_id)?, inner.listener.clone())
        };

        notify(listener);
        Ok(snapshot)
    }

    pub async fn append_user_message(
        &self,
        session_id: &str,
        text: &str,
    ) -> Result<StoredMessage, AppError> {
        let (message, listener) = {
            let mut inner = self.inner.lock().await;
            ensure_session(&inner, session_id)?;
            load_session_locked(&mut inner, session_id);

            let created_at = now_iso(&inner);
            let message = StoredMessage {
                id: (inner.id_factory)(),
                role: MessageRole::User,
                content: text.to_owned(),
                created_at: created_at.clone(),
                status: MessageStatus::Complete,
                error: None,
                metadata: None,
            };

            let is_first_user_message = {
                let messages = inner.messages.entry(session_id.to_owned()).or_default();
                let is_first = !messages.iter().any(|entry| entry.role == MessageRole::User);
                messages.push(message.clone());
                is_first
            };

            if is_first_user_message {
                if let Some(session) = inner
                    .index
                    .sessions
                    .iter_mut()
                    .find(|session| session.id == session_id)
                {
                    session.title = derive_title(text);
                }
            }
            touch_session(&mut inner, session_id, &created_at);

            let messages = inner
                .messages
                .get(session_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            inner
                .history
                .save_session(session_id, messages)
                .map_err(history_save_error)?;
            inner
                .history
                .save_index(&inner.index)
                .map_err(history_save_error)?;

            (message, inner.listener.clone())
        };

        notify(listener);
        Ok(message)
    }

    pub async fn begin_assistant_message(
        &self,
        session_id: &str,
    ) -> Result<StoredMessage, AppError> {
        let mut inner = self.inner.lock().await;
        ensure_session(&inner, session_id)?;
        load_session_locked(&mut inner, session_id);

        let created_at = now_iso(&inner);
        let message = StoredMessage {
            id: (inner.id_factory)(),
            role: MessageRole::Assistant,
            content: String::new(),
            created_at: created_at.clone(),
            status: MessageStatus::Streaming,
            error: None,
            metadata: None,
        };

        inner
            .messages
            .entry(session_id.to_owned())
            .or_default()
            .push(message.clone());
        touch_session(&mut inner, session_id, &created_at);
        schedule_save(&mut inner, &self.inner, session_id);

        Ok(message)
    }

    pub async fn append_delta(&self, session_id: &str, message_id: &str, content: &str) {
        let mut inner = self.inner.lock().await;
        let Some(messages) = inner.messages.get_mut(session_id) else {
            return;
        };
        let Some(message) = messages.iter_mut().find(|message| message.id == message_id) else {
            return;
        };

        message.content.push_str(content);
        let updated_at = now_iso(&inner);
        touch_session(&mut inner, session_id, &updated_at);
        schedule_save(&mut inner, &self.inner, session_id);
    }

    pub async fn complete_assistant(
        &self,
        session_id: &str,
        message_id: &str,
        metadata: Option<ResponseMetadata>,
    ) -> Result<(), AppError> {
        let listener = {
            let mut inner = self.inner.lock().await;
            let updated_at = now_iso(&inner);

            if let Some(messages) = inner.messages.get_mut(session_id) {
                if let Some(message) = messages.iter_mut().find(|entry| entry.id == message_id) {
                    message.status = MessageStatus::Complete;
                    if metadata.is_some() {
                        message.metadata = metadata;
                    }
                }
            }
            touch_session(&mut inner, session_id, &updated_at);

            flush_session_locked(&mut inner, session_id)?;
            inner.listener.clone()
        };

        notify(listener);
        Ok(())
    }

    pub async fn interrupt_assistant(
        &self,
        session_id: &str,
        message_id: Option<&str>,
    ) -> Result<(), AppError> {
        let listener = {
            let mut inner = self.inner.lock().await;
            let updated_at = now_iso(&inner);

            if let Some(message_id) = message_id {
                if let Some(messages) = inner.messages.get_mut(session_id) {
                    if let Some(message) = messages.iter_mut().find(|entry| entry.id == message_id)
                    {
                        message.status = MessageStatus::Interrupted;
                    }
                }
            }
            touch_session(&mut inner, session_id, &updated_at);

            flush_session_locked(&mut inner, session_id)?;
            inner.listener.clone()
        };

        notify(listener);
        Ok(())
    }

    pub async fn fail_request(
        &self,
        session_id: &str,
        assistant_message_id: Option<&str>,
        code: ErrorCode,
        message: &str,
    ) -> Result<(), AppError> {
        let listener = {
            let mut inner = self.inner.lock().await;
            let error = StoredError {
                code: code.as_str().to_owned(),
                message: message.to_owned(),
            };

            if let Some(messages) = inner.messages.get_mut(session_id) {
                if let Some(assistant_id) = assistant_message_id {
                    if let Some(assistant) =
                        messages.iter_mut().find(|entry| entry.id == assistant_id)
                    {
                        assistant.status = MessageStatus::Failed;
                        assistant.error = Some(error.clone());
                    }
                }

                if let Some(user) = messages
                    .iter_mut()
                    .rev()
                    .find(|entry| entry.role == MessageRole::User)
                {
                    user.status = MessageStatus::Failed;
                    user.error = Some(error);
                }
            }

            flush_session_locked(&mut inner, session_id)?;
            inner.listener.clone()
        };

        notify(listener);
        Ok(())
    }

    pub async fn flush(&self, session_id: &str) -> Result<(), AppError> {
        let mut inner = self.inner.lock().await;
        flush_session_locked(&mut inner, session_id)
    }

    pub async fn flush_all(&self) -> Result<(), AppError> {
        let mut inner = self.inner.lock().await;
        inner.timers.clear();
        let session_ids: Vec<String> = inner.messages.keys().cloned().collect();
        for session_id in session_ids {
            if let Some(messages) = inner.messages.get(&session_id) {
                inner
                    .history
                    .save_session(&session_id, messages)
                    .map_err(history_save_error)?;
            }
        }
        inner
            .history
            .save_index(&inner.index)
            .map_err(history_save_error)?;
        Ok(())
    }
}

fn build_session(inner: &Inner) -> SessionSummary {
    let timestamp = now_iso(inner);
    SessionSummary {
        id: (inner.id_factory)(),
        title: FALLBACK_TITLE.to_owned(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    }
}

fn now_iso(inner: &Inner) -> String {
    (inner.now)().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn ensure_session(inner: &Inner, session_id: &str) -> Result<(), AppError> {
    if inner
        .index
        .sessions
        .iter()
        .any(|session| session.id == session_id)
    {
        Ok(())
    } else {
        Err(AppError::not_found(format!(
            "Session \"{session_id}\" does not exist."
        )))
    }
}

fn touch_session(inner: &mut Inner, session_id: &str, timestamp: &str) {
    if let Some(session) = inner
        .index
        .sessions
        .iter_mut()
        .find(|session| session.id == session_id)
    {
        session.updated_at = timestamp.to_owned();
    }
}

fn load_session_locked(inner: &mut Inner, session_id: &str) {
    if inner.messages.contains_key(session_id) {
        return;
    }

    let loaded = inner.history.load_session(session_id);
    if let Some(warning) = loaded.warning {
        inner.warnings.push(warning);
    }

    let mut recovered = false;
    let messages: Vec<StoredMessage> = loaded
        .messages
        .into_iter()
        .map(|mut message| {
            if message.status == MessageStatus::Streaming {
                recovered = true;
                message.status = MessageStatus::Interrupted;
            }
            message
        })
        .collect();

    inner.messages.insert(session_id.to_owned(), messages);
    if recovered {
        let messages = inner
            .messages
            .get(session_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let _ = inner.history.save_session(session_id, messages);
    }
}

fn snapshot_locked(inner: &Inner, session_id: &str) -> Result<SessionSnapshot, AppError> {
    let session = inner
        .index
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .cloned()
        .ok_or_else(|| AppError::not_found(format!("Session \"{session_id}\" does not exist.")))?;

    Ok(SessionSnapshot {
        session,
        messages: inner.messages.get(session_id).cloned().unwrap_or_default(),
    })
}

fn schedule_save(inner: &mut Inner, store: &Arc<Mutex<Inner>>, session_id: &str) {
    let generation = inner.timers.get(session_id).copied().unwrap_or(0) + 1;
    inner.timers.insert(session_id.to_owned(), generation);

    let store = Arc::clone(store);
    let session_id = session_id.to_owned();
    let debounce = inner.debounce;

    tokio::spawn(async move {
        tokio::time::sleep(debounce).await;
        let mut inner = store.lock().await;
        if inner.timers.get(&session_id).copied() != Some(generation) {
            return;
        }
        inner.timers.remove(&session_id);

        let messages = inner.messages.get(&session_id).cloned().unwrap_or_default();
        let _ = inner.history.save_session(&session_id, &messages);
        let _ = inner.history.save_index(&inner.index);
    });
}

fn flush_session_locked(inner: &mut Inner, session_id: &str) -> Result<(), AppError> {
    inner.timers.remove(session_id);
    if let Some(messages) = inner.messages.get(session_id).cloned() {
        inner
            .history
            .save_session(session_id, &messages)
            .map_err(history_save_error)?;
    }
    inner
        .history
        .save_index(&inner.index)
        .map_err(history_save_error)?;
    Ok(())
}

fn history_save_error(error: String) -> AppError {
    AppError::internal(format!("Chat history could not be saved: {error}"))
}

fn notify(listener: Option<ChangeListener>) {
    if let Some(listener) = listener {
        listener();
    }
}

pub fn derive_title(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return FALLBACK_TITLE.to_owned();
    }
    if normalized.chars().count() <= TITLE_LIMIT {
        return normalized;
    }

    let mut truncated: String = normalized.chars().take(TITLE_LIMIT - 1).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::history::HistoryStore;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
    use std::sync::Arc;

    struct Harness {
        directory: PathBuf,
        store: SessionStore,
    }

    fn harness(debounce_ms: u64) -> Harness {
        let directory = tempfile::tempdir().expect("temp dir").keep();
        let history = HistoryStore::new(directory.join("history"));
        let sequence = Arc::new(AtomicU64::new(0));
        let tick = Arc::new(AtomicI64::new(0));
        let store = SessionStore::new(
            history,
            SessionStoreOptions {
                debounce: Duration::from_millis(debounce_ms),
                id_factory: Some(Arc::new(move || {
                    format!("id-{}", sequence.fetch_add(1, Ordering::Relaxed) + 1)
                })),
                now: Some(Arc::new(move || {
                    let seconds = tick.fetch_add(1, Ordering::Relaxed) + 1;
                    DateTime::from_timestamp(1767225600 + seconds, 0).expect("timestamp")
                })),
            },
        );
        Harness { directory, store }
    }

    async fn reopen(directory: &Path) -> SessionStore {
        let store = SessionStore::new(
            HistoryStore::new(directory.join("history")),
            SessionStoreOptions {
                debounce: Duration::from_millis(5),
                ..Default::default()
            },
        );
        store.initialize().await.expect("initialize");
        store
    }

    #[tokio::test]
    async fn creates_one_default_empty_session_on_first_launch() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");

        let sessions = harness.store.list().await;
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, FALLBACK_TITLE);
        assert_eq!(
            harness.store.get_active_session_id().await.as_deref(),
            Some(sessions[0].id.as_str())
        );
        assert!(harness
            .store
            .get_active_snapshot()
            .await
            .expect("snapshot")
            .messages
            .is_empty());
    }

    #[tokio::test]
    async fn restores_the_active_session_and_messages_after_restart() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let active = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&active, "hello there")
            .await
            .expect("append");

        let reopened = reopen(&harness.directory).await;

        assert_eq!(
            reopened.get_active_session_id().await.as_deref(),
            Some(active.as_str())
        );
        let snapshot = reopened.get_active_snapshot().await.expect("snapshot");
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].content, "hello there");
    }

    #[tokio::test]
    async fn isolates_messages_between_sessions() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let first = harness.store.get_active_session_id().await.expect("active");
        let second = harness.store.create().await.expect("create");

        harness
            .store
            .append_user_message(&second.id, "session B")
            .await
            .expect("append b");
        harness
            .store
            .append_user_message(&first, "session A")
            .await
            .expect("append a");

        let first_snapshot = harness.store.get_snapshot(&first).await.expect("first");
        let second_snapshot = harness
            .store
            .get_snapshot(&second.id)
            .await
            .expect("second");
        assert_eq!(first_snapshot.messages[0].content, "session A");
        assert_eq!(second_snapshot.messages[0].content, "session B");
    }

    #[tokio::test]
    async fn derives_and_truncates_titles() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");

        harness
            .store
            .append_user_message(&session_id, "  hello   world  ")
            .await
            .expect("append");
        assert_eq!(harness.store.list().await[0].title, "hello world");

        let long = harness.store.create().await.expect("create");
        harness
            .store
            .append_user_message(&long.id, &"x".repeat(120))
            .await
            .expect("append long");
        let title = harness
            .store
            .list()
            .await
            .into_iter()
            .find(|session| session.id == long.id)
            .expect("session")
            .title;
        assert!(title.chars().count() <= TITLE_LIMIT);
        assert!(title.ends_with('…'));
    }

    #[tokio::test]
    async fn orders_sessions_by_most_recent_activity() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let first = harness.store.get_active_session_id().await.expect("active");
        harness.store.create().await.expect("create");
        harness
            .store
            .append_user_message(&first, "activity")
            .await
            .expect("append");

        assert_eq!(harness.store.list().await[0].id, first);
    }

    #[tokio::test]
    async fn marks_a_streaming_message_interrupted_on_load() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        let history = HistoryStore::new(harness.directory.join("history"));
        history
            .save_session(
                &session_id,
                &[StoredMessage {
                    id: "assistant-1".to_owned(),
                    role: MessageRole::Assistant,
                    content: "partial".to_owned(),
                    created_at: "2026-01-01T00:00:00.000Z".to_owned(),
                    status: MessageStatus::Streaming,
                    error: None,
                    metadata: None,
                }],
            )
            .expect("seed");

        let reopened = reopen(&harness.directory).await;
        let snapshot = reopened.get_active_snapshot().await.expect("snapshot");

        assert_eq!(snapshot.messages[0].status, MessageStatus::Interrupted);
        assert_eq!(snapshot.messages[0].content, "partial");

        let raw: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(history.session_path(&session_id)).expect("read"),
        )
        .expect("json");
        assert_eq!(raw["messages"][0]["status"], "interrupted");
    }

    #[tokio::test]
    async fn retains_failed_messages_with_their_status_and_error() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "fail me")
            .await
            .expect("append");
        let assistant = harness
            .store
            .begin_assistant_message(&session_id)
            .await
            .expect("assistant");
        harness
            .store
            .append_delta(&session_id, &assistant.id, "partial")
            .await;
        harness
            .store
            .fail_request(
                &session_id,
                Some(&assistant.id),
                ErrorCode::Server,
                "the server failed",
            )
            .await
            .expect("fail");

        let reopened = reopen(&harness.directory).await;
        let snapshot = reopened.get_active_snapshot().await.expect("snapshot");

        let user = snapshot
            .messages
            .iter()
            .find(|message| message.role == MessageRole::User)
            .expect("user");
        let assistant = snapshot
            .messages
            .iter()
            .find(|message| message.role == MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(user.status, MessageStatus::Failed);
        assert_eq!(
            user.error.as_ref().map(|error| error.message.as_str()),
            Some("the server failed")
        );
        assert_eq!(assistant.status, MessageStatus::Failed);
        assert_eq!(assistant.content, "partial");
    }

    #[tokio::test]
    async fn persists_and_restores_assistant_metadata() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "hi")
            .await
            .expect("append");
        let assistant = harness
            .store
            .begin_assistant_message(&session_id)
            .await
            .expect("assistant");
        harness
            .store
            .append_delta(&session_id, &assistant.id, "Hello")
            .await;

        let metadata: ResponseMetadata = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812,
            "model": "gpt-5.1"
        }))
        .expect("metadata");
        harness
            .store
            .complete_assistant(&session_id, &assistant.id, Some(metadata.clone()))
            .await
            .expect("complete");

        let reopened = reopen(&harness.directory).await;
        let snapshot = reopened.get_active_snapshot().await.expect("snapshot");
        let restored = snapshot
            .messages
            .iter()
            .find(|message| message.role == MessageRole::Assistant)
            .expect("assistant");

        assert_eq!(restored.status, MessageStatus::Complete);
        assert_eq!(restored.content, "Hello");
        assert_eq!(restored.metadata, Some(metadata));
    }

    #[tokio::test]
    async fn interrupts_only_the_assistant_message_when_an_id_is_present() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "stop me")
            .await
            .expect("append");
        let assistant = harness
            .store
            .begin_assistant_message(&session_id)
            .await
            .expect("assistant");
        harness
            .store
            .append_delta(&session_id, &assistant.id, "partial answer")
            .await;

        harness
            .store
            .interrupt_assistant(&session_id, Some(&assistant.id))
            .await
            .expect("interrupt");

        let snapshot = harness
            .store
            .get_snapshot(&session_id)
            .await
            .expect("snapshot");
        let user = snapshot
            .messages
            .iter()
            .find(|message| message.role == MessageRole::User)
            .expect("user");
        let assistant = snapshot
            .messages
            .iter()
            .find(|message| message.role == MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(user.status, MessageStatus::Complete);
        assert_eq!(assistant.status, MessageStatus::Interrupted);
        assert_eq!(assistant.content, "partial answer");
    }

    #[tokio::test]
    async fn flushes_without_adding_a_message_when_no_assistant_id_is_given() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "stop me")
            .await
            .expect("append");

        harness
            .store
            .interrupt_assistant(&session_id, None)
            .await
            .expect("interrupt");

        let snapshot = harness
            .store
            .get_snapshot(&session_id)
            .await
            .expect("snapshot");
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].status, MessageStatus::Complete);
    }

    #[tokio::test]
    async fn flushes_streamed_deltas_to_disk() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        let assistant = harness
            .store
            .begin_assistant_message(&session_id)
            .await
            .expect("assistant");
        harness
            .store
            .append_delta(&session_id, &assistant.id, "streamed content")
            .await;

        harness.store.flush(&session_id).await.expect("flush");

        let history = HistoryStore::new(harness.directory.join("history"));
        let loaded = history.load_session(&session_id);
        assert_eq!(loaded.messages[0].content, "streamed content");
    }

    #[tokio::test]
    async fn rejects_an_unknown_session() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");

        let error = harness
            .store
            .append_user_message("missing", "hello")
            .await
            .expect_err("missing session");
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[test]
    fn normalizes_and_truncates_titles() {
        assert_eq!(derive_title("  hello   world  "), "hello world");
        assert_eq!(derive_title("   "), FALLBACK_TITLE);
        let title = derive_title(&"x".repeat(120));
        assert_eq!(title.chars().count(), TITLE_LIMIT);
        assert!(title.ends_with('…'));
    }

    #[tokio::test]
    async fn exit_flush_persists_a_streaming_message_that_reopens_as_interrupted() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "quit mid-stream")
            .await
            .expect("append");
        let assistant = harness
            .store
            .begin_assistant_message(&session_id)
            .await
            .expect("assistant");
        harness
            .store
            .append_delta(&session_id, &assistant.id, "partial before quit")
            .await;

        harness.store.flush_all().await.expect("flush all");

        let history = HistoryStore::new(harness.directory.join("history"));
        let persisted = history.load_session(&session_id);
        assert_eq!(persisted.messages[1].status, MessageStatus::Streaming);
        assert_eq!(persisted.messages[1].content, "partial before quit");

        let reopened = reopen(&harness.directory).await;
        let snapshot = reopened.get_snapshot(&session_id).await.expect("snapshot");
        assert_eq!(snapshot.messages[1].status, MessageStatus::Interrupted);
        assert_eq!(snapshot.messages[1].content, "partial before quit");
    }
}
