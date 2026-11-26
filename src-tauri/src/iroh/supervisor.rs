use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::iroh::client::{ConfigProvider, IrohClient};
use crate::iroh::retry::RetryPolicy;
use crate::protocol::{ConnectionState, ConnectionStatus};

/// Counts consecutive failed attempts for one supervising loop.
#[derive(Debug, Default)]
struct Backoff {
    failures: usize,
}

impl Backoff {
    fn delay(&self, policy: &RetryPolicy) -> Duration {
        policy.delay(self.failures)
    }

    fn record_failure(&mut self) {
        self.failures = self.failures.saturating_add(1);
    }

    fn record_connected(&mut self) {
        self.failures = 0;
    }
}

#[derive(Default)]
struct Control {
    token: Option<CancellationToken>,
    task: Option<JoinHandle<()>>,
    generation: u64,
}

impl Control {
    /// Stops the running loop and waits until it can no longer change the client state.
    async fn stop(&mut self) {
        if let Some(token) = self.token.take() {
            token.cancel();
        }
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }

    /// Invalidates any attempt that is still waiting for its result, then stops the loop.
    async fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.stop().await;
    }
}

/// Owns the automatic reconnect loop. Connection attempts still go through `IrohClient`, so a
/// supervisor retry, a manual Connect, and a prompt share the client's single attempt mutex.
pub struct ConnectionSupervisor {
    client: Arc<IrohClient>,
    get_config: ConfigProvider,
    policy: RetryPolicy,
    control: Mutex<Control>,
}

impl ConnectionSupervisor {
    pub fn new(client: Arc<IrohClient>, get_config: ConfigProvider, policy: RetryPolicy) -> Self {
        Self {
            client,
            get_config,
            policy,
            control: Mutex::new(Control::default()),
        }
    }

    /// Performs one immediate attempt so the caller still receives its result, then supervises
    /// recovery in the background. The first retry after a failure uses the first backoff step.
    pub async fn connect(&self) -> ConnectionStatus {
        let generation = {
            let mut control = self.control.lock().await;
            control.invalidate().await;
            control.generation
        };
        // Do not hold the control lock across the attempt: a manual Disconnect must still be
        // able to cancel it instead of waiting for the 30-second connect timeout.
        let status = self.client.connect().await;
        let mut control = self.control.lock().await;
        if control.generation == generation {
            self.start_loop(&mut control);
        }
        status
    }

    /// Clears a previous shutdown, attempts immediately, and resumes supervision. Used when the
    /// application returns to the foreground.
    pub async fn restart(&self) -> ConnectionStatus {
        let generation = {
            let mut control = self.control.lock().await;
            control.invalidate().await;
            control.generation
        };
        let status = self.client.restart().await;
        let mut control = self.control.lock().await;
        if control.generation == generation {
            self.start_loop(&mut control);
        }
        status
    }

    /// Stops all automatic attempts and closes the current connection. Only an explicit
    /// disconnect, suspend, or exit calls this.
    pub async fn disconnect(&self) {
        let mut control = self.control.lock().await;
        control.invalidate().await;
        self.client.disconnect().await;
    }

    /// Stops supervision before shutting the endpoint down, so the loop cannot observe the
    /// shutdown as a dropped connection and retry against it.
    pub async fn close(&self) {
        let mut control = self.control.lock().await;
        control.invalidate().await;
        self.client.close().await;
    }

    fn start_loop(&self, control: &mut Control) {
        let token = CancellationToken::new();
        let client = Arc::clone(&self.client);
        let get_config = Arc::clone(&self.get_config);
        let policy = self.policy.clone();
        let loop_token = token.clone();

        let task = tokio::spawn(async move {
            run_loop(client, get_config, policy, loop_token).await;
        });

        control.token = Some(token);
        control.task = Some(task);
    }
}

fn has_target(get_config: &ConfigProvider) -> bool {
    let config = get_config();
    config.server_ticket.is_some() || config.server_node_id.is_some()
}

/// Waits for a status change. Returns `false` when the loop was cancelled instead.
async fn wait_for_change(
    statuses: &mut watch::Receiver<ConnectionStatus>,
    token: &CancellationToken,
) -> bool {
    tokio::select! {
        _ = token.cancelled() => false,
        result = statuses.changed() => result.is_ok(),
    }
}

