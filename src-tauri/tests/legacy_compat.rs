use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use hermes_iroh_app_lib::protocol::{MessageRole, MessageStatus};
use hermes_iroh_app_lib::sessions::{SessionStore, SessionStoreOptions};
use hermes_iroh_app_lib::storage::config::{ConfigStore, TargetValidator};
use hermes_iroh_app_lib::storage::history::HistoryStore;
use hermes_iroh_app_lib::storage::keys::KeyStore;
use hermes_iroh_app_lib::targets::validate_server_target;
use serde_json::{json, Value};

const LEGACY_CLIENT_NODE_ID: &str =
    "92e957601dd9a45fdbc2d532de0edd61c5edce14a2a17a31a411acc3759d814e";
const LEGACY_TICKET: &str = "endpointaafdreilx32ktinrw3o5vygzxumymwzbbfte4xvnjcsr477arwofsaa";

fn fixture_directory() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/legacy-data")
}

fn copy_fixture(source: &Path, target: &Path) {
    std::fs::create_dir_all(target.join("history")).expect("create history directory");
    for relative in [
        "client.key",
        "config.json",
        "history/index.json",
        "history/session-alpha.json",
        "history/session-beta.json",
    ] {
        std::fs::copy(source.join(relative), target.join(relative))
            .unwrap_or_else(|error| panic!("copy {relative}: {error}"));
    }
}

fn session_store(directory: &Path) -> SessionStore {
    SessionStore::new(
        HistoryStore::new(directory.join("history")),
        SessionStoreOptions {
            debounce: Duration::from_millis(5),
            ..Default::default()
        },
    )
}

