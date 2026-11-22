use std::str::FromStr;

use iroh::endpoint::{presets, Builder, RelayMode};
use iroh::SecretKey;
use iroh::{RelayMap, RelayUrl};

use crate::errors::AppError;

pub fn relay_mode_for(relay_url: Option<&str>) -> Result<RelayMode, AppError> {
    match relay_url {
        None => Ok(RelayMode::Default),
        Some(url) => {
            let parsed = RelayUrl::from_str(url).map_err(|error| {
                AppError::configuration(format!("The relay URL is invalid. ({error})"))
            })?;
            Ok(RelayMode::Custom(RelayMap::from(parsed)))
        }
    }
}

pub fn endpoint_builder(secret_key: &SecretKey) -> Builder {
    Endpoint::builder(presets::N0).secret_key(secret_key.clone())
}

use iroh::Endpoint;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_default_relay_mode_when_unset() {
        assert!(matches!(relay_mode_for(None), Ok(RelayMode::Default)));
    }

    #[test]
    fn builds_a_custom_relay_map() {
        let mode = relay_mode_for(Some("https://relay.example")).expect("relay mode");
        match mode {
            RelayMode::Custom(map) => {
                assert_eq!(map.len(), 1);
                assert!(map.contains(&RelayUrl::from_str("https://relay.example").expect("url")));
            }
            other => panic!("unexpected relay mode: {other:?}"),
        }
    }

    #[test]
    fn rejects_an_invalid_relay_url() {
        let error = relay_mode_for(Some("not a url")).expect_err("invalid relay");
        assert_eq!(error.code, crate::errors::ErrorCode::Configuration);
    }
}
