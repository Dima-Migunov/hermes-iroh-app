use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::errors::{AppError, ErrorCode};
use crate::events::EventSink;
use crate::iroh::client::{IrohClient, PromptStreamRequest};
use crate::protocol::{PromptEvent, PromptSubmissionResult, ToolCall};
use crate::sessions::{IdFactory, SessionStore};

pub type PromptTransportRef = Arc<dyn PromptTransport>;

pub trait PromptTransport: Send + Sync {
    fn stream_prompt<'a>(
        &'a self,
        request: PromptStreamRequest,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}

impl PromptTransport for IrohClient {
    fn stream_prompt<'a>(
        &'a self,
        request: PromptStreamRequest,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(IrohClient::stream_prompt(self, request))
    }
}

#[derive(Debug, Clone)]
pub struct PromptSubmission {
    pub session_id: String,
    pub text: String,
}

#[derive(Default)]
struct RequestState {
    assistant_message_id: Option<String>,
    cancelled: bool,
    terminal_sent: bool,
}

struct TrackedRequest {
    request_id: String,
    session_id: String,
    state: std::sync::Mutex<RequestState>,
    cancellation: CancellationToken,
    deltas: Arc<DeltaAccumulator>,
}

impl TrackedRequest {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, RequestState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn publish_assistant(&self, message_id: String) -> bool {
        let mut state = self.lock_state();
        state.assistant_message_id = Some(message_id);
        state.cancelled
    }

    fn assistant_id(&self) -> Option<String> {
        self.lock_state().assistant_message_id.clone()
    }

    fn is_cancelled(&self) -> bool {
        self.lock_state().cancelled
    }

    fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    /// Marks the request cancelled. Returns `false` when a terminal outcome was already
    /// claimed, so cancellation never overrides a completed or failed request.
    fn cancel(&self) -> bool {
        let mut state = self.lock_state();
        if state.terminal_sent {
            return false;
        }
        state.cancelled = true;
        state.terminal_sent = true;
        true
    }

    fn claim_terminal(&self) -> bool {
        let mut state = self.lock_state();
        if state.cancelled || state.terminal_sent {
            return false;
        }
        state.terminal_sent = true;
        true
    }
}

pub struct PromptCoordinator {
    client: PromptTransportRef,
    sessions: SessionStore,
    events: Arc<dyn EventSink>,
    id_factory: IdFactory,
    active: Arc<Mutex<Option<Arc<TrackedRequest>>>>,
    run_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl PromptCoordinator {
    pub fn new(
        client: PromptTransportRef,
        sessions: SessionStore,
        events: Arc<dyn EventSink>,
        id_factory: Option<IdFactory>,
    ) -> Self {
        Self {
            client,
            sessions,
            events,
            id_factory: id_factory.unwrap_or_else(|| Arc::new(|| Uuid::new_v4().to_string())),
            active: Arc::new(Mutex::new(None)),
            run_task: Mutex::new(None),
        }
    }

    pub async fn is_busy(&self) -> bool {
        self.active.lock().await.is_some()
    }

    pub async fn send_prompt(
        &self,
        input: PromptSubmission,
    ) -> Result<PromptSubmissionResult, AppError> {
        if input.session_id.is_empty() {
            return Err(AppError::configuration(
                "A session must be selected before sending a prompt.",
            ));
        }
        if input.text.trim().is_empty() {
            return Err(AppError::configuration("The prompt is empty."));
        }

        let request = {
            let mut active = self.active.lock().await;
            if active.is_some() {
                return Err(AppError::new(
                    ErrorCode::Busy,
                    "A response is already in progress.",
                ));
            }

            let request = Arc::new(TrackedRequest {
                request_id: (self.id_factory)(),
                session_id: input.session_id.clone(),
                state: std::sync::Mutex::new(RequestState::default()),
                cancellation: CancellationToken::new(),
                deltas: Arc::new(DeltaAccumulator::default()),
            });
            *active = Some(Arc::clone(&request));
            request
        };

        if let Err(error) = self
            .sessions
            .append_user_message(&request.session_id, &input.text)
            .await
        {
            release_request(&self.active, &request).await;
            return Err(error);
        }

        let result = PromptSubmissionResult {
            request_id: request.request_id.clone(),
        };

        let client = Arc::clone(&self.client);
        let sessions = self.sessions.clone();
        let events = Arc::clone(&self.events);
        let active = Arc::clone(&self.active);

        let task = tokio::spawn(async move {
            run_prompt(client, sessions, events, active, request, input.text).await;
        });
        *self.run_task.lock().await = Some(task);

        Ok(result)
    }

    pub async fn cancel_prompt(&self) -> bool {
        let request = {
            let mut active = self.active.lock().await;
            active.take()
        };
        let Some(request) = request else {
            return false;
        };

        let won = request.cancel();
        if !won {
            return false;
        }
        request.cancellation().cancel();
        self.events.prompt_event(PromptEvent::Cancelled {
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
        });

        // Persist any text the run task has not drained yet so nothing already streamed is
        // lost, then mark the message interrupted. The run task exits on the token.
        let buffered = request.deltas.take();
        let mut assistant_message_id = request.assistant_id();
        if !buffered.is_empty() {
            if assistant_message_id.is_none() {
                if let Ok(message) = self
                    .sessions
                    .begin_assistant_message(&request.session_id)
                    .await
                {
                    let _ = request.publish_assistant(message.id.clone());
                    assistant_message_id = Some(message.id);
                }
            }
            if let Some(message_id) = assistant_message_id.as_deref() {
                self.sessions
                    .append_delta(&request.session_id, message_id, &buffered)
                    .await;
            }
        }

        let _ = self
            .sessions
            .interrupt_assistant(&request.session_id, assistant_message_id.as_deref())
            .await;

        won
    }

    pub async fn shutdown(&self) -> Result<(), AppError> {
        let _ = self.cancel_prompt().await;
        // Let the run task persist its final state before the last flush.
        if let Some(task) = self.run_task.lock().await.take() {
            let _ = task.await;
        }
        self.sessions.flush_all().await
    }
}

pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Buffers streamed deltas so a slow consumer cannot make memory grow one frame at a time.
#[derive(Default)]
struct DeltaAccumulator {
    pending: std::sync::Mutex<String>,
    signal: tokio::sync::Notify,
}

impl DeltaAccumulator {
    fn push(&self, content: &str) {
        if content.is_empty() {
            return;
        }
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_str(content);
        self.signal.notify_one();
    }

