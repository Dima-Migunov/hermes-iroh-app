use std::str::FromStr;

use iroh::{EndpointAddr, PublicKey, RelayUrl};
use iroh_tickets::endpoint::EndpointTicket;

use crate::errors::AppError;
use crate::protocol::ClientConfig;

pub fn validate_server_target(config: &ClientConfig) -> Result<(), AppError> {
    if let Some(ticket) = config.server_ticket.as_deref() {
        parse_ticket_address(ticket)?;
        return Ok(());
    }
    if let Some(node_id) = config.server_node_id.as_deref() {
        parse_node_address(node_id, config.relay_url.as_deref())?;
        return Ok(());
    }
    Ok(())
}

pub fn parse_ticket_address(ticket: &str) -> Result<EndpointAddr, AppError> {
    let parsed = EndpointTicket::from_str(ticket).map_err(|error| {
        AppError::configuration(format!(
            "The server target is invalid. Check the endpoint ticket or NodeId. ({error})"
        ))
    })?;
    Ok(parsed.endpoint_addr().clone())
}

pub fn parse_node_address(
    node_id: &str,
    relay_url: Option<&str>,
) -> Result<EndpointAddr, AppError> {
    let public_key = PublicKey::from_str(node_id).map_err(|error| {
        AppError::configuration(format!(
            "The server target is invalid. Check the endpoint ticket or NodeId. ({error})"
        ))
    })?;

    let mut address = EndpointAddr::new(public_key);
    if let Some(relay) = relay_url {
        let relay_url = RelayUrl::from_str(relay).map_err(|error| {
            AppError::configuration(format!(
                "The relay URL is invalid. Check the relay URL in settings. ({error})"
            ))
        })?;
        address = address.with_relay_url(relay_url);
    }

    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    #[test]
    fn parses_a_ticket_round_trip() {
        let secret_key = SecretKey::generate();
        let address = EndpointAddr::new(secret_key.public())
            .with_relay_url(RelayUrl::from_str("https://relay.example").expect("relay"));
        let ticket = EndpointTicket::new(address.clone()).to_string();

        let parsed = parse_ticket_address(&ticket).expect("ticket");

        assert_eq!(parsed, address);
    }

    #[test]
    fn rejects_an_invalid_ticket() {
        let error = parse_ticket_address("not-a-ticket").expect_err("invalid");
        assert_eq!(error.code, crate::errors::ErrorCode::Configuration);
        assert!(error.message.contains("server target is invalid"));
    }

    #[test]
    fn parses_a_node_id_with_a_relay_hint() {
        let secret_key = SecretKey::generate();
        let node_id = secret_key.public().to_string();

        let address = parse_node_address(&node_id, Some("https://relay.example")).expect("node id");

        assert_eq!(address.id, secret_key.public());
        assert_eq!(address.relay_urls().count(), 1);
    }

    #[test]
    fn parses_a_bare_node_id() {
        let secret_key = SecretKey::generate();
        let address = parse_node_address(&secret_key.public().to_string(), None).expect("node id");

        assert_eq!(address.id, secret_key.public());
        assert!(address.is_empty());
    }

    #[test]
    fn rejects_an_invalid_node_id() {
        let error = parse_node_address("not-a-node-id", None).expect_err("invalid");
        assert_eq!(error.code, crate::errors::ErrorCode::Configuration);
    }

    #[test]
    fn validates_a_configured_ticket() {
        let secret_key = SecretKey::generate();
        let ticket = EndpointTicket::new(EndpointAddr::new(secret_key.public())).to_string();
        let config = ClientConfig {
            server_ticket: Some(ticket),
            server_node_id: None,
            relay_url: None,
        };

        validate_server_target(&config).expect("valid config");
    }
}
