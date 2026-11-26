use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{Connection, Endpoint};
use iroh::SecretKey;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::errors::{map_iroh_error_with, AppError, ErrorCode};
use crate::iroh::bindings::endpoint_builder;
use crate::line_decoder::LineDecoder;
use crate::protocol::{
    parse_server_frame, serialize_prompt, ClientConfig, ConnectionStatus, PromptEvent,
    PromptStateMachine,
};
use crate::targets::resolve_address;

pub const ALPN_PROTOCOL: &[u8] = b"iroh-channel/1";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
pub const PROMPT_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
pub const READ_CHUNK_BYTES: usize = 64 * 1024;

pub type StatusCallback = Arc<dyn Fn(ConnectionStatus) + Send + Sync>;
pub type EventEmitter = Arc<dyn Fn(PromptEvent) + Send + Sync>;
pub type ConfigProvider = Arc<dyn Fn() -> ClientConfig + Send + Sync>;

pub struct PromptStreamRequest {
    pub request_id: String,
    pub session_id: String,
    pub text: String,
    pub emit: EventEmitter,
    pub cancel: CancellationToken,
}

enum OpenError {
    Cancelled,
    Failed(AppError),
}

struct Shared {
    status: std::sync::Mutex<ConnectionStatus>,
    on_status: Option<StatusCallback>,
    connection: Mutex<Option<Connection>>,
}

impl Shared {
    fn get_status(&self) -> ConnectionStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_status(&self, status: ConnectionStatus) {
        let changed = {
            let mut current = self
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *current == status {
                false
            } else {
                *current = status.clone();
                true
            }
        };

        if changed {
            if let Some(callback) = &self.on_status {
                callback(status);
            }
        }
    }
}

pub struct IrohClient {
    secret_key: SecretKey,
    get_config: ConfigProvider,
    connect_timeout: Duration,
    idle_timeout: Duration,
    endpoint: Mutex<Option<Endpoint>>,
    shared: Arc<Shared>,
    shutting_down: AtomicBool,
    connecting: Mutex<Option<CancellationToken>>,
}

impl IrohClient {
    pub fn new(
        secret_key: SecretKey,
        get_config: ConfigProvider,
        on_status: Option<StatusCallback>,
        connect_timeout: Option<Duration>,
    ) -> Self {
        Self {
            secret_key,
            get_config,
            connect_timeout: connect_timeout.unwrap_or(CONNECT_TIMEOUT),
            idle_timeout: PROMPT_IDLE_TIMEOUT,
            endpoint: Mutex::new(None),
            shared: Arc::new(Shared {
                status: std::sync::Mutex::new(ConnectionStatus::disconnected()),
                on_status,
                connection: Mutex::new(None),
            }),
            shutting_down: AtomicBool::new(false),
            connecting: Mutex::new(None),
        }
    }

    pub fn get_status(&self) -> ConnectionStatus {
        self.shared.get_status()
    }

