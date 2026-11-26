use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::errors::{AppError, ErrorCode};
use crate::protocol::{
    MessageRole, MessageStatus, ResponseMetadata, SessionDeletionResult, SessionSnapshot,
    SessionSummary, StoredError, StoredMessage,
};
use crate::storage::history::{write_document, HistoryIndex, HistoryStore};

pub const FALLBACK_TITLE: &str = "New chat";
pub const TITLE_LIMIT: usize = 60;
const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(250);
const MAX_CACHED_SESSIONS: usize = 5;
const MAX_WARNINGS: usize = 20;

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
    /// Most-recently-used first. Only clean sessions (no timer, not dirty) are evicted.
    usage: Vec<String>,
    dirty: HashSet<String>,
    timers: HashMap<String, tokio::task::JoinHandle<()>>,
    /// One write lock per session so writes never overlap or reorder.
    write_locks: HashMap<String, Arc<Mutex<()>>>,
    /// Sessions whose transcript is being deleted. Writes prepared before the deletion
    /// must not recreate the file afterwards.
    deleting: HashSet<String>,
    index_dirty: bool,
    warnings: Vec<String>,
    listener: Option<ChangeListener>,
}

#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<Inner>>,
}

/// Bytes to write after the store lock is released.
struct PreparedWrite {
    store: Arc<Mutex<Inner>>,
    history: HistoryStore,
    write_lock: Arc<Mutex<()>>,
    session_id: String,
    session_bytes: Vec<u8>,
    index_bytes: Option<Vec<u8>>,
}

impl PreparedWrite {
    async fn execute(self) -> Result<(), AppError> {
        let _guard = self.write_lock.lock().await;
        {
            let inner = self.store.lock().await;
            let exists = inner
                .index
                .sessions
                .iter()
                .any(|session| session.id == self.session_id);
            if inner.deleting.contains(&self.session_id) || !exists {
                return Ok(());
            }
        }

        let PreparedWrite {
            history,
            session_id,
            session_bytes,
            index_bytes,
            ..
        } = self;

        tokio::task::spawn_blocking(move || -> Result<(), String> {
            write_document(&history.session_path(&session_id), &session_bytes)?;
            if let Some(bytes) = index_bytes {
                write_document(&history.index_path(), &bytes)?;
            }
            Ok(())
        })
        .await
        .map_err(|error| AppError::internal(format!("The history writer failed. ({error})")))?
        .map_err(history_save_error)
    }
}

/// State captured under the store lock before a deletion is persisted.
struct DeletionPlan {
    session_id: String,
    previous_index: HistoryIndex,
    previous_index_dirty: bool,
    previous_usage: Vec<String>,
    previous_dirty: HashSet<String>,
    cached_before: HashSet<String>,
    deleted_messages: Option<Vec<StoredMessage>>,
    replacement_id: Option<String>,
    replacement_bytes: Option<Vec<u8>>,
    index_bytes: Vec<u8>,
    sessions: Vec<SessionSummary>,
    active_session: SessionSnapshot,
    history: HistoryStore,
    write_lock: Arc<Mutex<()>>,
    listener: Option<ChangeListener>,
}