#[tokio::test]
async fn reads_and_writes_data_produced_by_an_earlier_desktop_build() {
    let fixture = fixture_directory();
    let temporary = tempfile::tempdir().expect("temporary directory");
    let directory = temporary.path();
    copy_fixture(&fixture, directory);

    let identity = KeyStore::new(directory.join("client.key"))
        .load()
        .expect("client key");
    assert_eq!(identity.node_id, LEGACY_CLIENT_NODE_ID);

    let validator: Arc<TargetValidator> = Arc::new(validate_server_target);
    let mut config_store =
        ConfigStore::with_validator(directory.join("config.json"), Some(validator));
    let loaded = config_store.load();
    assert!(loaded.warning.is_none());
    assert_eq!(loaded.config.server_ticket.as_deref(), Some(LEGACY_TICKET));
    assert_eq!(loaded.config.server_node_id, None);
    assert_eq!(
        loaded.config.relay_url.as_deref(),
        Some("https://relay.example")
    );

    config_store
        .save(loaded.config.clone())
        .expect("save the loaded configuration");
    let raw: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("config.json")).expect("read config"),
    )
    .expect("parse config");
    assert_eq!(raw["version"], 1);
    assert_eq!(raw["futureField"], "keep-me");
    assert_eq!(raw["serverTicket"], LEGACY_TICKET);

    let sessions = session_store(directory);
    sessions.initialize().await.expect("initialize sessions");

    let summaries = sessions.list().await;
    assert_eq!(summaries.len(), 2);
    assert_eq!(
        sessions.get_active_session_id().await.as_deref(),
        Some("session-alpha")
    );
    assert_eq!(
        summaries
            .iter()
            .find(|summary| summary.id == "session-alpha")
            .expect("alpha summary")
            .title,
        "Legacy transcript"
    );

    let alpha = sessions
        .get_snapshot("session-alpha")
        .await
        .expect("alpha snapshot");
    assert_eq!(alpha.messages.len(), 2);
    assert_eq!(alpha.messages[0].role, MessageRole::User);
    assert_eq!(alpha.messages[0].content, "hello from an earlier build");
    assert_eq!(alpha.messages[1].role, MessageRole::Assistant);
    assert_eq!(alpha.messages[1].status, MessageStatus::Complete);
    assert_eq!(alpha.messages[1].content, "Hello from the old build");
    assert!(
        alpha.messages[1].tool_calls.is_none(),
        "a transcript written before tool calls must load without them"
    );

    let metadata = alpha.messages[1].metadata.as_ref().expect("metadata");
    assert_eq!(metadata.schema, 1);
    assert_eq!(metadata.generated_at, "2026-01-02T03:05:00.000Z");
    assert_eq!(metadata.latency_ms, 42);
    assert_eq!(metadata.model.as_deref(), Some("gpt-5.1"));
    assert_eq!(metadata.provider.as_deref(), Some("openai"));
    assert_eq!(
        metadata
            .usage
            .as_ref()
            .and_then(|usage| usage.total_tokens.as_ref())
            .map(|value| value.to_string()),
        Some("13".to_owned())
    );
    assert_eq!(
        metadata
            .session_usage
            .as_ref()
            .and_then(|usage| usage.context_percent.as_ref())
            .map(|value| value.to_string()),
        Some("1.5".to_owned())
    );
    assert_eq!(
        metadata
            .balance
            .as_ref()
            .and_then(|balance| balance.remaining_usd.as_ref())
            .map(|value| value.to_string()),
        Some("12.5".to_owned())
    );
    assert_eq!(
        metadata
            .balance
            .as_ref()
            .and_then(|balance| balance.paid_access),
        Some(true)
    );

    let beta = sessions
        .get_snapshot("session-beta")
        .await
        .expect("beta snapshot");
    assert_eq!(beta.messages[0].status, MessageStatus::Failed);
    assert_eq!(
        beta.messages[0]
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("connection-closed")
    );
    assert_eq!(beta.messages[1].status, MessageStatus::Interrupted);
    assert_eq!(beta.messages[1].content, "partial answer");

    let raw_session: Value = serde_json::from_str(
        &std::fs::read_to_string(directory.join("history/session-beta.json"))
            .expect("read beta session"),
    )
    .expect("parse beta session");
    assert_eq!(raw_session["messages"][1]["status"], "interrupted");

    let history = HistoryStore::new(directory.join("history"));
    std::fs::write(
        history.session_path("session-tools"),
        json!({
            "version": 1,
            "sessionId": "session-tools",
            "messages": [
                {
                    "id": "user-1",
                    "role": "user",
                    "content": "use a tool",
                    "createdAt": "2026-01-03T00:00:00.000Z",
                    "status": "complete"
                },
                {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": "line one\nline two",
                    "createdAt": "2026-01-03T00:00:01.000Z",
                    "status": "complete",
                    "toolCalls": [
                        {
                            "id": "call-1",
                            "name": "search",
                            "arguments": { "query": "docs" },
                            "lineIndex": 0
                        },
                        {
                            "name": "read",
                            "arguments": { "path": "README.md" },
                            "truncated": true,
                            "lineIndex": 1
                        }
                    ]
                }
            ]
        })
        .to_string(),
    )
    .expect("write a session with tool calls");
    let with_tools = history.load_session("session-tools");
    assert!(with_tools.warning.is_none());
    assert_eq!(with_tools.messages.len(), 2);
    let calls = with_tools.messages[1]
        .tool_calls
        .as_ref()
        .expect("tool calls");
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].id.as_deref(), Some("call-1"));
    assert_eq!(calls[0].name, "search");
    assert_eq!(calls[0].arguments["query"], "docs");
    assert_eq!(calls[0].line_index, 0);
    assert!(!calls[0].truncated);
    assert_eq!(calls[1].id, None);
    assert_eq!(calls[1].name, "read");
    assert!(calls[1].truncated);
    assert_eq!(calls[1].line_index, 1);
    assert_eq!(with_tools.messages[1].content, "line one\nline two");

    let reopened = session_store(directory);
    reopened.initialize().await.expect("reopen sessions");
    let restored = reopened
        .get_active_snapshot()
        .await
        .expect("restored snapshot");
    assert_eq!(restored.session.id, "session-alpha");
    assert_eq!(restored.messages[1].content, "Hello from the old build");
    assert_eq!(restored.messages[1].metadata, alpha.messages[1].metadata);
}