    pub fn connect(&self) -> impl std::future::Future<Output = ConnectionStatus> + '_ {
        self.connect_with(None)
    }

    pub async fn restart(&self) -> ConnectionStatus {
        self.shutting_down.store(false, Ordering::SeqCst);
        self.connect().await
    }

    async fn connect_with(&self, cancel: Option<CancellationToken>) -> ConnectionStatus {
        if cancel.is_none() {
            self.shutting_down.store(false, Ordering::SeqCst);
        }
        let _ = self.ensure_connection_with(cancel).await;
        self.get_status()
    }

    pub async fn ensure_connection(&self) -> Result<Connection, AppError> {
        self.ensure_connection_with(None).await
    }

    pub async fn ensure_connection_with(
        &self,
        cancel: Option<CancellationToken>,
    ) -> Result<Connection, AppError> {
        let mut slot = self.shared.connection.lock().await;
        if let Some(connection) = slot.as_ref() {
            if !connection.close_reason().is_some() {
                return Ok(connection.clone());
            }
            *slot = None;
        }

        let connection = self.establish_connection(cancel.clone()).await?;
        *slot = Some(connection.clone());
        drop(slot);
        self.watch_connection(connection.clone());
        Ok(connection)
    }

    pub async fn disconnect(&self) {
        if let Some(cancel) = self.connecting.lock().await.take() {
            cancel.cancel();
        }

        let connection = {
            let mut slot = self.shared.connection.lock().await;
            slot.take()
        };
        if let Some(connection) = connection {
            connection.close(0u32.into(), b"");
        }

        let config = (self.get_config)();
        let relay_mode = crate::iroh::bindings::relay_mode_for(config.relay_url.as_deref()).ok();
        let keep_endpoint = {
            let mut slot = self.endpoint.lock().await;
            match (slot.as_ref(), relay_mode) {
                (Some(_), Some(_)) => true,
                (Some(_), None) => {
                    slot.take();
                    false
                }
                (None, _) => false,
            }
        };
        if !keep_endpoint {
            let endpoint = self.endpoint.lock().await.take();
            if let Some(endpoint) = endpoint {
                endpoint.close().await;
            }
        }

        self.shared.set_status(ConnectionStatus::disconnected());
    }

    pub async fn close(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.disconnect().await;
        let endpoint = self.endpoint.lock().await.take();
        if let Some(endpoint) = endpoint {
            endpoint.close().await;
        }
    }

    pub async fn stream_prompt(&self, request: PromptStreamRequest) {
        let cancel = request.cancel.clone();
        let emit = Arc::clone(&request.emit);
        let mut machine = PromptStateMachine::new(
            request.request_id.clone(),
            request.session_id.clone(),
            move |event: PromptEvent| emit(event),
        );

        if cancel.is_cancelled() {
            return;
        }

        let connection = match self.open_with_reconnect(&cancel).await {
            Ok(stream) => stream,
            Err(OpenError::Cancelled) => return,
            Err(OpenError::Failed(error)) => {
                if !cancel.is_cancelled() {
                    machine.handle_transport_error(&error);
                }
                return;
            }
        };
        let (mut send, mut recv) = connection;

        let line = serialize_prompt(&request.session_id, &request.text);
        let written = tokio::select! {
            _ = cancel.cancelled() => None,
            result = send.write_all(line.as_bytes()) => Some(result),
        };
        match written {
            None => {
                let _ = recv.stop(0u32.into());
                return;
            }
            Some(Err(error)) => {
                if !cancel.is_cancelled() {
                    machine.handle_transport_error(&error);
                }
                let _ = recv.stop(0u32.into());
                return;
            }
            Some(Ok(())) => {}
        }
        let _ = send.finish();

        let mut decoder = LineDecoder::new();
        let mut buffer = vec![0u8; READ_CHUNK_BYTES];

        loop {
            if machine.is_settled() || cancel.is_cancelled() {
                break;
            }

            let read = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = recv.stop(0u32.into());
                    return;
                }
                result = tokio::time::timeout(self.idle_timeout, recv.read(&mut buffer)) => result,
            };

            let read = match read {
                Err(_elapsed) => {
                    if !cancel.is_cancelled() {
                        machine.handle_transport_error(&AppError::new(
                            ErrorCode::Timeout,
                            format!(
                                "The server stopped responding for {} seconds. Reconnect and try again.",
                                self.idle_timeout.as_secs()
                            ),
                        ));
                    }
                    break;
                }
                Ok(result) => result,
            };

            match read {
                Ok(Some(size)) if size > 0 => {
                    let lines = match decoder.push(&buffer[..size]) {
                        Ok(lines) => lines,
                        Err(error) => {
                            machine.handle_transport_error(&error);
                            break;
                        }
                    };
                    if forward_lines(&mut machine, lines).is_err() {
                        break;
                    }
                }
                Ok(_) => {
                    match decoder.end() {
                        Ok(lines) => {
                            let _ = forward_lines(&mut machine, lines);
                        }
                        Err(error) => machine.handle_transport_error(&error),
                    }
                    break;
                }
                Err(error) => {
                    if !cancel.is_cancelled() {
                        machine.handle_transport_error(&error);
                    }
                    break;
                }
            }
        }

        if !machine.is_settled() && !cancel.is_cancelled() {
            machine.handle_eof();
        }

        let _ = recv.stop(0u32.into());
    }

    async fn open_with_reconnect(
        &self,
        cancel: &CancellationToken,
    ) -> Result<(iroh::endpoint::SendStream, iroh::endpoint::RecvStream), OpenError> {
        let connection = self.ensure_connection_with(Some(cancel.clone())).await;
        let connection = match connection {
            Ok(connection) => connection,
            Err(error) => return Err(OpenError::Failed(error)),
        };

        let opened = tokio::select! {
            _ = cancel.cancelled() => Err(OpenError::Cancelled),
            result = connection.open_bi() => Ok(result),
        }?;
        let opened = match opened {
            Ok(stream) => Ok(stream),
            Err(_) => {
                self.shared.connection.lock().await.take();
                let reconnected = self.ensure_connection_with(Some(cancel.clone())).await;
                match reconnected {
                    Ok(connection) => tokio::select! {
                        _ = cancel.cancelled() => Err(OpenError::Cancelled),
                        result = connection.open_bi() => match result {
                            Ok(stream) => Ok(stream),
                            Err(error) => Err(OpenError::Failed(map_iroh_error_with(&error, true))),
                        },
                    },
                    Err(error) => Err(OpenError::Failed(error)),
                }
            }
        };
        opened
    }

    async fn establish_connection(
        &self,
        cancel: Option<CancellationToken>,
    ) -> Result<Connection, AppError> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(AppError::new(
                ErrorCode::ConnectionClosed,
                "The Iroh endpoint has been shut down.",
            ));
        }

        self.shared.set_status(ConnectionStatus::connecting());

        let attempt_token = CancellationToken::new();
        if let Some(cancel) = &cancel {
            if cancel.is_cancelled() {
                self.shared.set_status(ConnectionStatus::disconnected());
                return Err(AppError::new(
                    ErrorCode::ConnectionClosed,
                    "The connection attempt was cancelled.",
                ));
            }
        }
        *self.connecting.lock().await = Some(attempt_token.clone());

        let interrupted = async {
            attempt_token.cancelled().await;
            AppError::new(
                ErrorCode::ConnectionClosed,
                "The connection attempt was cancelled.",
            )
        };

        let result = async {
            let endpoint = self.get_endpoint().await?;
            let address = self.resolve_target()?;
            let attempt = self.connect_with_timeout(&endpoint, address);
            match &cancel {
                Some(cancel) => tokio::select! {
                    interrupted = interrupted => Err(interrupted),
                    _ = cancel.cancelled() => Err(AppError::new(
                        ErrorCode::ConnectionClosed,
                        "The connection attempt was cancelled.",
                    )),
                    result = attempt => result,
                },
                None => tokio::select! {
                    interrupted = interrupted => Err(interrupted),
                    result = attempt => result,
                },
            }
        }
        .await;

        {
            let mut slot = self.connecting.lock().await;
            if slot.as_ref().is_some_and(|token| token == &attempt_token) {
                *slot = None;
            }
        }

        match result {
            Ok(connection) => {
                self.shared.set_status(ConnectionStatus::connected());
                Ok(connection)
            }
            Err(error) => {
                if error.code == ErrorCode::ConnectionClosed {
                    self.shared.set_status(ConnectionStatus::disconnected());
                } else {
                    self.shared
                        .set_status(ConnectionStatus::error(error.message.clone()));
                }
                Err(error)
            }
        }
    }

    async fn get_endpoint(&self) -> Result<Endpoint, AppError> {
        let mut slot = self.endpoint.lock().await;
        if let Some(endpoint) = slot.as_ref() {
            return Ok(endpoint.clone());
        }

        let config = (self.get_config)();
        let relay_mode = crate::iroh::bindings::relay_mode_for(config.relay_url.as_deref())?;
        let endpoint = endpoint_builder(&self.secret_key)
            .alpns(vec![ALPN_PROTOCOL.to_vec()])
            .relay_mode(relay_mode)
            .bind()
            .await
            .map_err(|error| map_iroh_error_with(&error, false))?;

        *slot = Some(endpoint.clone());
        Ok(endpoint)
    }

    fn resolve_target(&self) -> Result<iroh::EndpointAddr, AppError> {
        resolve_address(&(self.get_config)())
    }

    async fn connect_with_timeout(
        &self,
        endpoint: &Endpoint,
        address: iroh::EndpointAddr,
    ) -> Result<Connection, AppError> {
        let attempt = endpoint.connect(address, ALPN_PROTOCOL);
        match tokio::time::timeout(self.connect_timeout, attempt).await {
            Ok(Ok(connection)) => Ok(connection),
            Ok(Err(error)) => Err(map_iroh_error_with(&error, false)),
            Err(_) => Err(AppError::new(
                ErrorCode::Timeout,
                format!(
                    "The server did not respond within {} seconds. Check the server ticket or NodeId, the relay URL, and that the server is online.",
                    self.connect_timeout.as_secs()
                ),
            )),
        }
    }

    fn watch_connection(&self, connection: Connection) {
        let shared = Arc::clone(&self.shared);
        let watched = connection.clone();

        tokio::spawn(async move {
            let _ = watched.closed().await;

            let mut slot = shared.connection.lock().await;
            let is_current = slot
                .as_ref()
                .is_some_and(|current| current.stable_id() == watched.stable_id());
            if is_current {
                *slot = None;
                drop(slot);
                shared.set_status(ConnectionStatus::disconnected());
            }
        });
    }
}

