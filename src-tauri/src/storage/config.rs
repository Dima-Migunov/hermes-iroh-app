use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::errors::AppError;
use crate::protocol::ClientConfig;
use crate::storage::atomic_file::write_file_atomic;

pub type TargetValidator = dyn Fn(&ClientConfig) -> Result<(), AppError> + Send + Sync;

#[derive(Debug, Clone, PartialEq)]
pub struct ConfigLoadResult {
    pub config: ClientConfig,
    pub warning: Option<String>,
}

pub struct ConfigStore {
    file_path: PathBuf,
    validate_target: Option<Arc<TargetValidator>>,
    cached: ClientConfig,
    extra_fields: Map<String, Value>,
}

impl ConfigStore {
    pub fn new(file_path: impl Into<PathBuf>) -> Self {
        Self::with_validator(file_path, None)
    }

    pub fn with_validator(
        file_path: impl Into<PathBuf>,
        validate_target: Option<Arc<TargetValidator>>,
    ) -> Self {
        Self {
            file_path: file_path.into(),
            validate_target,
            cached: default_config(),
            extra_fields: Map::new(),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    pub fn get_cached(&self) -> ClientConfig {
        self.cached.clone()
    }

    pub fn load(&mut self) -> ConfigLoadResult {
        let raw = match fs::read_to_string(&self.file_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.cached = default_config();
                return ConfigLoadResult {
                    config: self.cached.clone(),
                    warning: None,
                };
            }
            Err(error) => {
                return ConfigLoadResult {
                    config: default_config(),
                    warning: Some(format!(
                        "Settings could not be read from {}. Using defaults. ({error})",
                        self.file_path.display()
                    )),
                };
            }
        };

        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(parsed) => parsed,
            Err(error) => {
                return ConfigLoadResult {
                    config: default_config(),
                    warning: Some(format!(
                        "Settings file {} is not valid JSON. Using defaults until settings are saved again. ({error})",
                        self.file_path.display()
                    )),
                };
            }
        };

        match self.parse_document(&parsed) {
            Ok((config, extra)) => {
                if let Err(error) = self.validate_config(&config) {
                    return ConfigLoadResult {
                        config: default_config(),
                        warning: Some(format!(
                            "Settings file {} is invalid. Using defaults until settings are saved again. ({error})",
                            self.file_path.display()
                        )),
                    };
                }
                self.cached = config.clone();
                self.extra_fields = extra;
                ConfigLoadResult {
                    config,
                    warning: None,
                }
            }
            Err(error) => ConfigLoadResult {
                config: default_config(),
                warning: Some(format!(
                    "Settings file {} is invalid. Using defaults until settings are saved again. ({error})",
                    self.file_path.display()
                )),
            },
        }
    }