async fn run_loop(
    client: Arc<IrohClient>,
    get_config: ConfigProvider,
    policy: RetryPolicy,
    token: CancellationToken,
) {
    let mut statuses = client.subscribe_status();
    let mut backoff = Backoff::default();

    loop {
        if token.is_cancelled() {
            return;
        }

        let status = statuses.borrow_and_update().clone();
        match status.state {
            ConnectionState::Connected => {
                backoff.record_connected();
                if !wait_for_change(&mut statuses, &token).await {
                    return;
                }
            }
            ConnectionState::Connecting => {
                // A manual Connect or a prompt is already establishing the connection.
                if !wait_for_change(&mut statuses, &token).await {
                    return;
                }
            }
            ConnectionState::Disconnected | ConnectionState::Error => {
                if !has_target(&get_config) {
                    client.reset_to_disconnected();
                    // Consume our own update so `changed` does not wake immediately.
                    statuses.borrow_and_update();
                    if !wait_for_change(&mut statuses, &token).await {
                        return;
                    }
                    continue;
                }

                let delay = backoff.delay(&policy);
                if status.state == ConnectionState::Error {
                    client.report_automatic_retry(delay);
                    // The retry sentence is our own update; mark it seen before sleeping.
                    statuses.borrow_and_update();
                }

                let changed = tokio::select! {
                    _ = token.cancelled() => return,
                    result = statuses.changed() => result.is_ok(),
                    _ = tokio::time::sleep(delay) => false,
                };
                if changed {
                    continue;
                }

                if token.is_cancelled() {
                    return;
                }

                if client
                    .ensure_connection_with(Some(token.clone()))
                    .await
                    .is_ok()
                {
                    backoff.record_connected();
                } else {
                    backoff.record_failure();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iroh::client::{PromptStreamRequest, ALPN_PROTOCOL};
    use crate::protocol::{ClientConfig, PromptEvent};
    use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
    use iroh::SecretKey;
    use iroh_tickets::endpoint::EndpointTicket;
    use std::future::Future;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;
    use std::time::Instant;

    fn fast_policy() -> RetryPolicy {
        RetryPolicy::new(
            vec![Duration::from_millis(20), Duration::from_millis(40)],
            0.0,
            Duration::from_millis(40),
        )
    }

    fn build_client(config: ClientConfig) -> (Arc<IrohClient>, ConfigProvider) {
        let provider: ConfigProvider = Arc::new(move || config.clone());
        let client = Arc::new(IrohClient::new(
            SecretKey::generate(),
            Arc::clone(&provider),
            None,
            Some(Duration::from_secs(10)),
        ));
        (client, provider)
    }

    fn build_supervisor(
        config: ClientConfig,
        policy: RetryPolicy,
    ) -> (Arc<IrohClient>, Arc<ConnectionSupervisor>) {
        let (client, provider) = build_client(config);
        let supervisor = Arc::new(ConnectionSupervisor::new(
            Arc::clone(&client),
            provider,
            policy,
        ));
        (client, supervisor)
    }

    async fn wait_until(mut condition: impl FnMut() -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if condition() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn read_prompt_line(recv: &mut RecvStream) -> Option<String> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match recv.read(&mut chunk).await {
                Ok(Some(size)) => {
                    buffer.extend_from_slice(&chunk[..size]);
                    if buffer.contains(&b'\n') {
                        return String::from_utf8(buffer).ok();
                    }
                }
                Ok(None) | Err(_) => return None,
            }
        }
    }

    async fn write_line(send: &mut SendStream, value: serde_json::Value) {
        let line = format!("{value}\n");
        let _ = send.write_all(line.as_bytes()).await;
    }

    struct TestServer {
        endpoint: iroh::Endpoint,
        ticket: String,
        accepted: Arc<AtomicUsize>,
    }

    impl TestServer {
        async fn start<F, Fut>(handler: F) -> Self
        where
            F: Fn(Connection, usize) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = ()> + Send + 'static,
        {
            let endpoint = iroh::Endpoint::builder(presets::Minimal)
                .secret_key(SecretKey::generate())
                .alpns(vec![ALPN_PROTOCOL.to_vec()])
                .bind_addr("127.0.0.1:0")
                .expect("bind address")
                .bind()
                .await
                .expect("bind endpoint");
            let ticket = EndpointTicket::new(endpoint.addr()).to_string();
            let accepted = Arc::new(AtomicUsize::new(0));
            let accepting = endpoint.clone();
            let counter = Arc::clone(&accepted);
            let handler = Arc::new(handler);

            tokio::spawn(async move {
                while let Some(incoming) = accepting.accept().await {
                    let Ok(connection) = incoming.await else {
                        continue;
                    };
                    let index = counter.fetch_add(1, Ordering::SeqCst) + 1;
                    let handler = Arc::clone(&handler);
                    tokio::spawn(async move {
                        handler(connection, index).await;
                    });
                }
            });

            Self {
                endpoint,
                ticket,
                accepted,
            }
        }

        fn config(&self) -> ClientConfig {
            ClientConfig {
                server_ticket: Some(self.ticket.clone()),
                server_node_id: None,
                relay_url: None,
            }
        }

        fn accepted(&self) -> usize {
            self.accepted.load(Ordering::SeqCst)
        }

        async fn close(self) {
            self.endpoint.close().await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reconnects_after_the_server_closes_an_accepted_connection() {
        let server = TestServer::start(|connection, index| async move {
            if index == 1 {
                tokio::time::sleep(Duration::from_millis(80)).await;
                connection.close(0u32.into(), b"bye");
            } else {
                let _ = connection.closed().await;
            }
        })
        .await;

        let (client, supervisor) = build_supervisor(server.config(), fast_policy());
        let status = supervisor.connect().await;
        assert_eq!(status.state, ConnectionState::Connected);

        assert!(
            wait_until(|| server.accepted() >= 2, Duration::from_secs(10)).await,
            "the supervisor did not reconnect without a prompt"
        );
        assert!(
            wait_until(
                || client.get_status().state == ConnectionState::Connected,
                Duration::from_secs(10)
            )
            .await
        );

        supervisor.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnect_interrupts_a_pending_supervisor_connect() {
        let config = ClientConfig {
            server_ticket: Some(
                EndpointTicket::new(iroh::EndpointAddr::new(SecretKey::generate().public()))
                    .to_string(),
            ),
            server_node_id: None,
            relay_url: None,
        };
        let (client, supervisor) = build_supervisor(config, fast_policy());

        let connecting = tokio::spawn({
            let supervisor = Arc::clone(&supervisor);
            async move { supervisor.connect().await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;

        tokio::time::timeout(Duration::from_secs(5), supervisor.disconnect())
            .await
            .expect("disconnect must not wait for the connect timeout");
        let status = tokio::time::timeout(Duration::from_secs(10), connecting)
            .await
            .expect("the pending connect must end")
            .expect("connect task");

        assert_ne!(status.state, ConnectionState::Connected);
        assert_eq!(client.get_status().state, ConnectionState::Disconnected);

        supervisor.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_explicit_disconnect_stops_every_later_attempt() {
        let server = TestServer::start(|connection, _index| async move {
            let _ = connection.closed().await;
        })
        .await;

        let (client, supervisor) = build_supervisor(server.config(), fast_policy());
        assert_eq!(supervisor.connect().await.state, ConnectionState::Connected);
        assert!(wait_until(|| server.accepted() == 1, Duration::from_secs(5)).await);

        supervisor.disconnect().await;
        assert_eq!(client.get_status(), ConnectionStatus::disconnected());

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            server.accepted(),
            1,
            "no automatic attempt may follow a manual disconnect"
        );
        assert_eq!(client.get_status().state, ConnectionState::Disconnected);

        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_missing_target_produces_no_automatic_attempts_or_retry_errors() {
        let (client, supervisor) = build_supervisor(ClientConfig::default(), fast_policy());

        let status = supervisor.connect().await;
        assert_eq!(status.state, ConnectionState::Error);

        assert!(
            wait_until(
                || client.get_status() == ConnectionStatus::disconnected(),
                Duration::from_secs(2)
            )
            .await,
            "the supervisor must settle on disconnected without a target"
        );

        let attempts_after_manual_connect = client.attempts_started();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(client.attempts_started(), attempts_after_manual_connect);
        assert_eq!(client.get_status(), ConnectionStatus::disconnected());
        assert!(client.get_status().message.is_none());

        supervisor.close().await;
    }

    #[test]
    fn a_successful_connection_resets_the_backoff() {
        let policy = RetryPolicy::new(
            vec![
                Duration::from_millis(10),
                Duration::from_millis(20),
                Duration::from_millis(40),
            ],
            0.0,
            Duration::from_millis(40),
        );
        let mut backoff = Backoff::default();
        backoff.record_failure();
        backoff.record_failure();
        assert_eq!(backoff.delay(&policy), Duration::from_millis(40));

        backoff.record_connected();
        assert_eq!(backoff.delay(&policy), Duration::from_millis(10));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_pauses_the_loop_and_restart_resumes_it() {
        let server = TestServer::start(|connection, _index| async move {
            let _ = connection.closed().await;
        })
        .await;

        let (client, supervisor) = build_supervisor(server.config(), fast_policy());
        assert_eq!(supervisor.connect().await.state, ConnectionState::Connected);
        assert!(wait_until(|| server.accepted() == 1, Duration::from_secs(5)).await);

        supervisor.close().await;
        assert_eq!(client.get_status().state, ConnectionState::Disconnected);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(server.accepted(), 1, "a closed supervisor must not retry");

        let status = supervisor.restart().await;
        assert_eq!(status.state, ConnectionState::Connected);
        assert!(wait_until(|| server.accepted() >= 2, Duration::from_secs(5)).await);
        assert_eq!(client.get_status().state, ConnectionState::Connected);

        supervisor.close().await;
        server.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_prompt_and_a_retry_never_create_overlapping_attempts() {
        let server = TestServer::start(|connection, index| async move {
            if index == 1 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                connection.close(0u32.into(), b"bye");
                return;
            }

            let Ok((mut send, mut recv)) = connection.accept_bi().await else {
                return;
            };
            let Some(_line) = read_prompt_line(&mut recv).await else {
                return;
            };
            write_line(
                &mut send,
                serde_json::json!({ "type": "start", "session_id": "session-1" }),
            )
            .await;
            write_line(&mut send, serde_json::json!({ "type": "done" })).await;
            let _ = send.finish();
            let _ = connection.closed().await;
        })
        .await;

        let policy = RetryPolicy::new(
            vec![Duration::from_millis(100), Duration::from_millis(100)],
            0.0,
            Duration::from_millis(100),
        );
        let (client, supervisor) = build_supervisor(server.config(), policy);
        assert_eq!(supervisor.connect().await.state, ConnectionState::Connected);
        assert!(
            wait_until(
                || client.get_status().state == ConnectionState::Disconnected,
                Duration::from_secs(5)
            )
            .await
        );

        let events = Arc::new(StdMutex::new(Vec::new()));
        let emitted = Arc::clone(&events);
        let prompt = tokio::spawn({
            let client = Arc::clone(&client);
            async move {
                client
                    .stream_prompt(PromptStreamRequest {
                        request_id: "request-1".to_owned(),
                        session_id: "session-1".to_owned(),
                        text: "hello".to_owned(),
                        emit: Arc::new(move |event: PromptEvent| {
                            emitted.lock().expect("event lock").push(event);
                        }),
                        cancel: CancellationToken::new(),
                    })
                    .await;
            }
        });

        tokio::time::timeout(Duration::from_secs(10), prompt)
            .await
            .expect("the prompt must not deadlock behind a retry")
            .expect("prompt task");

        let events = events.lock().expect("event lock").clone();
        assert_eq!(events.len(), 2, "expected start and done: {events:?}");
        assert!(matches!(events[0], PromptEvent::Start { .. }));
        assert!(matches!(events[1], PromptEvent::Done { .. }));
        assert_eq!(client.max_attempts_in_flight(), 1);

        supervisor.close().await;
        server.close().await;
    }
}
