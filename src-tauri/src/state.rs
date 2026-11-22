use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock};

use tauri::AppHandle;

use crate::events::EventSink;
use crate::iroh::client::IrohClient;
use crate::prompt::PromptCoordinator;
use crate::protocol::ClientConfig;
use crate::sessions::SessionStore;
use crate::storage::config::ConfigStore;

pub struct AppState {
    pub node_id: String,
    pub config_store: Arc<RwLock<ConfigStore>>,
    pub client: Arc<IrohClient>,
    pub sessions: SessionStore,
    pub coordinator: Arc<PromptCoordinator>,
    pub events: Arc<dyn EventSink>,
    pub notices: Vec<String>,
    pub app: AppHandle,
    pub shutdown_started: AtomicBool,
}

impl AppState {
    pub fn config(&self) -> ClientConfig {
        self.config_store
            .read()
            .expect("the configuration lock is not poisoned")
            .get_cached()
    }

    pub fn has_server_target(&self) -> bool {
        let config = self.config();
        config.server_ticket.is_some() || config.server_node_id.is_some()
    }
}