    fn take(&self) -> String {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *pending)
    }
}

async fn run_prompt(
    client: PromptTransportRef,
    sessions: SessionStore,
    events: Arc<dyn EventSink>,
    active: Arc<Mutex<Option<Arc<TrackedRequest>>>>,
    request: Arc<TrackedRequest>,
    text: String,
) {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<PromptEvent>();
    let deltas = Arc::clone(&request.deltas);
    let mut streamed_bytes = 0usize;
    let mut overflowed = false;

    let transport_request = Arc::clone(&request);
    let transport_deltas = Arc::clone(&deltas);
    let transport = tokio::spawn(async move {
        let emit_deltas = transport_deltas;
        let request_id = transport_request.request_id.clone();
        let cancel = transport_request.cancellation().clone();
        client
            .stream_prompt(PromptStreamRequest {
                request_id: transport_request.request_id.clone(),
                session_id: transport_request.session_id.clone(),
                text,
                emit: Arc::new(move |event| match event {
                    PromptEvent::Delta { content, .. } => emit_deltas.push(&content),
                    other => {
                        // Close the delta boundary before every control frame so the
                        // consumer can never observe later text ahead of it.
                        let buffered = emit_deltas.take();
                        if !buffered.is_empty() {
                            let _ = sender.send(PromptEvent::Delta {
                                request_id: request_id.clone(),
                                content: buffered,
                            });
                        }
                        let _ = sender.send(other);
                    }
                }),
                cancel,
            })
            .await;
    });

    let mut assistant_message_id: Option<String> = None;
    let mut terminal_seen = false;

    /// Persists buffered text into the assistant message without forwarding an event.
    async fn drain_into_message(
        deltas: &DeltaAccumulator,
        sessions: &SessionStore,
        session_id: &str,
        assistant_message_id: Option<&str>,
    ) {
        let buffered = deltas.take();
        if buffered.is_empty() {
            return;
        }
        if let Some(message_id) = assistant_message_id {
            sessions
                .append_delta(session_id, message_id, &buffered)
                .await;
        }
    }

    // Emits accumulated text as one Delta event, in arrival order.
    async fn emit_buffered(
        buffered: String,
        session_id: &str,
        assistant_message_id: Option<&str>,
        sessions: &SessionStore,
        events: &Arc<dyn EventSink>,
        request_id: &str,
    ) {
        if let Some(message_id) = assistant_message_id {
            sessions
                .append_delta(session_id, message_id, &buffered)
                .await;
        }
        events.prompt_event(PromptEvent::Delta {
            request_id: request_id.to_owned(),
            content: buffered,
        });
    }

    loop {
        // Control frames are consumed first: the emitter always drains the accumulator and
        // flushes a boundary Delta before sending a control frame, so nothing older can be
        // left in the accumulator when a control frame is available.
        let next = match receiver.try_recv() {
            Ok(event) => Some(event),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                let buffered = deltas.take();
                if !buffered.is_empty() {
                    streamed_bytes = streamed_bytes.saturating_add(buffered.len());
                    if streamed_bytes > MAX_RESPONSE_BYTES {
                        overflowed = true;
                        terminal_seen = true;
                        break;
                    }
                    emit_buffered(
                        buffered,
                        &request.session_id,
                        assistant_message_id.as_deref(),
                        &sessions,
                        &events,
                        &request.request_id,
                    )
                    .await;
                    continue;
                }
                if transport.is_finished() && receiver.is_closed() {
                    break;
                }
                tokio::select! {
                    event = receiver.recv() => event,
                    _ = deltas.signal.notified() => continue,
                }
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => None,
        };

        let Some(event) = next else {
            break;
        };

        if request.is_cancelled() {
            // Leave buffered text for the post-loop drain.
            break;
        }

        match event {
            PromptEvent::Start { session_id, .. } => {
                if assistant_message_id.is_none() {
                    match sessions.begin_assistant_message(&session_id).await {
                        Ok(message) => {
                            assistant_message_id = Some(message.id.clone());
                            if request.publish_assistant(message.id) {
                                let _ = sessions
                                    .interrupt_assistant(
                                        &request.session_id,
                                        assistant_message_id.as_deref(),
                                    )
                                    .await;
                                terminal_seen = true;
                                break;
                            }
                        }
                        Err(error) => {
                            if !request.claim_terminal() {
                                terminal_seen = true;
                                break;
                            }
                            let message = error.message;
                            release_request(&active, &request).await;
                            events.prompt_event(PromptEvent::Error {
                                request_id: request.request_id.clone(),
                                session_id: request.session_id.clone(),
                                code: error.code,
                                message: message.clone(),
                            });
                            let _ = sessions
                                .fail_request(&request.session_id, None, error.code, &message)
                                .await;
                            terminal_seen = true;
                            break;
                        }
                    }
                }
                if !request.is_cancelled() {
                    events.prompt_event(PromptEvent::Start {
                        request_id: request.request_id.clone(),
                        session_id,
                    });
                }
            }
            PromptEvent::Done { metadata, .. } => {
                if !request.claim_terminal() {
                    terminal_seen = true;
                    break;
                }
                drain_into_message(
                    &deltas,
                    &sessions,
                    &request.session_id,
                    assistant_message_id.as_deref(),
                )
                .await;
                if let Some(message_id) = assistant_message_id.as_deref() {
                    let _ = sessions
                        .complete_assistant(
                            &request.session_id,
                            message_id,
                            metadata.clone().map(|value| *value),
                        )
                        .await;
                }
                events.prompt_event(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata,
                });
                release_request(&active, &request).await;
                terminal_seen = true;
                break;
            }
            PromptEvent::Error { code, message, .. } => {
                if !request.claim_terminal() {
                    terminal_seen = true;
                    break;
                }
                drain_into_message(
                    &deltas,
                    &sessions,
                    &request.session_id,
                    assistant_message_id.as_deref(),
                )
                .await;
                events.prompt_event(PromptEvent::Error {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    code,
                    message: message.clone(),
                });
                let _ = sessions
                    .fail_request(
                        &request.session_id,
                        assistant_message_id.as_deref(),
                        code,
                        &message,
                    )
                    .await;
                release_request(&active, &request).await;
                terminal_seen = true;
                break;
            }
            PromptEvent::Tool {
                id,
                name,
                arguments,
                truncated,
                line_index,
                ..
            } => {
                let Some(message_id) = assistant_message_id.as_deref() else {
                    continue;
                };
                sessions
                    .append_tool_call(
                        &request.session_id,
                        message_id,
                        ToolCall {
                            id: id.clone(),
                            name: name.clone(),
                            arguments: arguments.clone(),
                            truncated,
                            line_index,
                        },
                    )
                    .await;
                events.prompt_event(PromptEvent::Tool {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    id,
                    name,
                    arguments,
                    truncated,
                    line_index,
                });
            }
            PromptEvent::Delta { content, .. } => {
                streamed_bytes = streamed_bytes.saturating_add(content.len());
                if streamed_bytes > MAX_RESPONSE_BYTES {
                    overflowed = true;
                    terminal_seen = true;
                    break;
                }
                emit_buffered(
                    content,
                    &request.session_id,
                    assistant_message_id.as_deref(),
                    &sessions,
                    &events,
                    &request.request_id,
                )
                .await;
            }
            PromptEvent::Cancelled { .. } => {}
        }
    }

    // Drain whatever the accumulator still holds. Text that pushes the response past the
    // cap turns into a protocol error; otherwise it is the final in-order text, and a
    // cancelled response keeps it with the interrupted message.
    if !overflowed {
        let buffered = deltas.take();
        if !buffered.is_empty() {
            streamed_bytes = streamed_bytes.saturating_add(buffered.len());
            if streamed_bytes > MAX_RESPONSE_BYTES {
                overflowed = true;
            } else if request.is_cancelled() {
                if assistant_message_id.is_none() {
                    if let Ok(message) = sessions.begin_assistant_message(&request.session_id).await
                    {
                        assistant_message_id = Some(message.id);
                    }
                }
                if let Some(message_id) = assistant_message_id.as_deref() {
                    sessions
                        .append_delta(&request.session_id, message_id, &buffered)
                        .await;
                }
            } else if !terminal_seen {
                emit_buffered(
                    buffered,
                    &request.session_id,
                    assistant_message_id.as_deref(),
                    &sessions,
                    &events,
                    &request.request_id,
                )
                .await;
            } else if let Some(message_id) = assistant_message_id.as_deref() {
                // Text that arrived just before a terminal frame is persisted without a
                // trailing event; the terminal frame already closed the renderer.
                sessions
                    .append_delta(&request.session_id, message_id, &buffered)
                    .await;
            }
        }
    }

    if request.is_cancelled() && !overflowed {
        let assistant_message_id = assistant_message_id.clone();
        let _ = sessions
            .interrupt_assistant(&request.session_id, assistant_message_id.as_deref())
            .await;
    }

    if overflowed && request.claim_terminal() {
        let code = ErrorCode::Protocol;
        let message = format!("The response exceeded the {MAX_RESPONSE_BYTES}-byte limit.");
        release_request(&active, &request).await;
        events.prompt_event(PromptEvent::Error {
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            code,
            message: message.clone(),
        });
        let _ = sessions
            .fail_request(
                &request.session_id,
                assistant_message_id.as_deref(),
                code,
                &message,
            )
            .await;
    }

    if !request.is_cancelled() && !terminal_seen && !overflowed && request.claim_terminal() {
        let code = ErrorCode::Internal;
        let message = "The prompt ended without a terminal response from the server.";
        release_request(&active, &request).await;
        events.prompt_event(PromptEvent::Error {
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            code,
            message: message.to_owned(),
        });
        let _ = sessions
            .fail_request(
                &request.session_id,
                assistant_message_id.as_deref(),
                code,
                message,
            )
            .await;
    }

    let _ = transport.await;
    let _ = sessions.flush(&request.session_id).await;
}

