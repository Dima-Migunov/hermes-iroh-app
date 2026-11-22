use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Busy,
    Timeout,
    Network,
    ConnectionClosed,
    ConnectionRefused,
    Protocol,
    Server,
    Identity,
    Configuration,
    NotFound,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::ConnectionClosed => "connection-closed",
            Self::ConnectionRefused => "connection-refused",
            Self::Protocol => "protocol",
            Self::Server => "server",
            Self::Identity => "identity",
            Self::Configuration => "configuration",
            Self::NotFound => "not-found",
            Self::Internal => "internal",
        }
    }
}

pub const ALLOWLIST_HINT: &str = "Verify that this client NodeId is allowed on the server: run /iroh_allow <client_node_id> on the Hermes host.";

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn configuration(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Configuration, message)
    }

    pub fn identity(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Identity, message)
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Protocol, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

pub fn early_close_message() -> String {
    format!("The server closed the connection before sending a response. {ALLOWLIST_HINT}")
}

pub fn server_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Server, message)
}

pub fn map_iroh_error(error: &(dyn std::error::Error + 'static)) -> AppError {
    map_iroh_error_with(error, false)
}

pub fn map_iroh_error_with(
    error: &(dyn std::error::Error + 'static),
    closed_before_response: bool,
) -> AppError {
    if let Some(app_error) = error.downcast_ref::<AppError>() {
        if app_error.code == ErrorCode::ConnectionClosed && closed_before_response {
            return AppError::new(ErrorCode::ConnectionClosed, early_close_message());
        }
        return app_error.clone();
    }

    map_message(&error.to_string(), closed_before_response)
}

pub fn map_message(detail: &str, closed_before_response: bool) -> AppError {
    let normalized = detail.to_lowercase();

    if ["timeout", "timed out", "deadline", "etimedout"]
        .iter()
        .any(|pattern| normalized.contains(pattern))
    {
        return AppError::new(
            ErrorCode::Timeout,
            format!(
                "The connection timed out. Check the server ticket or NodeId, the relay URL, and that the server is online. ({detail})"
            ),
        );
    }

    if [
        "refused",
        "econnrefused",
        "reset",
        "econnreset",
        "not connected",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
    {
        return AppError::new(
            ErrorCode::ConnectionRefused,
            format!(
                "The server refused the connection. Check the server target and that the Hermes Iroh-channel plugin is running. ({detail})"
            ),
        );
    }

    if ["closed", "eof", "finished", "ended", "aborted"]
        .iter()
        .any(|pattern| normalized.contains(pattern))
    {
        if closed_before_response {
            return AppError::new(ErrorCode::ConnectionClosed, early_close_message());
        }
        return AppError::new(
            ErrorCode::ConnectionClosed,
            format!("The connection to the server was closed. Reconnect and try again. ({detail})"),
        );
    }

    if [
        "relay",
        "network",
        "unreachable",
        "dns",
        "socket",
        "transport",
        "enotfound",
        "ehostunreach",
        "enetunreach",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
    {
        return AppError::new(
            ErrorCode::Network,
            format!("Network or relay failure. Check your internet connection and the relay URL. ({detail})"),
        );
    }

    AppError::new(
        ErrorCode::Network,
        format!("Could not reach the server. ({detail})"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_timeouts() {
        let mapped = map_message("connection timed out", false);
        assert_eq!(mapped.code, ErrorCode::Timeout);
        assert!(mapped.message.to_lowercase().contains("timed out"));
    }

    #[test]
    fn classifies_relay_and_network_failures() {
        assert_eq!(
            map_message("relay unreachable", false).code,
            ErrorCode::Network
        );
        assert_eq!(
            map_message("DNS lookup failed", false).code,
            ErrorCode::Network
        );
    }

    #[test]
    fn classifies_refused_and_reset_connections() {
        assert_eq!(
            map_message("connection refused", false).code,
            ErrorCode::ConnectionRefused
        );
        assert_eq!(
            map_message("connection reset by peer", false).code,
            ErrorCode::ConnectionRefused
        );
    }

    #[test]
    fn adds_the_allowlist_hint_for_an_early_close() {
        let mapped = map_message("connection closed", true);
        assert_eq!(mapped.code, ErrorCode::ConnectionClosed);
        assert!(mapped.message.contains("/iroh_allow"));
    }

    #[test]
    fn omits_the_allowlist_hint_for_a_close_after_streaming_began() {
        let mapped = map_message("connection closed", false);
        assert_eq!(mapped.code, ErrorCode::ConnectionClosed);
        assert!(!mapped.message.contains("/iroh_allow"));
    }

    #[test]
    fn preserves_typed_application_errors() {
        let original = AppError::configuration("bad settings");
        let mapped = map_iroh_error(&original);
        assert_eq!(mapped.code, ErrorCode::Configuration);
        assert_eq!(mapped.message, "bad settings");
    }

    #[test]
    fn converts_unknown_failures_into_a_network_error() {
        let mapped = map_message("something unusual", false);
        assert_eq!(mapped.code, ErrorCode::Network);
        assert!(mapped.message.contains("something unusual"));
    }

    #[test]
    fn preserves_server_error_messages() {
        let error = server_error("the model is unavailable");
        assert_eq!(error.code, ErrorCode::Server);
        assert_eq!(error.message, "the model is unavailable");
    }
}