    pub fn save(&mut self, input: ClientConfig) -> Result<ClientConfig, AppError> {
        let config = normalize_config(&input);
        self.validate_config(&config)?;

        let mut document = self.extra_fields.clone();
        document.insert("version".to_owned(), Value::from(1));
        document.insert(
            "serverTicket".to_owned(),
            config
                .server_ticket
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        document.insert(
            "serverNodeId".to_owned(),
            config
                .server_node_id
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        document.insert(
            "relayUrl".to_owned(),
            config
                .relay_url
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );

        let serialized = serde_json::to_string_pretty(&Value::Object(document))
            .map_err(|error| AppError::configuration(error.to_string()))?;

        write_file_atomic(&self.file_path, format!("{serialized}\n").as_bytes(), None).map_err(
            |error| {
                AppError::configuration(format!(
                    "Settings could not be saved to {}. ({error})",
                    self.file_path.display()
                ))
            },
        )?;

        self.cached = config.clone();
        Ok(config)
    }

    fn parse_document(
        &self,
        value: &Value,
    ) -> Result<(ClientConfig, Map<String, Value>), AppError> {
        let document = value
            .as_object()
            .ok_or_else(|| AppError::configuration("The settings document must be an object."))?;

        let config = normalize_config(&ClientConfig {
            server_ticket: read_nullable_string(document.get("serverTicket"), "serverTicket")?,
            server_node_id: read_nullable_string(document.get("serverNodeId"), "serverNodeId")?,
            relay_url: read_nullable_string(document.get("relayUrl"), "relayUrl")?,
        });

        let mut extra = document.clone();
        extra.remove("version");
        extra.remove("serverTicket");
        extra.remove("serverNodeId");
        extra.remove("relayUrl");

        Ok((config, extra))
    }

    fn validate_config(&self, config: &ClientConfig) -> Result<(), AppError> {
        let has_ticket = config.server_ticket.is_some();
        let has_node_id = config.server_node_id.is_some();

        if !has_ticket && !has_node_id {
            return Err(AppError::configuration(
                "A server target is required: paste an endpoint ticket or a server NodeId.",
            ));
        }

        if let Some(relay) = config.relay_url.as_deref() {
            let url = url::Url::parse(relay)
                .map_err(|_| AppError::configuration("The relay URL is not a valid URL."))?;
            if url.scheme() != "https" && url.scheme() != "http" {
                return Err(AppError::configuration(
                    "The relay URL must use http or https.",
                ));
            }
        }

        if let Some(validator) = &self.validate_target {
            validator(config)?;
        }

        Ok(())
    }
}

pub fn default_config() -> ClientConfig {
    ClientConfig {
        server_ticket: None,
        server_node_id: None,
        relay_url: None,
    }
}

pub fn normalize_config(input: &ClientConfig) -> ClientConfig {
    let ticket = input
        .server_ticket
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let node_id = input
        .server_node_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let relay = input
        .relay_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    // An endpoint ticket already carries the server's addresses, so it wins over a bare NodeId.
    let server_node_id = if ticket.is_none() { node_id } else { None };

    ClientConfig {
        server_ticket: ticket,
        server_node_id,
        relay_url: relay,
    }
}

fn read_nullable_string(value: Option<&Value>, field: &str) -> Result<Option<String>, AppError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(AppError::configuration(format!(
            "The settings field \"{field}\" must be a string or null."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorCode;
    use std::fs;
    use std::path::PathBuf;

    fn temporary_store(validator: Option<Arc<TargetValidator>>) -> (PathBuf, ConfigStore) {
        let directory = tempfile::tempdir().expect("temp dir").keep();
        let file_path = directory.join("config.json");
        let store = ConfigStore::with_validator(&file_path, validator);
        (file_path, store)
    }

    fn ticket_config() -> ClientConfig {
        ClientConfig {
            server_ticket: Some("valid-ticket-value-1234567890".to_owned()),
            server_node_id: None,
            relay_url: None,
        }
    }

    #[test]
    fn saves_and_loads_a_valid_configuration() {
        let (file_path, mut store) = temporary_store(None);
        let saved = store
            .save(ClientConfig {
                server_ticket: Some("  ticket-value  ".to_owned()),
                server_node_id: None,
                relay_url: Some("https://relay.example".to_owned()),
            })
            .expect("save");

        assert_eq!(
            saved,
            ClientConfig {
                server_ticket: Some("ticket-value".to_owned()),
                server_node_id: None,
                relay_url: Some("https://relay.example".to_owned()),
            }
        );

        let mut reloaded = ConfigStore::new(&file_path);
        let loaded = reloaded.load();
        assert_eq!(loaded.config, saved);
        assert!(loaded.warning.is_none());
    }

    #[test]
    fn keeps_the_ticket_and_drops_the_node_id_when_both_are_set() {
        let (file_path, mut store) = temporary_store(None);
        let saved = store
            .save(ClientConfig {
                server_ticket: Some("ticket".to_owned()),
                server_node_id: Some("node".to_owned()),
                relay_url: None,
            })
            .expect("save");

        assert_eq!(saved.server_ticket.as_deref(), Some("ticket"));
        assert_eq!(saved.server_node_id, None);

        let raw: Value =
            serde_json::from_str(&fs::read_to_string(&file_path).expect("read")).expect("json");
        assert_eq!(raw["serverTicket"], "ticket");
        assert_eq!(raw["serverNodeId"], Value::Null);
    }

    #[test]
    fn rejects_a_configuration_without_a_target() {
        let (_file_path, mut store) = temporary_store(None);
        let error = store.save(default_config()).expect_err("missing target");
        assert_eq!(error.code, ErrorCode::Configuration);
        assert!(error.message.contains("server target is required"));
    }

    #[test]
    fn rejects_an_invalid_relay_url() {
        let (_file_path, mut store) = temporary_store(None);
        let error = store
            .save(ClientConfig {
                server_ticket: Some("ticket".to_owned()),
                server_node_id: None,
                relay_url: Some("not a url".to_owned()),
            })
            .expect_err("invalid relay");
        assert_eq!(error.code, ErrorCode::Configuration);
    }

    #[test]
    fn recovers_from_malformed_json_with_a_warning() {
        let (file_path, mut store) = temporary_store(None);
        fs::write(&file_path, "{broken json").expect("seed");

        let loaded = store.load();
        assert_eq!(loaded.config, default_config());
        assert!(loaded
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("not valid JSON")));
    }

    #[test]
    fn treats_a_structurally_invalid_document_as_unconfigured() {
        let (file_path, mut store) = temporary_store(None);
        fs::write(
            &file_path,
            r#"{"version":1,"serverTicket":42,"serverNodeId":null,"relayUrl":null}"#,
        )
        .expect("seed");

        let loaded = store.load();
        assert_eq!(loaded.config.server_ticket, None);
        assert!(loaded.warning.is_some());
    }

    #[test]
    fn preserves_unknown_fields_across_load_and_save() {
        let (file_path, mut store) = temporary_store(None);
        fs::write(
            &file_path,
            r#"{"version":1,"serverTicket":"old-ticket","serverNodeId":null,"relayUrl":null,"futureField":"kept"}"#,
        )
        .expect("seed");

        store.load();
        store.save(ticket_config()).expect("save");

        let raw: Value =
            serde_json::from_str(&fs::read_to_string(&file_path).expect("read")).expect("json");
        assert_eq!(raw["futureField"], "kept");
        assert_eq!(raw["version"], 1);
    }

    #[test]
    fn preserves_the_last_valid_settings_when_a_save_is_rejected() {
        let validator: Arc<TargetValidator> = Arc::new(|config| {
            if config.server_ticket.as_deref() == Some("bad-ticket") {
                Err(AppError::configuration("The server target is invalid."))
            } else {
                Ok(())
            }
        });
        let (file_path, mut store) = temporary_store(Some(validator));
        store.save(ticket_config()).expect("valid save");

        store
            .save(ClientConfig {
                server_ticket: Some("bad-ticket".to_owned()),
                server_node_id: None,
                relay_url: None,
            })
            .expect_err("invalid target");

        let mut reloaded = ConfigStore::new(&file_path);
        assert_eq!(
            reloaded.load().config.server_ticket.as_deref(),
            ticket_config().server_ticket.as_deref()
        );
    }
}