async fn release_request(
    active: &Mutex<Option<Arc<TrackedRequest>>>,
    request: &Arc<TrackedRequest>,
) {
    let mut slot = active.lock().await;
    if slot
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, request))
    {
        *slot = None;
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::events::EventSink;
    use crate::protocol::{
        AppNotice, ConnectionStatus, MessageRole, PromptEvent, ResponseMetadata, ToolCall,
    };
    use crate::sessions::{SessionStore, SessionStoreOptions};
    use crate::storage::history::HistoryStore;
    use std::pin::Pin;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    pub struct RecordingSink {
        pub prompt_events: StdMutex<Vec<PromptEvent>>,
        pub last_status: StdMutex<Option<ConnectionStatus>>,
        pub history_changes: StdMutex<usize>,
        pub notices: StdMutex<Vec<AppNotice>>,
    }

    impl RecordingSink {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                prompt_events: StdMutex::new(Vec::new()),
                last_status: StdMutex::new(None),
                history_changes: StdMutex::new(0),
                notices: StdMutex::new(Vec::new()),
            })
        }

        pub fn events(&self) -> Vec<PromptEvent> {
            self.prompt_events.lock().expect("events lock").clone()
        }
    }

    impl EventSink for RecordingSink {
        fn prompt_event(&self, event: PromptEvent) {
            self.prompt_events.lock().expect("events lock").push(event);
        }

        fn connection_status(&self, status: ConnectionStatus) {
            *self.last_status.lock().expect("status lock") = Some(status);
        }

        fn history_changed(&self) {
            *self.history_changes.lock().expect("history lock") += 1;
        }

        fn notice(&self, notice: AppNotice) {
            self.notices.lock().expect("notices lock").push(notice);
        }
    }

    type TransportFn =
        Arc<dyn Fn(PromptStreamRequest) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

    struct FakeTransport {
        handler: TransportFn,
    }

    impl PromptTransport for FakeTransport {
        fn stream_prompt<'a>(
            &'a self,
            request: PromptStreamRequest,
        ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
            (self.handler)(request)
        }
    }

    struct Harness {
        coordinator: PromptCoordinator,
        sessions: SessionStore,
        sink: Arc<RecordingSink>,
        session_id: String,
        directory: std::path::PathBuf,
    }

    impl Harness {
        async fn new(handler: TransportFn) -> Self {
            let directory = tempfile::tempdir().expect("temp dir").keep();
            let sessions = SessionStore::new(
                HistoryStore::new(directory.join("history")),
                SessionStoreOptions {
                    debounce: Duration::from_millis(5),
                    ..Default::default()
                },
            );
            sessions.initialize().await.expect("initialize");
            let session_id = sessions
                .get_active_session_id()
                .await
                .expect("active session");

            let sink = RecordingSink::new();
            let transport: PromptTransportRef = Arc::new(FakeTransport { handler });
            let coordinator = PromptCoordinator::new(
                transport,
                sessions.clone(),
                sink.clone(),
                Some(Arc::new(|| "request-1".to_owned())),
            );

            Self {
                coordinator,
                sessions,
                sink,
                session_id,
                directory,
            }
        }

        async fn wait_until_idle(&self) {
            for _ in 0..200 {
                if !self.coordinator.is_busy().await {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            panic!("the coordinator did not become idle");
        }
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

    #[tokio::test]
    async fn rejects_a_concurrent_prompt_with_a_busy_error() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                request.cancel.cancelled().await;
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "first".to_owned(),
            })
            .await
            .expect("first prompt");
        let error = harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "second".to_owned(),
            })
            .await
            .expect_err("busy");
        assert_eq!(error.code, ErrorCode::Busy);
        assert!(harness.coordinator.is_busy().await);

        harness.coordinator.cancel_prompt().await;
        harness.wait_until_idle().await;
        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn assembles_deltas_completes_the_assistant_message_and_releases_the_lock() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "Hel".to_owned(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "lo".to_owned(),
                });
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: None,
                });
            })
        });
        let harness = Harness::new(handler).await;

        let result = harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "hi".to_owned(),
            })
            .await
            .expect("prompt");
        assert_eq!(result.request_id, "request-1");
        harness.wait_until_idle().await;

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        assert_eq!(
            snapshot
                .messages
                .iter()
                .map(|message| message.role)
                .collect::<Vec<_>>(),
            vec![
                crate::protocol::MessageRole::User,
                crate::protocol::MessageRole::Assistant
            ]
        );
        assert_eq!(snapshot.messages[1].content, "Hello");
        assert_eq!(
            snapshot.messages[1].status,
            crate::protocol::MessageStatus::Complete
        );
        let events = harness.sink.events();
        assert_eq!(
            event_types(&events)[0],
            "start",
            "sequence: {:?}",
            event_types(&events)
        );
        assert_eq!(
            event_types(&events).last(),
            Some(&"done"),
            "sequence: {:?}",
            event_types(&events)
        );
        let streamed: String = events
            .iter()
            .filter_map(|event| match event {
                PromptEvent::Delta { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(streamed, "Hello", "coalescing preserves ordered content");

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "again".to_owned(),
            })
            .await
            .expect("second prompt");
        harness.wait_until_idle().await;
        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn stores_done_metadata_on_the_completed_assistant_message() {
        let metadata: ResponseMetadata = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812,
            "model": "gpt-5.1"
        }))
        .expect("metadata");
        let emitted_metadata = metadata.clone();
        let handler: TransportFn = Arc::new(move |request| {
            let metadata = emitted_metadata.clone();
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "Hello".to_owned(),
                });
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: Some(Box::new(metadata)),
                });
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "hi".to_owned(),
            })
            .await
            .expect("prompt");
        harness.wait_until_idle().await;

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|message| message.role == crate::protocol::MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(assistant.status, crate::protocol::MessageStatus::Complete);
        assert_eq!(assistant.metadata, Some(metadata.clone()));
        assert!(harness.sink.events().iter().any(|event| matches!(
            event,
            PromptEvent::Done {
                metadata: Some(value),
                ..
            } if value.as_ref() == &metadata
        )));

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn leaves_metadata_absent_when_the_request_fails() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "partial".to_owned(),
                });
                (request.emit)(PromptEvent::Error {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    code: ErrorCode::Server,
                    message: "server exploded".to_owned(),
                });
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "fail".to_owned(),
            })
            .await
            .expect("prompt");
        harness.wait_until_idle().await;

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|message| message.role == crate::protocol::MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(assistant.status, crate::protocol::MessageStatus::Failed);
        assert!(assistant.metadata.is_none());
        let user = snapshot
            .messages
            .iter()
            .find(|message| message.role == crate::protocol::MessageRole::User)
            .expect("user");
        assert_eq!(user.status, crate::protocol::MessageStatus::Failed);
        assert_eq!(assistant.content, "partial");

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn cancels_a_streaming_response_keeps_partial_content_and_accepts_a_new_prompt() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "partial".to_owned(),
                });
                request.cancel.cancelled().await;
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "stop me".to_owned(),
            })
            .await
            .expect("prompt");
        for _ in 0..100 {
            if harness
                .sink
                .events()
                .iter()
                .any(|event| matches!(event, PromptEvent::Delta { .. }))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert!(harness.coordinator.cancel_prompt().await);
        assert!(!harness.coordinator.is_busy().await);

        let events = harness.sink.events();
        assert_eq!(event_types(&events), vec!["start", "delta", "cancelled"]);

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let user = snapshot
            .messages
            .iter()
            .find(|message| message.role == crate::protocol::MessageRole::User)
            .expect("user");
        let assistant = snapshot
            .messages
            .iter()
            .find(|message| message.role == crate::protocol::MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(user.status, crate::protocol::MessageStatus::Complete);
        assert_eq!(
            assistant.status,
            crate::protocol::MessageStatus::Interrupted
        );
        assert_eq!(assistant.content, "partial");

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "again".to_owned(),
            })
            .await
            .expect("second prompt");
        harness.coordinator.cancel_prompt().await;
        harness.wait_until_idle().await;

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn cancellation_before_the_assistant_starts_is_a_noop_on_repeat() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                request.cancel.cancelled().await;
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "stop me".to_owned(),
            })
            .await
            .expect("prompt");

        assert!(harness.coordinator.cancel_prompt().await);
        assert!(!harness.coordinator.cancel_prompt().await);

        assert_eq!(event_types(&harness.sink.events()), vec!["cancelled"]);
        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(
            snapshot.messages[0].role,
            crate::protocol::MessageRole::User
        );
        assert_eq!(
            snapshot.messages[0].status,
            crate::protocol::MessageStatus::Complete
        );

        harness.wait_until_idle().await;
        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn ignores_a_terminal_frame_that_arrives_after_cancellation() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "kept".to_owned(),
                });
                request.cancel.cancelled().await;
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: None,
                });
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "stop me".to_owned(),
            })
            .await
            .expect("prompt");
        for _ in 0..100 {
            if harness
                .sink
                .events()
                .iter()
                .any(|event| matches!(event, PromptEvent::Delta { .. }))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        harness.coordinator.cancel_prompt().await;
        harness.wait_until_idle().await;

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|message| message.role == crate::protocol::MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(
            assistant.status,
            crate::protocol::MessageStatus::Interrupted,
            "snapshot: {snapshot:?}"
        );
        assert_eq!(assistant.content, "kept", "snapshot: {snapshot:?}");

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn reports_an_error_when_the_transport_ends_without_a_terminal_frame() {
        let handler: TransportFn = Arc::new(|_request| Box::pin(async move {}));
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "boom".to_owned(),
            })
            .await
            .expect("prompt");
        harness.wait_until_idle().await;

        let events = harness.sink.events();
        assert_eq!(event_types(&events), vec!["error"]);
        assert!(matches!(
            &events[0],
            PromptEvent::Error {
                code: ErrorCode::Internal,
                ..
            }
        ));

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        assert_eq!(
            snapshot.messages[0].status,
            crate::protocol::MessageStatus::Failed
        );

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn rejects_empty_prompts_and_unknown_sessions_before_opening_a_stream() {
        let handler: TransportFn = Arc::new(|_request| Box::pin(async move {}));
        let harness = Harness::new(handler).await;

        let empty = harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "   ".to_owned(),
            })
            .await
            .expect_err("empty prompt");
        assert_eq!(empty.code, ErrorCode::Configuration);

        let missing = harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: "missing".to_owned(),
                text: "hello".to_owned(),
            })
            .await
            .expect_err("missing session");
        assert_eq!(missing.code, ErrorCode::NotFound);

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn a_cancel_racing_the_first_frame_interrupts_the_new_message_once() {
        let started = Arc::new(tokio::sync::Notify::new());
        let published = Arc::new(tokio::sync::Notify::new());

        let handler_started = Arc::clone(&started);
        let handler_published = Arc::clone(&published);
        let handler: TransportFn = Arc::new(move |request| {
            let started = Arc::clone(&handler_started);
            let published = Arc::clone(&handler_published);
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                started.notify_one();
                published.notified().await;
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "late".to_owned(),
                });
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: None,
                });
                request.cancel.cancelled().await;
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "race me".to_owned(),
            })
            .await
            .expect("prompt");

        started.notified().await;
        assert!(harness.coordinator.cancel_prompt().await);
        published.notify_one();

        harness.wait_until_idle().await;

        let events = harness.sink.events();
        let cancelled = events
            .iter()
            .filter(|event| matches!(event, PromptEvent::Cancelled { .. }))
            .count();
        let done = events
            .iter()
            .filter(|event| matches!(event, PromptEvent::Done { .. }))
            .count();
        assert_eq!(cancelled, 1);
        assert_eq!(done, 0);

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|entry| entry.role == crate::protocol::MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(
            assistant.status,
            crate::protocol::MessageStatus::Interrupted,
            "a message published under cancellation must not stay streaming"
        );

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn cancelled_and_done_are_never_both_delivered_for_one_request() {
        let release = Arc::new(tokio::sync::Notify::new());
        let handler_release = Arc::clone(&release);
        let handler: TransportFn = Arc::new(move |request| {
            let release = Arc::clone(&handler_release);
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "partial".to_owned(),
                });
                release.notified().await;
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: None,
                });
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "cancel then done".to_owned(),
            })
            .await
            .expect("prompt");
        for _ in 0..100 {
            if harness
                .sink
                .events()
                .iter()
                .any(|event| matches!(event, PromptEvent::Delta { .. }))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert!(harness.coordinator.cancel_prompt().await);
        assert!(!harness.coordinator.cancel_prompt().await);
        release.notify_one();
        harness.wait_until_idle().await;

        let events = harness.sink.events();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, PromptEvent::Cancelled { .. }))
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, PromptEvent::Done { .. }))
                .count(),
            0
        );

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|entry| entry.role == crate::protocol::MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(
            assistant.status,
            crate::protocol::MessageStatus::Interrupted
        );

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn shutdown_interrupts_an_in_flight_prompt_and_writes_nothing_after_the_flush() {
        let started = Arc::new(tokio::sync::Notify::new());
        let handler_started = Arc::clone(&started);
        let handler: TransportFn = Arc::new(move |request| {
            let started = Arc::clone(&handler_started);
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "partial before quit".to_owned(),
                });
                started.notify_one();
                request.cancel.cancelled().await;
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "quit mid-stream".to_owned(),
            })
            .await
            .expect("prompt");
        started.notified().await;

        harness.coordinator.shutdown().await.expect("shutdown");
        harness.wait_until_idle().await;

        let path = crate::storage::history::HistoryStore::new(harness.directory.join("history"))
            .session_path(&harness.session_id);
        let before = std::fs::read(&path).expect("read after flush");

        tokio::time::sleep(Duration::from_millis(80)).await;
        let after = std::fs::read(&path).expect("read later");
        assert_eq!(before, after, "no write may happen after the final flush");

        let persisted: serde_json::Value = serde_json::from_slice(&after).expect("json");
        let messages = persisted["messages"].as_array().expect("messages");
        let assistant = messages
            .iter()
            .find(|entry| entry["role"] == "assistant")
            .expect("assistant");
        assert_eq!(assistant["status"], "interrupted");
        assert_eq!(assistant["content"], "partial before quit");

        let _ = std::fs::remove_dir_all(&harness.directory);
    }
    #[tokio::test]
    async fn coalesces_many_deltas_into_ordered_content() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                for index in 0..500 {
                    (request.emit)(PromptEvent::Delta {
                        request_id: request.request_id.clone(),
                        content: format!("{index},"),
                    });
                }
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: None,
                });
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "stream".to_owned(),
            })
            .await
            .expect("prompt");
        harness.wait_until_idle().await;

        let expected: String = (0..500).map(|index| format!("{index},")).collect();
        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|entry| entry.role == crate::protocol::MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(assistant.content, expected);

        let forwarded: String = harness
            .sink
            .events()
            .iter()
            .filter_map(|event| match event {
                PromptEvent::Delta { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(forwarded, expected, "forwarded deltas keep arrival order");
        assert!(
            harness
                .sink
                .events()
                .iter()
                .filter(|event| matches!(event, PromptEvent::Delta { .. }))
                .count()
                < 500,
            "deltas are coalesced instead of forwarded one per frame"
        );

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn a_response_over_the_byte_cap_becomes_a_protocol_error() {
        let chunk = "x".repeat(1024 * 1024);
        let handler_chunk = chunk.clone();
        let handler: TransportFn = Arc::new(move |request| {
            let chunk = handler_chunk.clone();
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                for _ in 0..(MAX_RESPONSE_BYTES / chunk.len() + 2) {
                    if request.cancel.is_cancelled() {
                        return;
                    }
                    (request.emit)(PromptEvent::Delta {
                        request_id: request.request_id.clone(),
                        content: chunk.clone(),
                    });
                }
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "overflow".to_owned(),
            })
            .await
            .expect("prompt");
        harness.wait_until_idle().await;

        let events = harness.sink.events();
        let kinds: Vec<&str> = events
            .iter()
            .map(|event| match event {
                PromptEvent::Start { .. } => "start",
                PromptEvent::Delta { .. } => "delta",
                PromptEvent::Tool { .. } => "tool",
                PromptEvent::Done { .. } => "done",
                PromptEvent::Cancelled { .. } => "cancelled",
                PromptEvent::Error { .. } => "error",
            })
            .collect();
        let error = events
            .iter()
            .find(|event| matches!(event, PromptEvent::Error { .. }))
            .unwrap_or_else(|| panic!("expected a protocol error, saw {kinds:?}"));
        match error {
            PromptEvent::Error { code, message, .. } => {
                assert_eq!(*code, ErrorCode::Protocol);
                assert!(
                    message.contains("byte limit"),
                    "unexpected overflow message: {message}"
                );
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, PromptEvent::Done { .. })),
            "an overflowed response must not complete"
        );

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        // The user message records the failure; any assistant message that exists must
        // also be failed, and the request must not complete.
        let user = snapshot
            .messages
            .iter()
            .find(|entry| entry.role == crate::protocol::MessageRole::User)
            .expect("user");
        assert_eq!(user.status, crate::protocol::MessageStatus::Failed);
        assert_eq!(
            user.error.as_ref().map(|error| error.code.as_str()),
            Some("protocol")
        );
        for assistant in snapshot
            .messages
            .iter()
            .filter(|entry| entry.role == crate::protocol::MessageRole::Assistant)
        {
            assert_eq!(assistant.status, crate::protocol::MessageStatus::Failed);
        }

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn cancellation_mid_stream_keeps_the_text_already_buffered() {
        let release = Arc::new(tokio::sync::Notify::new());
        let handler_release = Arc::clone(&release);
        let handler: TransportFn = Arc::new(move |request| {
            let release = Arc::clone(&handler_release);
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                for _ in 0..40 {
                    (request.emit)(PromptEvent::Delta {
                        request_id: request.request_id.clone(),
                        content: "ab".to_owned(),
                    });
                }
                release.notified().await;
                request.cancel.cancelled().await;
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "cancel me".to_owned(),
            })
            .await
            .expect("prompt");
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(harness.coordinator.cancel_prompt().await);
        release.notify_one();
        harness.wait_until_idle().await;

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|entry| entry.role == crate::protocol::MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(
            assistant.status,
            crate::protocol::MessageStatus::Interrupted
        );
        assert!(
            !assistant.content.is_empty() && assistant.content.len() % 2 == 0,
            "buffered text is preserved: {:?}",
            assistant.content
        );

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    struct ToolProbeSink {
        sessions: SessionStore,
        session_id: String,
        prompt_events: StdMutex<Vec<PromptEvent>>,
        tool_snapshot: tokio::sync::mpsc::UnboundedSender<Vec<ToolCall>>,
    }

    impl EventSink for ToolProbeSink {
        fn prompt_event(&self, event: PromptEvent) {
            self.prompt_events
                .lock()
                .expect("events lock")
                .push(event.clone());
            if matches!(event, PromptEvent::Tool { .. }) {
                let sessions = self.sessions.clone();
                let session_id = self.session_id.clone();
                let sender = self.tool_snapshot.clone();
                tokio::spawn(async move {
                    let snapshot = sessions.get_snapshot(&session_id).await.expect("snapshot");
                    let calls = snapshot
                        .messages
                        .iter()
                        .find(|message| message.role == MessageRole::Assistant)
                        .and_then(|message| message.tool_calls.clone())
                        .unwrap_or_default();
                    let _ = sender.send(calls);
                });
            }
        }

        fn connection_status(&self, _status: ConnectionStatus) {}

        fn history_changed(&self) {}

        fn notice(&self, _notice: AppNotice) {}
    }

    #[tokio::test]
    async fn persists_a_tool_call_before_emitting_the_tool_event() {
        let directory = tempfile::tempdir().expect("temp dir").keep();
        let sessions = SessionStore::new(
            HistoryStore::new(directory.join("history")),
            SessionStoreOptions {
                debounce: Duration::from_millis(5),
                ..Default::default()
            },
        );
        sessions.initialize().await.expect("initialize");
        let session_id = sessions
            .get_active_session_id()
            .await
            .expect("active session");

        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let sink = Arc::new(ToolProbeSink {
            sessions: sessions.clone(),
            session_id: session_id.clone(),
            prompt_events: StdMutex::new(Vec::new()),
            tool_snapshot: sender,
        });
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "line\n".to_owned(),
                });
                (request.emit)(PromptEvent::Tool {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    id: Some("call-1".to_owned()),
                    name: "search".to_owned(),
                    arguments: serde_json::json!({ "query": "docs" }),
                    truncated: false,
                    line_index: 0,
                });
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: None,
                });
            })
        });
        let coordinator = PromptCoordinator::new(
            Arc::new(FakeTransport { handler }),
            sessions.clone(),
            sink.clone(),
            Some(Arc::new(|| "request-1".to_owned())),
        );

        coordinator
            .send_prompt(PromptSubmission {
                session_id: session_id.clone(),
                text: "use a tool".to_owned(),
            })
            .await
            .expect("prompt");
        for _ in 0..200 {
            if !coordinator.is_busy().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let calls = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .expect("the tool probe must observe the emitted event")
            .expect("probe channel");
        assert_eq!(
            calls.len(),
            1,
            "the tool call must already be stored when the event is emitted"
        );
        assert_eq!(calls[0].name, "search");
        assert_eq!(calls[0].line_index, 0);

        let events = sink.prompt_events.lock().expect("events lock").clone();
        assert_eq!(event_types(&events), vec!["start", "delta", "tool", "done"]);

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn forwards_tool_events_between_buffered_deltas_in_order() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "before\n".to_owned(),
                });
                (request.emit)(PromptEvent::Tool {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    id: Some("call-1".to_owned()),
                    name: "search".to_owned(),
                    arguments: serde_json::json!({ "query": "docs" }),
                    truncated: true,
                    line_index: 1,
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "after\n".to_owned(),
                });
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: None,
                });
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "use a tool".to_owned(),
            })
            .await
            .expect("prompt");
        harness.wait_until_idle().await;

        let events = harness.sink.events();
        assert_eq!(
            event_types(&events),
            vec!["start", "delta", "tool", "delta", "done"]
        );
        let tool = events
            .iter()
            .find(|event| matches!(event, PromptEvent::Tool { .. }))
            .expect("tool event");
        match tool {
            PromptEvent::Tool {
                id,
                name,
                arguments,
                truncated,
                line_index,
                ..
            } => {
                assert_eq!(id.as_deref(), Some("call-1"));
                assert_eq!(name, "search");
                assert_eq!(arguments["query"], "docs");
                assert!(*truncated);
                assert_eq!(*line_index, 1);
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|entry| entry.role == MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(assistant.content, "before\nafter\n");
        let calls = assistant.tool_calls.as_ref().expect("tool calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "search");
        assert_eq!(calls[0].line_index, 1);

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn stores_one_tool_call_and_keeps_terminal_metadata() {
        let metadata: ResponseMetadata = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812,
            "model": "gpt-5.1"
        }))
        .expect("metadata");
        let emitted_metadata = metadata.clone();
        let handler: TransportFn = Arc::new(move |request| {
            let metadata = emitted_metadata.clone();
            Box::pin(async move {
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Tool {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    id: Some("call-1".to_owned()),
                    name: "search".to_owned(),
                    arguments: serde_json::json!({ "query": "docs" }),
                    truncated: false,
                    line_index: 0,
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "searching the docs\n".to_owned(),
                });
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: Some(Box::new(metadata)),
                });
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "use a tool".to_owned(),
            })
            .await
            .expect("prompt");
        harness.wait_until_idle().await;

        assert_eq!(
            event_types(&harness.sink.events()),
            vec!["start", "tool", "delta", "done"]
        );

        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|entry| entry.role == MessageRole::Assistant)
            .expect("assistant");
        assert_eq!(assistant.status, crate::protocol::MessageStatus::Complete);
        assert_eq!(assistant.content, "searching the docs\n");
        assert_eq!(assistant.metadata, Some(metadata));
        let calls = assistant.tool_calls.as_ref().expect("tool calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id.as_deref(), Some("call-1"));
        assert_eq!(calls[0].name, "search");
        assert_eq!(calls[0].line_index, 0);

        let _ = std::fs::remove_dir_all(&harness.directory);
    }

    #[tokio::test]
    async fn ignores_a_tool_event_before_the_assistant_message_exists() {
        let handler: TransportFn = Arc::new(|request| {
            Box::pin(async move {
                (request.emit)(PromptEvent::Tool {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    id: None,
                    name: "search".to_owned(),
                    arguments: serde_json::json!({ "query": "docs" }),
                    truncated: false,
                    line_index: 0,
                });
                (request.emit)(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                });
                (request.emit)(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content: "ok\n".to_owned(),
                });
                (request.emit)(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: None,
                });
            })
        });
        let harness = Harness::new(handler).await;

        harness
            .coordinator
            .send_prompt(PromptSubmission {
                session_id: harness.session_id.clone(),
                text: "use a tool".to_owned(),
            })
            .await
            .expect("prompt");
        harness.wait_until_idle().await;

        assert_eq!(
            event_types(&harness.sink.events()),
            vec!["start", "delta", "done"]
        );
        let snapshot = harness
            .sessions
            .get_snapshot(&harness.session_id)
            .await
            .expect("snapshot");
        let assistant = snapshot
            .messages
            .iter()
            .find(|entry| entry.role == MessageRole::Assistant)
            .expect("assistant");
        assert!(assistant.tool_calls.is_none());

        let _ = std::fs::remove_dir_all(&harness.directory);
    }
}
