use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::errors::{AppError, ErrorCode};
use crate::events::EventSink;
use crate::iroh::client::{IrohClient, PromptStreamRequest};
use crate::protocol::{PromptEvent, PromptSubmissionResult};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveRequest {
    pub request_id: String,
    pub session_id: String,
}

struct TrackedRequest {
    request_id: String,
    session_id: String,
    assistant_message_id: std::sync::Mutex<Option<String>>,
    cancelled: AtomicBool,
    cancel: CancellationToken,
}

pub struct PromptCoordinator {
    client: PromptTransportRef,
    sessions: SessionStore,
    events: Arc<dyn EventSink>,
    id_factory: IdFactory,
    active: Arc<Mutex<Option<Arc<TrackedRequest>>>>,
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
        }
    }

    pub async fn is_busy(&self) -> bool {
        self.active.lock().await.is_some()
    }

    pub async fn get_active_request(&self) -> Option<ActiveRequest> {
        self.active
            .lock()
            .await
            .as_ref()
            .map(|request| ActiveRequest {
                request_id: request.request_id.clone(),
                session_id: request.session_id.clone(),
            })
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
                assistant_message_id: std::sync::Mutex::new(None),
                cancelled: AtomicBool::new(false),
                cancel: CancellationToken::new(),
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

        tokio::spawn(async move {
            run_prompt(client, sessions, events, active, request, input.text).await;
        });

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

        request.cancelled.store(true, Ordering::SeqCst);
        request.cancel.cancel();
        self.events.prompt_event(PromptEvent::Cancelled {
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
        });

        let assistant_message_id = request
            .assistant_message_id
            .lock()
            .expect("the assistant message lock is not poisoned")
            .clone();
        let _ = self
            .sessions
            .interrupt_assistant(&request.session_id, assistant_message_id.as_deref())
            .await;

        true
    }

    pub async fn shutdown(&self) -> Result<(), AppError> {
        self.sessions.flush_all().await
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

    let transport_request = Arc::clone(&request);
    let transport = tokio::spawn(async move {
        client
            .stream_prompt(PromptStreamRequest {
                request_id: transport_request.request_id.clone(),
                session_id: transport_request.session_id.clone(),
                text,
                emit: Arc::new(move |event| {
                    let _ = sender.send(event);
                }),
                cancel: transport_request.cancel.clone(),
            })
            .await;
    });

    let mut assistant_message_id: Option<String> = None;
    let mut terminal_seen = false;

    while let Some(event) = receiver.recv().await {
        if request.cancelled.load(Ordering::SeqCst) {
            continue;
        }

        match event {
            PromptEvent::Start { session_id, .. } => {
                if assistant_message_id.is_none() {
                    match sessions.begin_assistant_message(&session_id).await {
                        Ok(message) => {
                            assistant_message_id = Some(message.id.clone());
                            *request
                                .assistant_message_id
                                .lock()
                                .expect("the assistant message lock is not poisoned") =
                                Some(message.id);
                        }
                        Err(error) => {
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
                            continue;
                        }
                    }
                }

                events.prompt_event(PromptEvent::Start {
                    request_id: request.request_id.clone(),
                    session_id,
                });
            }
            PromptEvent::Delta { content, .. } => {
                if let Some(message_id) = assistant_message_id.as_deref() {
                    sessions
                        .append_delta(&request.session_id, message_id, &content)
                        .await;
                }
                events.prompt_event(PromptEvent::Delta {
                    request_id: request.request_id.clone(),
                    content,
                });
            }
            PromptEvent::Done { metadata, .. } => {
                release_request(&active, &request).await;
                events.prompt_event(PromptEvent::Done {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    metadata: metadata.clone(),
                });
                if let Some(message_id) = assistant_message_id.as_deref() {
                    let _ = sessions
                        .complete_assistant(
                            &request.session_id,
                            message_id,
                            metadata.map(|value| *value),
                        )
                        .await;
                }
                terminal_seen = true;
            }
            PromptEvent::Error { code, message, .. } => {
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
                terminal_seen = true;
            }
            PromptEvent::Cancelled { .. } => {}
        }
    }

    if !request.cancelled.load(Ordering::SeqCst) && !terminal_seen {
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
    use crate::protocol::{AppNotice, ConnectionStatus, PromptEvent, ResponseMetadata};
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
        assert_eq!(
            event_types(&harness.sink.events()),
            vec!["start", "delta", "delta", "done"]
        );

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
            crate::protocol::MessageStatus::Interrupted
        );
        assert_eq!(assistant.content, "kept");

        harness.wait_until_idle().await;
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
}
