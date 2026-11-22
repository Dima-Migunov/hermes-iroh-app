pub mod commands;
pub mod errors;
pub mod events;
pub mod iroh;
pub mod line_decoder;
pub mod metadata;
pub mod prompt;
pub mod protocol;
pub mod sessions;
pub mod state;
pub mod storage;
pub mod targets;

use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLock};

use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl};
use tauri_plugin_dialog::DialogExt;

use crate::errors::AppError;
use crate::events::{EventSink, TauriEventSink};
use crate::iroh::client::{IrohClient, StatusCallback};
use crate::prompt::PromptCoordinator;
use crate::protocol::{ConnectionState, ConnectionStatus};
use crate::sessions::{SessionStore, SessionStoreOptions};
use crate::state::AppState;
use crate::storage::config::ConfigStore;
use crate::storage::data_dir::{config_path, data_dir, history_dir};
use crate::storage::history::HistoryStore;
use crate::storage::keys::load_identity;
use crate::targets::validate_server_target;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::identity_get,
            commands::config_get,
            commands::config_save,
            commands::connection_status,
            commands::connection_connect,
            commands::connection_disconnect,
            commands::sessions_list,
            commands::sessions_create,
            commands::sessions_activate,
            commands::sessions_get,
            commands::sessions_get_active,
            commands::prompt_send,
            commands::prompt_cancel,
            commands::clipboard_write,
            commands::notices_get,
        ])
        .setup(|app| {
            if let Err(error) = setup_app(app) {
                show_fatal(app.handle(), "Startup failed", &error.message);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(handle_run_event);
}

fn setup_app(app: &mut tauri::App) -> Result<(), AppError> {
    let directory = data_dir()?;
    let identity = load_identity(&directory)?;

    let mut config_store = ConfigStore::with_validator(
        config_path(&directory),
        Some(Arc::new(validate_server_target)),
    );
    let config_result = config_store.load();
    let mut notices = Vec::new();
    if let Some(warning) = config_result.warning.clone() {
        notices.push(warning);
    }
    let has_target = config_result.config.server_ticket.is_some()
        || config_result.config.server_node_id.is_some();

    let events: Arc<dyn EventSink> = Arc::new(TauriEventSink::new(app.handle().clone()));

    let sessions = SessionStore::new(
        HistoryStore::new(history_dir(&directory)),
        SessionStoreOptions::default(),
    );
    {
        let history_events = Arc::clone(&events);
        tauri::async_runtime::block_on(
            sessions.set_change_listener(Arc::new(move || history_events.history_changed())),
        );
    }
    tauri::async_runtime::block_on(sessions.initialize()).map_err(|error| {
        AppError::internal(format!(
            "Chat history could not be initialized. ({})",
            error.message
        ))
    })?;
    notices.extend(tauri::async_runtime::block_on(sessions.get_warnings()));

    let config_store = Arc::new(RwLock::new(config_store));
    let get_config = {
        let store = Arc::clone(&config_store);
        Arc::new(move || {
            store
                .read()
                .expect("the configuration lock is not poisoned")
                .get_cached()
        })
    };

    let on_status: StatusCallback = {
        let events = Arc::clone(&events);
        let app_handle = app.handle().clone();
        Arc::new(move |status: ConnectionStatus| {
            events.connection_status(status.clone());
            let label = match status.state {
                ConnectionState::Disconnected => "Disconnected",
                ConnectionState::Connecting => "Connecting…",
                ConnectionState::Connected => "Connected",
                ConnectionState::Error => "Error",
            };
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.set_title(&format!("Hermes Iroh App — {label}"));
            }
        })
    };

    let client = Arc::new(IrohClient::new(
        identity.secret_key.clone(),
        get_config,
        Some(on_status),
        None,
    ));
    let transport: crate::prompt::PromptTransportRef = client.clone();
    let coordinator = Arc::new(PromptCoordinator::new(
        transport,
        sessions.clone(),
        Arc::clone(&events),
        None,
    ));

    let state = AppState {
        node_id: identity.node_id,
        config_store,
        client: Arc::clone(&client),
        sessions,
        coordinator,
        events: Arc::clone(&events),
        notices,
        app: app.handle().clone(),
        shutdown_started: std::sync::atomic::AtomicBool::new(false),
    };
    app.manage(state);

    create_main_window(app)?;
    configure_menu(app)?;

    events.connection_status(ConnectionStatus::disconnected());

    if has_target {
        tauri::async_runtime::spawn(async move {
            client.connect().await;
        });
    }

    Ok(())
}

fn create_main_window(app: &tauri::App) -> Result<(), AppError> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Hermes Iroh App — Disconnected")
        .inner_size(1180.0, 780.0)
        .min_inner_size(800.0, 600.0)
        .visible(false)
        .background_color(tauri::window::Color(0x10, 0x14, 0x18, 0xff))
        .on_navigation(navigation_allowed)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
            }
        })
        .build()
        .map(|_| ())
        .map_err(|error| {
            AppError::internal(format!("The main window could not be created. ({error})"))
        })
}

fn navigation_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            if host == "tauri.localhost" {
                return true;
            }
            cfg!(debug_assertions) && host == "localhost" && url.port() == Some(1420)
        }
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn configure_menu(app: &tauri::App) -> Result<(), AppError> {
    use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "Hermes Iroh App")
        .item(
            &PredefinedMenuItem::about(app, None, None)
                .map_err(|error| AppError::internal(error.to_string()))?,
        )
        .separator()
        .item(
            &PredefinedMenuItem::quit(app, None)
                .map_err(|error| AppError::internal(error.to_string()))?,
        )
        .build()
        .map_err(|error| AppError::internal(error.to_string()))?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .items(&[
            &PredefinedMenuItem::undo(app, None)
                .map_err(|error| AppError::internal(error.to_string()))?,
            &PredefinedMenuItem::redo(app, None)
                .map_err(|error| AppError::internal(error.to_string()))?,
            &PredefinedMenuItem::separator(app)
                .map_err(|error| AppError::internal(error.to_string()))?,
            &PredefinedMenuItem::cut(app, None)
                .map_err(|error| AppError::internal(error.to_string()))?,
            &PredefinedMenuItem::copy(app, None)
                .map_err(|error| AppError::internal(error.to_string()))?,
            &PredefinedMenuItem::paste(app, None)
                .map_err(|error| AppError::internal(error.to_string()))?,
            &PredefinedMenuItem::select_all(app, None)
                .map_err(|error| AppError::internal(error.to_string()))?,
        ])
        .build()
        .map_err(|error| AppError::internal(error.to_string()))?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu])
        .build()
        .map_err(|error| AppError::internal(error.to_string()))?;

    app.set_menu(menu)
        .map_err(|error| AppError::internal(error.to_string()))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn configure_menu(_app: &tauri::App) -> Result<(), AppError> {
    Ok(())
}

fn show_fatal(app: &AppHandle, title: &str, message: &str) -> ! {
    app.dialog().message(message).title(title).blocking_show();
    std::process::exit(1);
}

fn handle_run_event(app_handle: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, .. } = event {
        let (coordinator, client) = {
            let Some(state) = app_handle.try_state::<AppState>() else {
                return;
            };
            if state.shutdown_started.swap(true, Ordering::SeqCst) {
                return;
            }
            (Arc::clone(&state.coordinator), Arc::clone(&state.client))
        };

        api.prevent_exit();
        let handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let _ = coordinator.shutdown().await;
            client.close().await;
            handle.exit(0);
        });
    }
}