/// Serializes a session snapshot under the store lock and prepares it for an off-runtime write.
/// A tombstoned session yields no write so a deletion is never undone by an older flush.
fn prepare_session_write(
    inner: &mut Inner,
    store: &Arc<Mutex<Inner>>,
    session_id: &str,
) -> Result<Option<PreparedWrite>, AppError> {
    if let Some(handle) = inner.timers.remove(session_id) {
        handle.abort();
    }

    if inner.deleting.contains(session_id) {
        inner.dirty.remove(session_id);
        return Ok(None);
    }

    let Some(messages) = inner.messages.get(session_id).cloned() else {
        inner.dirty.remove(session_id);
        return Err(AppError::internal(format!(
            "Session \"{session_id}\" is not cached."
        )));
    };

    let session_bytes =
        HistoryStore::session_document(session_id, &messages).map_err(history_save_error)?;
    let index_bytes = if inner.index_dirty {
        Some(HistoryStore::index_document(&inner.index).map_err(history_save_error)?)
    } else {
        None
    };

    let write_lock = Arc::clone(
        inner
            .write_locks
            .entry(session_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    );

    Ok(Some(PreparedWrite {
        store: Arc::clone(store),
        history: inner.history.clone(),
        write_lock,
        session_id: session_id.to_owned(),
        session_bytes,
        index_bytes,
    }))
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
                usage: Vec::new(),
                dirty: HashSet::new(),
                timers: HashMap::new(),
                write_locks: HashMap::new(),
                deleting: HashSet::new(),
                index_dirty: false,
                warnings: Vec::new(),
                listener: None,
            })),
        }
    }

    pub async fn initialize(&self) -> Result<(), AppError> {
        let mut inner = self.inner.lock().await;

        let loaded = inner.history.load_index();
        if let Some(warning) = loaded.warning {
            push_warning(&mut inner, warning);
        }
        inner.index = loaded.index;

        let mut initial_session = None;
        if inner.index.sessions.is_empty() {
            let session = build_session(&inner);
            inner.index.sessions.push(session.clone());
            inner.index.active_session_id = Some(session.id.clone());
            cache_messages(&mut inner, &session.id, Vec::new());
            inner.index_dirty = true;
            initial_session = Some(session.id);
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
            inner.index_dirty = true;
        }

        let mut recovered_active = None;
        if let Some(active) = inner.index.active_session_id.clone() {
            recovered_active = load_session_inner(&mut inner, &active);
        }
        drop(inner);

        if let Some(active) = recovered_active {
            let _ = flush_session(&self.inner, &active).await;
        }

        if let Some(session_id) = initial_session {
            flush_session(&self.inner, &session_id).await?;
        }
        flush_index(&self.inner).await
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
        let snapshot = {
            let mut inner = self.inner.lock().await;
            ensure_session(&inner, session_id)?;
            let recovered = load_session_inner(&mut inner, session_id);
            let snapshot = snapshot_locked(&inner, session_id)?;
            (snapshot, recovered)
        };
        if snapshot.1.is_some() {
            let _ = flush_session(&self.inner, session_id).await;
        }
        Ok(snapshot.0)
    }

    pub async fn get_active_snapshot(&self) -> Result<SessionSnapshot, AppError> {
        let session_id = self
            .inner
            .lock()
            .await
            .index
            .active_session_id
            .clone()
            .ok_or_else(|| AppError::not_found("No active session is available."))?;
        self.get_snapshot(&session_id).await
    }

    pub async fn create(&self) -> Result<SessionSummary, AppError> {
        let (session, session_id, listener) = {
            let mut inner = self.inner.lock().await;
            let session = build_session(&inner);
            inner.index.sessions.push(session.clone());
            inner.index.active_session_id = Some(session.id.clone());
            cache_messages(&mut inner, &session.id, Vec::new());
            inner.index_dirty = true;
            let session_id = session.id.clone();
            (session, session_id, inner.listener.clone())
        };

        flush_session(&self.inner, &session_id).await?;
        flush_index(&self.inner).await?;
        notify(listener);
        Ok(session)
    }

    pub async fn activate(&self, session_id: &str) -> Result<SessionSnapshot, AppError> {
        let (snapshot, listener) = {
            let mut inner = self.inner.lock().await;
            ensure_session(&inner, session_id)?;
            load_session_locked(&mut inner, session_id);
            inner.index.active_session_id = Some(session_id.to_owned());
            inner.index_dirty = true;
            (snapshot_locked(&inner, session_id)?, inner.listener.clone())
        };

        flush_index(&self.inner).await?;
        notify(listener);
        Ok(snapshot)
    }

    /// Renames a session without touching its timestamps or position in the list.
    pub async fn rename(&self, session_id: &str, title: &str) -> Result<SessionSummary, AppError> {
        let normalized = normalize_title(title)?;

        let (summary, previous, listener) = {
            let mut inner = self.inner.lock().await;
            let (summary, previous) = {
                let session = inner
                    .index
                    .sessions
                    .iter_mut()
                    .find(|session| session.id == session_id)
                    .ok_or_else(|| {
                        AppError::not_found(format!("Session \"{session_id}\" does not exist."))
                    })?;
                let previous = (session.title.clone(), session.custom_title);
                session.title = normalized.clone();
                session.custom_title = true;
                (session.clone(), previous)
            };
            inner.index_dirty = true;
            (summary, previous, inner.listener.clone())
        };

        if let Err(error) = flush_index(&self.inner).await {
            let mut inner = self.inner.lock().await;
            if let Some(session) = inner
                .index
                .sessions
                .iter_mut()
                .find(|session| session.id == session_id)
            {
                if session.title == normalized && session.custom_title {
                    session.title = previous.0;
                    session.custom_title = previous.1;
                }
            }
            inner.index_dirty = true;
            return Err(error);
        }

        notify(listener);
        Ok(summary)
    }

    /// Deletes a session and returns the remaining list with the newly active session.
    pub async fn delete(&self, session_id: &str) -> Result<SessionDeletionResult, AppError> {
        let plan = {
            let mut inner = self.inner.lock().await;

            ensure_session(&inner, session_id)?;

            let previous_index = inner.index.clone();
            let previous_index_dirty = inner.index_dirty;
            let previous_usage = inner.usage.clone();
            let previous_dirty = inner.dirty.clone();
            let cached_before: HashSet<String> = inner.messages.keys().cloned().collect();
            let deleted_messages = inner.messages.get(session_id).cloned();

            if let Some(handle) = inner.timers.remove(session_id) {
                handle.abort();
            }
            inner.deleting.insert(session_id.to_owned());

            inner
                .index
                .sessions
                .retain(|session| session.id != session_id);
            inner.messages.remove(session_id);
            inner.usage.retain(|id| id != session_id);
            inner.dirty.remove(session_id);

            let mut replacement_id = None;
            let mut replacement_bytes = None;
            if inner.index.sessions.is_empty() {
                let session = build_session(&inner);
                replacement_id = Some(session.id.clone());
                inner.index.sessions.push(session);
                inner.index.active_session_id = replacement_id.clone();
                let id = replacement_id.clone().expect("replacement id");
                cache_messages(&mut inner, &id, Vec::new());
                replacement_bytes =
                    Some(HistoryStore::session_document(&id, &[]).map_err(history_save_error)?);
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
                let mut remaining = inner.index.sessions.clone();
                remaining.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
                let next = remaining
                    .first()
                    .map(|session| session.id.clone())
                    .ok_or_else(|| AppError::internal("No session is available."))?;
                inner.index.active_session_id = Some(next);
            }

            let active_id = inner
                .index
                .active_session_id
                .clone()
                .ok_or_else(|| AppError::internal("No active session is available."))?;
            load_session_locked(&mut inner, &active_id);
            let active_session = snapshot_locked(&inner, &active_id)?;

            let mut sessions = inner.index.sessions.clone();
            sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
            inner.index_dirty = true;
            let index_bytes =
                HistoryStore::index_document(&inner.index).map_err(history_save_error)?;

            let write_lock = Arc::clone(
                inner
                    .write_locks
                    .entry(session_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            );

            DeletionPlan {
                session_id: session_id.to_owned(),
                previous_index,
                previous_index_dirty,
                previous_usage,
                previous_dirty,
                cached_before,
                deleted_messages,
                replacement_id,
                replacement_bytes,
                index_bytes,
                sessions,
                active_session,
                history: inner.history.clone(),
                write_lock,
                listener: inner.listener.clone(),
            }
        };

        let _guard = plan.write_lock.lock().await;
        let history = plan.history.clone();
        let index_path = history.index_path();
        let index_bytes = plan.index_bytes.clone();
        let replacement = plan
            .replacement_id
            .clone()
            .zip(plan.replacement_bytes.clone());

        let write_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            if let Some((id, bytes)) = replacement {
                write_document(&history.session_path(&id), &bytes)?;
            }
            write_document(&index_path, &index_bytes)?;
            Ok(())
        })
        .await
        .map_err(|error| AppError::internal(format!("The history writer failed. ({error})")))?
        .map_err(history_save_error);

        if let Err(error) = write_result {
            let replacement_path = plan
                .replacement_id
                .as_ref()
                .map(|id| plan.history.session_path(id));
            {
                let mut inner = self.inner.lock().await;
                inner.index = plan.previous_index;
                inner.index_dirty = plan.previous_index_dirty;
                inner.usage = plan.previous_usage;
                inner.dirty = plan.previous_dirty;

                let stale: Vec<String> = inner
                    .messages
                    .keys()
                    .filter(|id| !plan.cached_before.contains(*id))
                    .cloned()
                    .collect();
                for id in stale {
                    inner.messages.remove(&id);
                }
                if let Some(messages) = plan.deleted_messages {
                    inner.messages.insert(plan.session_id.clone(), messages);
                }
                inner.deleting.remove(&plan.session_id);
            }
            if let Some(path) = replacement_path {
                let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(path)).await;
            }
            return Err(error);
        }

        let transcript_path = plan.history.session_path(&plan.session_id);
        let removal =
            tokio::task::spawn_blocking(move || std::fs::remove_file(transcript_path)).await;
        let removal_error = match removal {
            Ok(Ok(())) => None,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => None,
            Ok(Err(error)) => Some(error.to_string()),
            Err(error) => Some(error.to_string()),
        };

        {
            let mut inner = self.inner.lock().await;
            if let Some(error) = removal_error {
                push_warning(
                    &mut inner,
                    format!("Chat history for the deleted session could not be removed. ({error})"),
                );
            }
            inner.deleting.remove(&plan.session_id);
            inner.index_dirty = false;
        }
        notify(plan.listener);

        Ok(SessionDeletionResult {
            sessions: plan.sessions,
            active_session: plan.active_session,
        })
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
                    if !session.custom_title {
                        session.title = derive_title(text);
                    }
                }
            }
            touch_session(&mut inner, session_id, &created_at);
            inner.index_dirty = true;

            (message, inner.listener.clone())
        };

        // The user message is durable before the prompt is sent.
        flush_session(&self.inner, session_id).await?;
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
        inner.index_dirty = true;
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
        self.mutate_and_flush(session_id, |inner| {
            let updated_at = now_iso(inner);
            touch_session(inner, session_id, &updated_at);
            if let Some(messages) = inner.messages.get_mut(session_id) {
                if let Some(message) = messages.iter_mut().find(|entry| entry.id == message_id) {
                    message.status = MessageStatus::Complete;
                    if metadata.is_some() {
                        message.metadata = metadata;
                    }
                }
            }
        })
        .await
    }

    pub async fn interrupt_assistant(
        &self,
        session_id: &str,
        message_id: Option<&str>,
    ) -> Result<(), AppError> {
        self.mutate_and_flush(session_id, |inner| {
            let updated_at = now_iso(inner);
            touch_session(inner, session_id, &updated_at);
            if let Some(message_id) = message_id {
                if let Some(messages) = inner.messages.get_mut(session_id) {
                    if let Some(message) = messages.iter_mut().find(|entry| entry.id == message_id)
                    {
                        message.status = MessageStatus::Interrupted;
                    }
                }
            }
        })
        .await
    }

    pub async fn fail_request(
        &self,
        session_id: &str,
        assistant_message_id: Option<&str>,
        code: ErrorCode,
        message: &str,
    ) -> Result<(), AppError> {
        self.mutate_and_flush(session_id, |inner| {
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
        })
        .await
    }

    pub async fn flush(&self, session_id: &str) -> Result<(), AppError> {
        flush_session(&self.inner, session_id).await
    }

    pub async fn flush_all(&self) -> Result<(), AppError> {
        let session_ids: Vec<String> = self.inner.lock().await.messages.keys().cloned().collect();
        let mut failures = Vec::new();

        for session_id in session_ids {
            if let Err(error) = flush_session(&self.inner, &session_id).await {
                failures.push(error.message);
            }
        }
        if let Err(error) = flush_index(&self.inner).await {
            failures.push(error.message);
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::internal(format!(
                "Chat history could not be saved for {} session(s): {}",
                failures.len(),
                failures.join("; ")
            )))
        }
    }

    /// Applies one in-memory mutation, then persists the session.
    async fn mutate_and_flush<F>(&self, session_id: &str, mutate: F) -> Result<(), AppError>
    where
        F: FnOnce(&mut Inner),
    {
        let listener = {
            let mut inner = self.inner.lock().await;
            mutate(&mut inner);
            inner.listener.clone()
        };

        flush_session(&self.inner, session_id).await?;
        notify(listener);
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
        custom_title: false,
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

fn push_warning(inner: &mut Inner, warning: String) {
    inner.warnings.push(warning);
    if inner.warnings.len() > MAX_WARNINGS {
        let excess = inner.warnings.len() - MAX_WARNINGS;
        inner.warnings.drain(..excess);
    }
}

fn touch_usage(inner: &mut Inner, session_id: &str) {
    inner.usage.retain(|id| id != session_id);
    inner.usage.insert(0, session_id.to_owned());
}

fn is_clean(inner: &Inner, session_id: &str) -> bool {
    !inner.dirty.contains(session_id) && !inner.timers.contains_key(session_id)
}

/// Caches a session transcript and evicts least recently used clean sessions past the cap.
fn cache_messages(inner: &mut Inner, session_id: &str, messages: Vec<StoredMessage>) {
    inner.messages.insert(session_id.to_owned(), messages);
    touch_usage(inner, session_id);
    evict_clean_sessions(inner);
}

fn evict_clean_sessions(inner: &mut Inner) {
    if inner.messages.len() <= MAX_CACHED_SESSIONS {
        return;
    }

    let active = inner.index.active_session_id.clone();
    let candidates: Vec<String> = inner
        .usage
        .iter()
        .rev()
        .filter(|id| Some(*id) != active.as_ref() && is_clean(inner, id))
        .cloned()
        .collect();

    for session_id in candidates {
        if inner.messages.len() <= MAX_CACHED_SESSIONS {
            break;
        }
        inner.messages.remove(&session_id);
        inner.usage.retain(|id| id != &session_id);
    }
}

fn load_session_locked(inner: &mut Inner, session_id: &str) {
    let _ = load_session_inner(inner, session_id);
}

fn load_session_inner(inner: &mut Inner, session_id: &str) -> Option<String> {
    if inner.messages.contains_key(session_id) {
        touch_usage(inner, session_id);
        return None;
    }

    let loaded = inner.history.load_session(session_id);
    if let Some(warning) = loaded.warning {
        push_warning(inner, warning);
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

    cache_messages(inner, session_id, messages);
    if recovered {
        // Rewrite the recovered status to disk so a restart does not repeat the repair.
        inner.dirty.insert(session_id.to_owned());
        return Some(session_id.to_owned());
    }
    None
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
    inner.dirty.insert(session_id.to_owned());
    if let Some(handle) = inner.timers.remove(session_id) {
        handle.abort();
    }

    let store = Arc::clone(store);
    let owned_id = session_id.to_owned();
    let debounce = inner.debounce;

    let handle = tokio::spawn(async move {
        tokio::time::sleep(debounce).await;
        {
            let mut inner = store.lock().await;
            inner.timers.remove(&owned_id);
            if !inner.dirty.contains(&owned_id) {
                return;
            }
        }
        // A failed debounce write keeps the session dirty for the next flush.
        let _ = flush_session(&store, &owned_id).await;
        let _ = flush_index(&store).await;
    });

    inner.timers.insert(session_id.to_owned(), handle);
}

/// Persists one session: serialize under the store lock, then write off the runtime.
async fn flush_session(store: &Arc<Mutex<Inner>>, session_id: &str) -> Result<(), AppError> {
    let prepared = {
        let mut inner = store.lock().await;
        prepare_session_write(&mut inner, store, session_id)?
    };
    let Some(prepared) = prepared else {
        return Ok(());
    };

    let result = prepared.execute().await;
    let mut inner = store.lock().await;
    match &result {
        Ok(()) => {
            inner.dirty.remove(session_id);
            inner.index_dirty = false;
            evict_clean_sessions(&mut inner);
        }
        Err(_) => {
            // Keep the session dirty so a later flush retries it.
            inner.dirty.insert(session_id.to_owned());
        }
    }
    result
}

async fn flush_index(store: &Arc<Mutex<Inner>>) -> Result<(), AppError> {
    let prepared = {
        let mut inner = store.lock().await;
        if !inner.index_dirty {
            return Ok(());
        }
        let bytes = HistoryStore::index_document(&inner.index).map_err(history_save_error)?;
        inner.index_dirty = false;
        (inner.history.clone(), bytes)
    };

    let (history, bytes) = prepared;
    let result = tokio::task::spawn_blocking(move || {
        write_document(&history.index_path(), &bytes).map_err(history_save_error)
    })
    .await
    .map_err(|error| AppError::internal(format!("The history writer failed. ({error})")))?;

    if result.is_err() {
        store.lock().await.index_dirty = true;
    }
    result
}

fn history_save_error(error: String) -> AppError {
    AppError::internal(format!("Chat history could not be saved: {error}"))
}

fn notify(listener: Option<ChangeListener>) {
    if let Some(listener) = listener {
        listener();
    }
}

/// Trims a user supplied title and enforces the shared storage limit.
pub fn normalize_title(title: &str) -> Result<String, AppError> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(AppError::configuration(
            "The session title cannot be empty.",
        ));
    }
    if trimmed.chars().count() > TITLE_LIMIT {
        return Err(AppError::configuration(format!(
            "The session title must be at most {TITLE_LIMIT} characters."
        )));
    }
    Ok(trimmed.to_owned())
}