fn forward_lines(machine: &mut PromptStateMachine<'_>, lines: Vec<String>) -> Result<(), ()> {
    for line in lines {
        if machine.is_settled() {
            return Ok(());
        }
        match parse_server_frame(&line) {
            Ok(Some(frame)) => machine.handle_frame(frame),
            Ok(None) => {}
            Err(error) => {
                machine.handle_transport_error(&error);
                return Err(());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ConnectionState, PromptEvent};
    use iroh::endpoint::{presets, RecvStream, SendStream};
    use iroh_tickets::endpoint::EndpointTicket;
    use std::future::Future;
    use std::sync::Mutex as StdMutex;

    async fn read_prompt_line(recv: &mut RecvStream) -> String {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];

        loop {
            match recv.read(&mut chunk).await {
                Ok(Some(size)) => {
                    buffer.extend_from_slice(&chunk[..size]);
                    if buffer.contains(&b'\n') {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }

        String::from_utf8_lossy(&buffer).into_owned()
    }

    async fn write_line(send: &mut SendStream, value: serde_json::Value) {
        let line = format!("{value}\n");
        send.write_all(line.as_bytes()).await.expect("write line");
    }

    async fn start_mock_server<F, Fut>(handler: F) -> (Endpoint, String)
    where
        F: FnOnce(Connection, SendStream, RecvStream) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![ALPN_PROTOCOL.to_vec()])
            .bind_addr("127.0.0.1:0")
            .expect("bind address")
            .bind()
            .await
            .expect("bind endpoint");
        let ticket = EndpointTicket::new(endpoint.addr()).to_string();

        let accepting = endpoint.clone();
        tokio::spawn(async move {
            let Some(incoming) = accepting.accept().await else {
                return;
            };
            let Ok(connection) = incoming.await else {
                return;
            };
            let Ok((send, recv)) = connection.accept_bi().await else {
                return;
            };
            handler(connection.clone(), send, recv).await;
            let _ = connection.closed().await;
        });

        (endpoint, ticket)
    }

    fn create_client(
        ticket: String,
        statuses: Option<Arc<StdMutex<Vec<ConnectionStatus>>>>,
    ) -> IrohClient {
        let config = ClientConfig {
            server_ticket: Some(ticket),
            server_node_id: None,
            relay_url: None,
        };
        let on_status = statuses.map(|statuses| {
            let callback: StatusCallback = Arc::new(move |status: ConnectionStatus| {
                statuses.lock().expect("status lock").push(status);
            });
            callback
        });

        IrohClient::new(
            SecretKey::generate(),
            Arc::new(move || config.clone()),
            on_status,
            Some(Duration::from_secs(15)),
        )
    }

    fn create_client_with_idle(ticket: String, idle: Duration) -> IrohClient {
        let config = ClientConfig {
            server_ticket: Some(ticket),
            server_node_id: None,
            relay_url: None,
        };
        let mut client = IrohClient::new(
            SecretKey::generate(),
            Arc::new(move || config.clone()),
            None,
            Some(Duration::from_secs(15)),
        );
        client.idle_timeout = idle;
        client
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

    async fn collect_prompt(
        client: &IrohClient,
        request_id: &str,
        session_id: &str,
        text: &str,
        cancel: CancellationToken,
    ) -> Vec<PromptEvent> {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let emitted = Arc::clone(&events);
        client
            .stream_prompt(PromptStreamRequest {
                request_id: request_id.to_owned(),
                session_id: session_id.to_owned(),
                text: text.to_owned(),
                emit: Arc::new(move |event| {
                    emitted.lock().expect("event lock").push(event);
                }),
                cancel,
            })
            .await;
        let collected = events.lock().expect("event lock").clone();
        collected
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sends_the_exact_prompt_line_and_receives_start_deltas_and_done() {
        let (received_tx, received_rx) = tokio::sync::oneshot::channel();
        let (server, ticket) = start_mock_server(|_connection, mut send, mut recv| async move {
            let line = read_prompt_line(&mut recv).await;
            let _ = received_tx.send(line);
            write_line(
                &mut send,
                serde_json::json!({ "type": "start", "session_id": "session-1" }),
            )
            .await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "delta", "content": "Hel" }),
            )
            .await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "delta", "content": "lo" }),
            )
            .await;
            write_line(&mut send, serde_json::json!({ "type": "done" })).await;
            let _ = send.finish();
        })
        .await;

        let statuses = Arc::new(StdMutex::new(Vec::new()));
        let client = create_client(ticket, Some(Arc::clone(&statuses)));
        let events = collect_prompt(
            &client,
            "request-1",
            "session-1",
            "hello",
            CancellationToken::new(),
        )
        .await;

        assert_eq!(
            received_rx.await.expect("received prompt"),
            "{\"type\":\"prompt\",\"session_id\":\"session-1\",\"text\":\"hello\"}\n"
        );
        assert_eq!(
            event_types(&events),
            vec!["start", "delta", "delta", "done"]
        );
        let content: String = events
            .iter()
            .filter_map(|event| match event {
                PromptEvent::Delta { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(content, "Hello");

        let states: Vec<ConnectionState> = statuses
            .lock()
            .expect("status lock")
            .iter()
            .map(|status| status.state)
            .collect();
        assert_eq!(
            states,
            vec![ConnectionState::Connecting, ConnectionState::Connected]
        );

        client.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn surfaces_a_server_error_message() {
        let (server, ticket) = start_mock_server(|_connection, mut send, mut recv| async move {
            let _ = read_prompt_line(&mut recv).await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "start", "session_id": "session-1" }),
            )
            .await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "error", "message": "model overloaded" }),
            )
            .await;
            let _ = send.finish();
        })
        .await;

        let client = create_client(ticket, None);
        let events = collect_prompt(
            &client,
            "request-1",
            "session-1",
            "hello",
            CancellationToken::new(),
        )
        .await;

        assert_eq!(event_types(&events), vec!["start", "error"]);
        assert!(matches!(
            &events[1],
            PromptEvent::Error { code: ErrorCode::Server, message, .. } if message == "model overloaded"
        ));

        client.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reports_an_early_eof_with_the_allowlist_hint() {
        let (server, ticket) = start_mock_server(|_connection, mut send, mut recv| async move {
            let _ = read_prompt_line(&mut recv).await;
            let _ = send.finish();
        })
        .await;

        let client = create_client(ticket, None);
        let events = collect_prompt(
            &client,
            "request-1",
            "session-1",
            "hello",
            CancellationToken::new(),
        )
        .await;

        assert_eq!(events.len(), 1);
        match &events[0] {
            PromptEvent::Error { code, message, .. } => {
                assert_eq!(*code, ErrorCode::ConnectionClosed);
                assert!(message.contains("/iroh_allow"));
            }
            other => panic!("unexpected event: {other:?}"),
        }

        client.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fails_the_request_on_malformed_json() {
        let (server, ticket) = start_mock_server(|_connection, mut send, mut recv| async move {
            let _ = read_prompt_line(&mut recv).await;
            send.write_all(b"not-json\n").await.expect("write");
            let _ = send.finish();
        })
        .await;

        let client = create_client(ticket, None);
        let events = collect_prompt(
            &client,
            "request-1",
            "session-1",
            "hello",
            CancellationToken::new(),
        )
        .await;

        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            PromptEvent::Error {
                code: ErrorCode::Protocol,
                ..
            }
        ));

        client.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ignores_unknown_frames_and_stops_after_a_terminal_frame() {
        let (server, ticket) = start_mock_server(|_connection, mut send, mut recv| async move {
            let _ = read_prompt_line(&mut recv).await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "start", "session_id": "session-1" }),
            )
            .await;
            write_line(&mut send, serde_json::json!({ "type": "heartbeat" })).await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "delta", "content": "ok" }),
            )
            .await;
            write_line(&mut send, serde_json::json!({ "type": "done" })).await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "delta", "content": "late" }),
            )
            .await;
            let _ = send.finish();
        })
        .await;

        let client = create_client(ticket, None);
        let events = collect_prompt(
            &client,
            "request-1",
            "session-1",
            "hello",
            CancellationToken::new(),
        )
        .await;

        assert_eq!(event_types(&events), vec!["start", "delta", "done"]);

        client.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_stops_reading_and_emits_no_error() {
        let (server, ticket) = start_mock_server(|_connection, mut send, mut recv| async move {
            let _ = read_prompt_line(&mut recv).await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "start", "session_id": "session-1" }),
            )
            .await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "delta", "content": "partial" }),
            )
            .await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        })
        .await;

        let client = create_client(ticket, None);
        let cancel = CancellationToken::new();
        let cancel_task = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                cancel.cancel();
            })
        };
        let events_holder = Arc::new(StdMutex::new(Vec::new()));
        let emitted = Arc::clone(&events_holder);

        tokio::time::timeout(
            Duration::from_secs(5),
            client.stream_prompt(PromptStreamRequest {
                request_id: "request-1".to_owned(),
                session_id: "session-1".to_owned(),
                text: "hello".to_owned(),
                emit: Arc::new(move |event| {
                    emitted.lock().expect("event lock").push(event);
                }),
                cancel,
            }),
        )
        .await
        .expect("stream should stop after cancellation");
        cancel_task.await.expect("cancel task");

        let events = events_holder.lock().expect("event lock").clone();
        assert_eq!(event_types(&events), vec!["start", "delta"]);

        client.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnects_and_reconnects_after_a_closed_connection() {
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![ALPN_PROTOCOL.to_vec()])
            .bind_addr("127.0.0.1:0")
            .expect("bind address")
            .bind()
            .await
            .expect("bind endpoint");
        let ticket = EndpointTicket::new(endpoint.addr()).to_string();

        let accepting = endpoint.clone();
        tokio::spawn(async move {
            let Some(incoming) = accepting.accept().await else {
                return;
            };
            let Ok(connection) = incoming.await else {
                return;
            };
            connection.close(0u32.into(), b"done");
        });

        let client = create_client(ticket, None);
        let status = client.connect().await;
        assert_eq!(status.state, ConnectionState::Connected);

        for _ in 0..100 {
            if client.get_status().state == ConnectionState::Disconnected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(client.get_status().state, ConnectionState::Disconnected);

        client.close().await;
        endpoint.close().await;
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fails_with_a_timeout_when_the_server_goes_silent_after_start() {
        let (server, ticket) = start_mock_server(|_connection, mut send, mut recv| async move {
            let _ = read_prompt_line(&mut recv).await;
            write_line(
                &mut send,
                serde_json::json!({ "type": "start", "session_id": "session-1" }),
            )
            .await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        })
        .await;

        let client = create_client_with_idle(ticket, Duration::from_millis(150));
        let events = collect_prompt(
            &client,
            "request-1",
            "session-1",
            "hello",
            CancellationToken::new(),
        )
        .await;

        assert_eq!(event_types(&events), vec!["start", "error"]);
        assert!(matches!(
            &events[1],
            PromptEvent::Error {
                code: ErrorCode::Timeout,
                ..
            }
        ));

        client.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_during_connect_stops_the_prompt_without_an_error() {
        // Nothing listens for this ticket, so the connect attempt cannot complete.
        let unreachable =
            EndpointTicket::new(iroh::EndpointAddr::new(SecretKey::generate().public()))
                .to_string();
        let config = ClientConfig {
            server_ticket: Some(unreachable),
            server_node_id: None,
            relay_url: None,
        };
        let client = IrohClient::new(
            SecretKey::generate(),
            Arc::new(move || config.clone()),
            None,
            Some(Duration::from_secs(30)),
        );

        let cancel = CancellationToken::new();
        let canceller = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                cancel.cancel();
            })
        };

        let events = tokio::time::timeout(
            Duration::from_secs(10),
            collect_prompt(&client, "request-1", "session-1", "hello", cancel),
        )
        .await
        .expect("cancellation must interrupt the connect attempt");
        canceller.await.expect("canceller");

        assert!(
            events.is_empty(),
            "cancellation during connect emits no error: {events:?}"
        );

        client.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnect_interrupts_a_pending_connect_instead_of_waiting_for_its_timeout() {
        let config = ClientConfig {
            server_ticket: Some(
                EndpointTicket::new(iroh::EndpointAddr::new(SecretKey::generate().public()))
                    .to_string(),
            ),
            server_node_id: None,
            relay_url: None,
        };
        let client = Arc::new(IrohClient::new(
            SecretKey::generate(),
            Arc::new(move || config.clone()),
            None,
            Some(Duration::from_secs(30)),
        ));

        let connecting = {
            let client = Arc::clone(&client);
            tokio::spawn(async move { client.connect().await })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        tokio::time::timeout(Duration::from_secs(10), client.disconnect())
            .await
            .expect("disconnect must not wait for the connect timeout");

        let status = tokio::time::timeout(Duration::from_secs(10), connecting)
            .await
            .expect("the connect attempt must end")
            .expect("join");
        assert_ne!(status.state, ConnectionState::Connected);

        client.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reconnects_when_the_cached_connection_has_closed() {
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![ALPN_PROTOCOL.to_vec()])
            .bind_addr("127.0.0.1:0")
            .expect("bind address")
            .bind()
            .await
            .expect("bind endpoint");
        let ticket = EndpointTicket::new(endpoint.addr()).to_string();

        let accepting = endpoint.clone();
        tokio::spawn(async move {
            // Serve two connections: the first closes after one prompt, the second serves another.
            for round in 0..2 {
                let Some(incoming) = accepting.accept().await else {
                    return;
                };
                let Ok(connection) = incoming.await else {
                    return;
                };
                let Ok((mut send, mut recv)) = connection.accept_bi().await else {
                    return;
                };
                let _ = read_prompt_line(&mut recv).await;
                write_line(
                    &mut send,
                    serde_json::json!({ "type": "start", "session_id": "session-1" }),
                )
                .await;
                write_line(&mut send, serde_json::json!({ "type": "done" })).await;
                let _ = send.finish();
                if round == 0 {
                    // Give the client time to consume the frames before dropping the stream.
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    connection.close(0u32.into(), b"bye");
                } else {
                    let _ = connection.closed().await;
                }
            }
        });

        let client = create_client(ticket, None);
        let first = collect_prompt(
            &client,
            "request-1",
            "session-1",
            "hello",
            CancellationToken::new(),
        )
        .await;
        assert!(
            event_types(&first) == vec!["start", "done"],
            "first prompt failed: {first:?}"
        );

        for _ in 0..100 {
            if client.get_status().state == ConnectionState::Disconnected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let second = collect_prompt(
            &client,
            "request-2",
            "session-1",
            "again",
            CancellationToken::new(),
        )
        .await;
        assert!(
            event_types(&second) == vec!["start", "done"],
            "the second prompt must reconnect instead of reusing a closed connection: {second:?}"
        );

        client.close().await;
        endpoint.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restart_reconnects_after_a_permanent_close() {
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![ALPN_PROTOCOL.to_vec()])
            .bind_addr("127.0.0.1:0")
            .expect("bind address")
            .bind()
            .await
            .expect("bind endpoint");
        let ticket = EndpointTicket::new(endpoint.addr()).to_string();

        let accepting = endpoint.clone();
        tokio::spawn(async move {
            for _ in 0..2 {
                let Some(incoming) = accepting.accept().await else {
                    return;
                };
                let Ok(connection) = incoming.await else {
                    return;
                };
                let Ok((mut send, mut recv)) = connection.accept_bi().await else {
                    return;
                };
                let _ = read_prompt_line(&mut recv).await;
                write_line(
                    &mut send,
                    serde_json::json!({ "type": "start", "session_id": "session-1" }),
                )
                .await;
                write_line(&mut send, serde_json::json!({ "type": "done" })).await;
                let _ = send.finish();
                let _ = connection.closed().await;
            }
        });

        let client = create_client(ticket, None);
        let first = collect_prompt(
            &client,
            "request-1",
            "session-1",
            "hello",
            CancellationToken::new(),
        )
        .await;
        assert_eq!(event_types(&first), vec!["start", "done"]);

        client.close().await;
        assert_ne!(client.get_status().state, ConnectionState::Connected);

        let status = client.restart().await;
        assert_eq!(
            status.state,
            ConnectionState::Connected,
            "restart must clear the permanent shutdown flag"
        );

        client.close().await;
        endpoint.close().await;
    }
}
