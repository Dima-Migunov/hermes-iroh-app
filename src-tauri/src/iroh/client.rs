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
use crate::targets::{parse_node_address, parse_ticket_address};

pub const ALPN_PROTOCOL: &[u8] = b"iroh-channel/1";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
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

struct Shared {
    status: std::sync::Mutex<ConnectionStatus>,
    on_status: Option<StatusCallback>,
    connection: Mutex<Option<Connection>>,
}

impl Shared {
    fn get_status(&self) -> ConnectionStatus {
        self.status
            .lock()
            .expect("the connection status lock is not poisoned")
            .clone()
    }

    fn set_status(&self, status: ConnectionStatus) {
        let changed = {
            let mut current = self
                .status
                .lock()
                .expect("the connection status lock is not poisoned");
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
    endpoint: Mutex<Option<Endpoint>>,
    shared: Arc<Shared>,
    shutting_down: AtomicBool,
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
            endpoint: Mutex::new(None),
            shared: Arc::new(Shared {
                status: std::sync::Mutex::new(ConnectionStatus::disconnected()),
                on_status,
                connection: Mutex::new(None),
            }),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn get_status(&self) -> ConnectionStatus {
        self.shared.get_status()
    }

    pub async fn connect(&self) -> ConnectionStatus {
        self.shutting_down.store(false, Ordering::SeqCst);
        if let Err(_error) = self.ensure_connection().await {
            // The status already carries the mapped failure.
        }
        self.get_status()
    }

    pub async fn ensure_connection(&self) -> Result<Connection, AppError> {
        let mut slot = self.shared.connection.lock().await;
        if let Some(connection) = slot.as_ref() {
            return Ok(connection.clone());
        }

        let connection = self.establish_connection().await?;
        *slot = Some(connection.clone());
        self.watch_connection(connection.clone());
        Ok(connection)
    }

    pub async fn disconnect(&self) {
        let connection = {
            let mut slot = self.shared.connection.lock().await;
            slot.take()
        };
        if let Some(connection) = connection {
            connection.close(0u32.into(), b"");
        }

        let endpoint = {
            let mut slot = self.endpoint.lock().await;
            slot.take()
        };
        if let Some(endpoint) = endpoint {
            endpoint.close().await;
        }

        self.shared.set_status(ConnectionStatus::disconnected());
    }

    pub async fn close(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.disconnect().await;
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

        let connection = match self.ensure_connection().await {
            Ok(connection) => connection,
            Err(error) => {
                if !cancel.is_cancelled() {
                    machine.handle_transport_error(&error);
                }
                return;
            }
        };

        if cancel.is_cancelled() {
            return;
        }

        let opened = tokio::select! {
            _ = cancel.cancelled() => return,
            result = connection.open_bi() => result,
        };
        let (mut send, mut recv) = match opened {
            Ok(stream) => stream,
            Err(error) => {
                if !cancel.is_cancelled() {
                    machine.handle_transport_error(&error);
                }
                return;
            }
        };

        let line = serialize_prompt(&request.session_id, &request.text);
        if let Err(error) = send.write_all(line.as_bytes()).await {
            if !cancel.is_cancelled() {
                machine.handle_transport_error(&error);
            }
            let _ = recv.stop(0u32.into());
            return;
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
                result = recv.read(&mut buffer) => result,
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

    async fn establish_connection(&self) -> Result<Connection, AppError> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(AppError::new(
                ErrorCode::ConnectionClosed,
                "The Iroh endpoint has been shut down.",
            ));
        }

        self.shared.set_status(ConnectionStatus::connecting());

        let result = async {
            let endpoint = self.get_endpoint().await?;
            let address = self.resolve_target()?;
            self.connect_with_timeout(&endpoint, address).await
        }
        .await;

        match result {
            Ok(connection) => {
                self.shared.set_status(ConnectionStatus::connected());
                Ok(connection)
            }
            Err(error) => {
                self.shared
                    .set_status(ConnectionStatus::error(error.message.clone()));
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
        let config = (self.get_config)();

        if let Some(ticket) = config.server_ticket.as_deref() {
            return parse_ticket_address(ticket);
        }
        if let Some(node_id) = config.server_node_id.as_deref() {
            return parse_node_address(node_id, config.relay_url.as_deref());
        }

        Err(AppError::configuration(
            "No server target is configured. Save an endpoint ticket or a server NodeId in settings.",
        ))
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
}