pub fn derive_title(text: &str) -> String {
    let mut normalized = String::new();
    let mut truncated = false;
    let mut characters = 0usize;

    for word in text.split_whitespace() {
        if !normalized.is_empty() {
            characters += 1;
            if characters > TITLE_LIMIT {
                truncated = true;
                break;
            }
            normalized.push(' ');
        }

        for character in word.chars() {
            characters += 1;
            if characters > TITLE_LIMIT {
                truncated = true;
                break;
            }
            normalized.push(character);
        }
        if truncated {
            break;
        }
    }

    if normalized.is_empty() {
        return FALLBACK_TITLE.to_owned();
    }
    if !truncated {
        return normalized;
    }

    let mut shortened: String = normalized.chars().take(TITLE_LIMIT - 1).collect();
    shortened.push('…');
    shortened
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
    fn normalizes_user_titles_and_enforces_the_limit() {
        assert_eq!(
            normalize_title("  Rename me  ").expect("trimmed title"),
            "Rename me"
        );
        assert_eq!(
            normalize_title(&"x".repeat(TITLE_LIMIT))
                .expect("exactly at the limit")
                .chars()
                .count(),
            TITLE_LIMIT
        );

        for invalid in ["", "   ", "x".repeat(TITLE_LIMIT + 1).as_str()] {
            let error = normalize_title(invalid).expect_err("invalid title");
            assert_eq!(error.code, ErrorCode::Configuration);
        }
    }

    #[tokio::test]
    async fn renames_without_reordering_or_touching_timestamps() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let first = harness.store.get_active_session_id().await.expect("active");
        let second = harness.store.create().await.expect("create");
        let before = harness.store.list().await;
        let first_before = before
            .iter()
            .find(|session| session.id == first)
            .expect("first")
            .clone();

        let renamed = harness
            .store
            .rename(&first, "  Manual title  ")
            .await
            .expect("rename");

        assert_eq!(renamed.title, "Manual title");
        assert!(renamed.custom_title);
        assert_eq!(renamed.updated_at, first_before.updated_at);
        let after = harness.store.list().await;
        assert_eq!(
            after
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            before
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(after[0].id, second.id);

        let reopened = reopen(&harness.directory).await;
        let restored = reopened
            .list()
            .await
            .into_iter()
            .find(|session| session.id == first)
            .expect("renamed session");
        assert_eq!(restored.title, "Manual title");
        assert!(restored.custom_title);

        let error = reopened
            .rename("missing", "Nope")
            .await
            .expect_err("unknown session");
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn keeps_a_custom_title_when_the_first_message_arrives() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .rename(&session_id, "Manual title")
            .await
            .expect("rename");
        harness
            .store
            .append_user_message(&session_id, "this must not become the title")
            .await
            .expect("append");

        assert_eq!(harness.store.list().await[0].title, "Manual title");

        let reopened = reopen(&harness.directory).await;
        let snapshot = reopened.get_snapshot(&session_id).await.expect("snapshot");
        assert_eq!(snapshot.session.title, "Manual title");
        assert!(snapshot.session.custom_title);
    }

    #[tokio::test]
    async fn restores_the_previous_title_when_the_index_write_fails() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .rename(&session_id, "Custom title")
            .await
            .expect("rename");

        let history_dir = harness.directory.join("history");
        let aside = harness.directory.join("history-aside");
        fs::rename(&history_dir, &aside).expect("move history");
        fs::write(&history_dir, b"not a directory").expect("block the directory");

        harness
            .store
            .rename(&session_id, "Attempted title")
            .await
            .expect_err("index write fails");

        let listed = harness.store.list().await;
        assert_eq!(listed[0].title, "Custom title");
        assert!(listed[0].custom_title);
        assert!(harness.store.inner.lock().await.index_dirty);

        fs::remove_file(&history_dir).expect("remove blocker");
        fs::rename(&aside, &history_dir).expect("restore history");
        harness.store.flush(&session_id).await.expect("retry flush");

        let reopened = reopen(&harness.directory).await;
        assert_eq!(reopened.list().await[0].title, "Custom title");
    }

    #[tokio::test]
    async fn a_tombstoned_session_skips_a_prepared_write() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "keep me")
            .await
            .expect("append");

        let store = Arc::clone(&harness.store.inner);
        let mut inner = store.lock().await;
        inner.deleting.insert(session_id.clone());
        inner.dirty.insert(session_id.clone());
        let prepared = prepare_session_write(&mut inner, &store, &session_id)
            .expect("prepare")
            .is_none();
        assert!(prepared, "a tombstoned session produces no write");
        assert!(!inner.dirty.contains(&session_id));
    }

    #[tokio::test]
    async fn a_queued_write_does_not_recreate_a_deleted_transcript() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "delete me")
            .await
            .expect("append");

        let store = Arc::clone(&harness.store.inner);
        let prepared = {
            let mut inner = store.lock().await;
            prepare_session_write(&mut inner, &store, &session_id)
                .expect("prepare")
                .expect("write")
        };

        harness
            .store
            .delete(&session_id)
            .await
            .expect("delete session");
        prepared.execute().await.expect("stale write is skipped");

        let history = HistoryStore::new(harness.directory.join("history"));
        assert!(!history.session_path(&session_id).exists());
    }

    #[tokio::test]
    async fn deletes_an_inactive_session_and_returns_the_sorted_remainder() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let first = harness.store.get_active_session_id().await.expect("active");
        let second = harness.store.create().await.expect("create");
        let third = harness.store.create().await.expect("create");

        let result = harness
            .store
            .delete(&second.id)
            .await
            .expect("delete inactive");

        assert_eq!(
            result
                .sessions
                .iter()
                .map(|session| session.id.clone())
                .collect::<Vec<_>>(),
            vec![third.id.clone(), first.clone()]
        );
        assert_eq!(
            result.active_session.session.id, third.id,
            "an inactive deletion leaves the active session alone"
        );
        assert!(!harness.store.has_session(&second.id).await);
        assert!(!HistoryStore::new(harness.directory.join("history"))
            .session_path(&second.id)
            .exists());

        let reopened = reopen(&harness.directory).await;
        assert_eq!(reopened.list().await.len(), 2);
        assert!(!reopened.has_session(&second.id).await);
    }

    #[tokio::test]
    async fn deleting_the_active_session_selects_the_most_recently_updated_one() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let first = harness.store.get_active_session_id().await.expect("active");
        harness.store.create().await.expect("second");
        let third = harness.store.create().await.expect("third");
        harness
            .store
            .append_user_message(&first, "most recent activity")
            .await
            .expect("append");
        {
            // Force the newly active transcript to be loaded from disk.
            let mut inner = harness.store.inner.lock().await;
            inner.messages.remove(&first);
            inner.usage.retain(|id| id != &first);
        }

        let result = harness
            .store
            .delete(&third.id)
            .await
            .expect("delete active");

        assert_eq!(result.active_session.session.id, first);
        assert_eq!(result.active_session.messages.len(), 1);
        assert_eq!(
            result.active_session.messages[0].content,
            "most recent activity"
        );
        assert_eq!(result.sessions[0].id, first);
    }

    #[tokio::test]
    async fn deleting_the_only_session_creates_an_empty_active_fallback() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "gone")
            .await
            .expect("append");

        let result = harness
            .store
            .delete(&session_id)
            .await
            .expect("delete only");

        assert_eq!(result.sessions.len(), 1);
        assert_ne!(result.sessions[0].id, session_id);
        assert_eq!(result.sessions[0].title, FALLBACK_TITLE);
        assert_eq!(result.active_session.session.id, result.sessions[0].id);
        assert!(result.active_session.messages.is_empty());
        assert!(!HistoryStore::new(harness.directory.join("history"))
            .session_path(&session_id)
            .exists());

        let reopened = reopen(&harness.directory).await;
        assert_eq!(reopened.list().await.len(), 1);
        assert!(reopened.get_warnings().await.is_empty());
        assert!(reopened
            .get_active_snapshot()
            .await
            .expect("snapshot")
            .messages
            .is_empty());
    }

    #[tokio::test]
    async fn restores_the_index_when_a_delete_write_fails() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let first = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&first, "keep this transcript")
            .await
            .expect("append");
        harness.store.create().await.expect("second");

        let history_dir = harness.directory.join("history");
        let aside = harness.directory.join("history-aside");
        fs::rename(&history_dir, &aside).expect("move history");
        fs::write(&history_dir, b"not a directory").expect("block the directory");

        harness
            .store
            .delete(&first)
            .await
            .expect_err("index write fails");

        assert!(harness.store.has_session(&first).await);
        assert_eq!(harness.store.list().await.len(), 2);
        let snapshot = harness
            .store
            .get_snapshot(&first)
            .await
            .expect("restored snapshot");
        assert_eq!(snapshot.messages[0].content, "keep this transcript");

        fs::remove_file(&history_dir).expect("remove blocker");
        fs::rename(&aside, &history_dir).expect("restore history");

        let reopened = reopen(&harness.directory).await;
        assert!(reopened.has_session(&first).await);
        assert_eq!(
            reopened
                .get_snapshot(&first)
                .await
                .expect("persisted snapshot")
                .messages[0]
                .content,
            "keep this transcript"
        );

        harness.store.delete(&first).await.expect("retry delete");
        assert!(!harness.store.has_session(&first).await);
        assert!(!HistoryStore::new(&history_dir)
            .session_path(&first)
            .exists());
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
    #[tokio::test]
    async fn bounds_the_message_cache_and_reloads_evicted_sessions_from_disk() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");

        let mut ids = Vec::new();
        for index in 0..(MAX_CACHED_SESSIONS + 3) {
            let session = harness.store.create().await.expect("create");
            harness
                .store
                .append_user_message(&session.id, &format!("message {index}"))
                .await
                .expect("append");
            harness.store.flush(&session.id).await.expect("flush");
            ids.push(session.id);
        }

        let cached = harness.store.inner.lock().await.messages.len();
        assert!(
            cached <= MAX_CACHED_SESSIONS + 1,
            "cache must stay bounded, saw {cached}"
        );

        for (index, id) in ids.iter().enumerate() {
            let snapshot = harness.store.get_snapshot(id).await.expect("snapshot");
            assert_eq!(snapshot.messages.len(), 1);
            assert_eq!(snapshot.messages[0].content, format!("message {index}"));
        }
    }

    #[tokio::test]
    async fn keeps_at_most_twenty_warnings() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        {
            let mut inner = harness.store.inner.lock().await;
            for index in 0..(MAX_WARNINGS + 7) {
                push_warning(&mut inner, format!("warning {index}"));
            }
        }

        let warnings = harness.store.get_warnings().await;
        assert_eq!(warnings.len(), MAX_WARNINGS);
        assert_eq!(warnings[0], format!("warning {}", 7));
        assert_eq!(
            warnings[MAX_WARNINGS - 1],
            format!("warning {}", MAX_WARNINGS + 6)
        );
    }

    #[tokio::test]
    async fn one_debounce_task_per_session_writes_once_per_window() {
        let harness = harness(40);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "hi")
            .await
            .expect("append");
        harness.store.flush(&session_id).await.expect("flush");

        {
            let inner = harness.store.inner.lock().await;
            assert_eq!(inner.timers.len(), 0);
        }

        let assistant = harness
            .store
            .begin_assistant_message(&session_id)
            .await
            .expect("assistant");
        for _ in 0..25 {
            harness
                .store
                .append_delta(&session_id, &assistant.id, "x")
                .await;
        }
        {
            let inner = harness.store.inner.lock().await;
            assert_eq!(
                inner.timers.len(),
                1,
                "rapid deltas share a single debounce task"
            );
        }

        harness.store.flush(&session_id).await.expect("flush");
        {
            let inner = harness.store.inner.lock().await;
            assert_eq!(inner.timers.len(), 0);
        }

        let stored = HistoryStore::new(harness.directory.join("history")).load_session(&session_id);
        let stored_assistant = stored
            .messages
            .iter()
            .find(|message| message.role == MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(stored_assistant.content, "x".repeat(25));
    }

    #[tokio::test]
    async fn writes_compact_json_that_round_trips() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "compact please")
            .await
            .expect("append");
        harness.store.flush(&session_id).await.expect("flush");

        let path = HistoryStore::new(harness.directory.join("history")).session_path(&session_id);
        let raw = fs::read_to_string(&path).expect("read");
        assert!(
            !raw.contains("\n  "),
            "compact JSON must not be pretty printed"
        );
        assert_eq!(raw.lines().count(), 1, "the document is one compact line");

        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["messages"][0]["content"], "compact please");

        let loaded = HistoryStore::new(harness.directory.join("history")).load_session(&session_id);
        assert_eq!(loaded.messages[0].content, "compact please");
    }

    #[tokio::test]
    async fn compact_output_is_smaller_than_pretty_output() {
        let message = StoredMessage {
            id: "message-1".to_owned(),
            role: MessageRole::Assistant,
            content: "hello".to_owned(),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            status: MessageStatus::Complete,
            error: None,
            metadata: None,
        };
        let compact = HistoryStore::session_document("session-1", std::slice::from_ref(&message))
            .expect("compact");
        let pretty = serde_json::to_string_pretty(&serde_json::json!({
            "version": 1,
            "sessionId": "session-1",
            "messages": [message],
        }))
        .expect("pretty");

        assert!(compact.len() < pretty.len());
    }

    #[tokio::test]
    async fn a_dirty_session_survives_a_failed_write_and_is_retried() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");

        // Replace the history directory with a regular file so writes fail.
        let history_dir = harness.directory.join("history");
        let aside = harness.directory.join("history-aside");
        fs::rename(&history_dir, &aside).expect("move history");
        fs::write(&history_dir, b"not a directory").expect("block the directory");

        let result = harness
            .store
            .append_user_message(&session_id, "keep me")
            .await;
        assert!(result.is_err(), "the write must report the failure");

        let dirty = harness.store.inner.lock().await.dirty.contains(&session_id);
        assert!(dirty, "a failed write keeps the session dirty for a retry");

        // Restore the directory and retry.
        fs::remove_file(&history_dir).expect("remove blocker");
        fs::rename(&aside, &history_dir).expect("restore history");

        harness.store.flush(&session_id).await.expect("retry flush");
        let persisted = HistoryStore::new(&history_dir).load_session(&session_id);
        assert_eq!(persisted.messages[0].content, "keep me");
    }

    #[tokio::test]
    async fn flush_all_continues_through_a_failing_session() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let first = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&first, "first")
            .await
            .expect("append");

        let blocked_session = harness.store.create().await.expect("create");
        {
            let mut inner = harness.store.inner.lock().await;
            inner
                .messages
                .insert(blocked_session.id.clone(), Vec::new());
            inner.dirty.insert(blocked_session.id.clone());
        }

        // Block only one session path by making its target a directory.
        let store = HistoryStore::new(harness.directory.join("history"));
        let blocked_path = store.session_path(&blocked_session.id);
        let _ = fs::remove_file(&blocked_path);
        fs::create_dir_all(&blocked_path).expect("block");

        let error = harness
            .store
            .flush_all()
            .await
            .expect_err("one write fails");
        assert!(error.message.contains("could not be saved"));

        let persisted = store.load_session(&first);
        assert_eq!(
            persisted.messages[0].content, "first",
            "other sessions are still written"
        );
    }

    #[tokio::test]
    async fn a_large_prompt_derives_a_title_quickly_and_correctly() {
        let large = "word ".repeat(40_000);
        let title = derive_title(&large);

        assert_eq!(title.chars().count(), TITLE_LIMIT);
        assert!(title.ends_with('…'));
        assert!(title.starts_with("word word"));
    }

    #[tokio::test]
    async fn appends_messages_while_a_snapshot_is_being_serialized() {
        let harness = harness(5);
        harness.store.initialize().await.expect("initialize");
        let session_id = harness.store.get_active_session_id().await.expect("active");
        harness
            .store
            .append_user_message(&session_id, "start")
            .await
            .expect("append");

        let assistant = harness
            .store
            .begin_assistant_message(&session_id)
            .await
            .expect("assistant");

        // Concurrent appends and snapshots must not interleave a torn document.
        let store = harness.store.clone();
        let id = assistant.id.clone();
        let session = session_id.clone();
        let writer = tokio::spawn(async move {
            for _ in 0..50 {
                store.append_delta(&session, &id, "x").await;
            }
        });
        for _ in 0..20 {
            let snapshot = harness
                .store
                .get_snapshot(&session_id)
                .await
                .expect("snapshot");
            assert_eq!(snapshot.messages.len(), 2);
        }
        writer.await.expect("writer");

        harness.store.flush(&session_id).await.expect("flush");
        let persisted =
            HistoryStore::new(harness.directory.join("history")).load_session(&session_id);
        let persisted_assistant = persisted
            .messages
            .iter()
            .find(|message| message.role == MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(persisted_assistant.content, "x".repeat(50));
    }
}
