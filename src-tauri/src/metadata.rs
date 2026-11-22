use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Number, Value};

use crate::protocol::{AccountBalance, PlanGauge, ResponseMetadata, SessionUsage, TokenUsage};

const TOKEN_COUNTER_KEYS: [&str; 6] = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
];

const SESSION_COUNTER_KEYS: [&str; 6] = [
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "api_calls",
    "context_tokens",
    "context_length",
];

const BALANCE_AMOUNT_KEYS: [&str; 8] = [
    "remaining_micros",
    "remaining_usd",
    "subscription_micros",
    "subscription_usd",
    "subscription_limit_usd",
    "purchased_micros",
    "purchased_usd",
    "as_of_ms",
];

static ISO_UTC_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]00:00)$")
        .expect("the ISO timestamp pattern is valid")
});

fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn is_iso_utc(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    if !ISO_UTC_PATTERN.is_match(text) {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text).ok()?;
    Some(text.to_owned())
}

fn is_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 {
        return None;
    }
    if number < i64::MIN as f64 || number > i64::MAX as f64 {
        return None;
    }
    Some(number as i64)
}

fn amount(value: &Value) -> Option<Number> {
    let number = value.as_f64()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    match value {
        Value::Number(number) => Some(number.clone()),
        _ => None,
    }
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(ToOwned::to_owned)
}

fn normalize_usage(value: Option<&Value>) -> Option<TokenUsage> {
    let record = as_record(value?)?;
    let mut usage = TokenUsage {
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        reasoning_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
    };

    for key in TOKEN_COUNTER_KEYS {
        let counter = record.get(key).and_then(amount);
        match key {
            "input_tokens" => usage.input_tokens = counter,
            "output_tokens" => usage.output_tokens = counter,
            "total_tokens" => usage.total_tokens = counter,
            "reasoning_tokens" => usage.reasoning_tokens = counter,
            "cache_read_tokens" => usage.cache_read_tokens = counter,
            "cache_write_tokens" => usage.cache_write_tokens = counter,
            _ => {}
        }
    }

    (!usage.is_empty()).then_some(usage)
}

fn normalize_session_usage(value: Option<&Value>) -> Option<SessionUsage> {
    let record = as_record(value?)?;
    let mut usage = SessionUsage {
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        api_calls: None,
        estimated_cost_usd: None,
        cost_status: None,
        cost_source: None,
        context_tokens: None,
        context_length: None,
        context_percent: None,
    };

    for key in SESSION_COUNTER_KEYS {
        let counter = record.get(key).and_then(amount);
        match key {
            "input_tokens" => usage.input_tokens = counter,
            "output_tokens" => usage.output_tokens = counter,
            "total_tokens" => usage.total_tokens = counter,
            "api_calls" => usage.api_calls = counter,
            "context_tokens" => usage.context_tokens = counter,
            "context_length" => usage.context_length = counter,
            _ => {}
        }
    }

    usage.estimated_cost_usd = record.get("estimated_cost_usd").and_then(amount);
    usage.context_percent = record.get("context_percent").and_then(amount);
    usage.cost_status = record.get("cost_status").and_then(text);
    usage.cost_source = record.get("cost_source").and_then(text);

    (!usage.is_empty()).then_some(usage)
}

fn normalize_plan_gauge(value: Option<&Value>) -> Option<PlanGauge> {
    let record = as_record(value?)?;
    let gauge = PlanGauge {
        id: record.get("id").and_then(text),
        label: record.get("label").and_then(text),
        used_bp: record.get("used_bp").and_then(amount),
        resets_at_ms: record.get("resets_at_ms").and_then(amount),
    };
    (!gauge.is_empty()).then_some(gauge)
}

fn normalize_balance(value: Option<&Value>) -> Option<AccountBalance> {
    let record = as_record(value?)?;
    let mut balance = AccountBalance {
        provider: record.get("provider").and_then(text),
        remaining_micros: None,
        remaining_usd: None,
        subscription_micros: None,
        subscription_usd: None,
        subscription_limit_usd: None,
        purchased_micros: None,
        purchased_usd: None,
        paid_access: record.get("paid_access").and_then(Value::as_bool),
        as_of_ms: None,
        plan_gauge: normalize_plan_gauge(record.get("plan_gauge")),
    };

    for key in BALANCE_AMOUNT_KEYS {
        let field = record.get(key).and_then(amount);
        match key {
            "remaining_micros" => balance.remaining_micros = field,
            "remaining_usd" => balance.remaining_usd = field,
            "subscription_micros" => balance.subscription_micros = field,
            "subscription_usd" => balance.subscription_usd = field,
            "subscription_limit_usd" => balance.subscription_limit_usd = field,
            "purchased_micros" => balance.purchased_micros = field,
            "purchased_usd" => balance.purchased_usd = field,
            "as_of_ms" => balance.as_of_ms = field,
            _ => {}
        }
    }

    (!balance.is_empty()).then_some(balance)
}

pub fn normalize_response_metadata(value: &Value) -> Option<ResponseMetadata> {
    let record = as_record(value)?;
    let schema = record.get("schema").and_then(is_integer)?;
    let generated_at = record.get("generated_at").and_then(is_iso_utc)?;
    let latency_ms = record.get("latency_ms").and_then(is_integer)?;
    if latency_ms < 0 {
        return None;
    }

    Some(ResponseMetadata {
        schema,
        generated_at,
        latency_ms,
        model: record.get("model").and_then(text),
        provider: record.get("provider").and_then(text),
        usage: normalize_usage(record.get("usage")),
        session_usage: normalize_session_usage(record.get("session_usage")),
        balance: normalize_balance(record.get("balance")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn required() -> Value {
        json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812
        })
    }

    fn full_metadata() -> Value {
        json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812,
            "model": "gpt-5.1",
            "provider": "openai",
            "usage": {
                "input_tokens": 1200,
                "output_tokens": 300,
                "total_tokens": 1500,
                "reasoning_tokens": 12,
                "cache_read_tokens": 40,
                "cache_write_tokens": 8
            },
            "session_usage": {
                "input_tokens": 10200,
                "output_tokens": 2400,
                "total_tokens": 12600,
                "api_calls": 8,
                "estimated_cost_usd": 0.42,
                "cost_status": "estimated",
                "cost_source": "model_catalog",
                "context_tokens": 8400,
                "context_length": 128000,
                "context_percent": 6.6
            },
            "balance": {
                "provider": "nous",
                "remaining_micros": 12500000,
                "remaining_usd": 12.5,
                "subscription_micros": 1000000,
                "subscription_usd": 1,
                "subscription_limit_usd": 10,
                "purchased_micros": 500000,
                "purchased_usd": 0.5,
                "paid_access": true,
                "as_of_ms": 1763726400000i64,
                "plan_gauge": {
                    "id": "plan-1",
                    "label": "Pro",
                    "used_bp": 1250,
                    "resets_at_ms": 1766320000000i64
                }
            }
        })
    }

    #[test]
    fn returns_every_recognized_field_for_a_complete_object() {
        let metadata = normalize_response_metadata(&full_metadata()).expect("valid metadata");
        assert_eq!(
            serde_json::to_value(metadata).expect("serialize"),
            full_metadata()
        );
    }

    #[test]
    fn rejects_non_object_values() {
        for value in [
            json!(null),
            json!("metadata"),
            json!(42),
            json!([]),
            json!(true),
        ] {
            assert!(normalize_response_metadata(&value).is_none());
        }
    }

    #[test]
    fn rejects_missing_or_invalid_required_fields() {
        assert!(normalize_response_metadata(
            &json!({ "schema": "1", "generated_at": "2026-11-21T12:00:00.000Z", "latency_ms": 1 })
        )
        .is_none());
        assert!(normalize_response_metadata(
            &json!({ "schema": 1.5, "generated_at": "2026-11-21T12:00:00.000Z", "latency_ms": 1 })
        )
        .is_none());
        assert!(normalize_response_metadata(
            &json!({ "generated_at": "2026-11-21T12:00:00.000Z", "latency_ms": 1 })
        )
        .is_none());
        assert!(normalize_response_metadata(&json!({ "schema": 1, "latency_ms": 1 })).is_none());
        assert!(normalize_response_metadata(
            &json!({ "schema": 1, "generated_at": "2026-11-21T12:00:00.000Z" })
        )
        .is_none());
    }

    #[test]
    fn rejects_invalid_generated_at_values() {
        for generated_at in [
            json!("not a timestamp"),
            json!("2026-11-21"),
            json!("2026-11-21T12:00:00"),
            json!("2026-11-21T12:00:00+01:00"),
            json!("2026-13-01T00:00:00.000Z"),
            json!(1763726400000i64),
        ] {
            let mut value = required();
            value["generated_at"] = generated_at;
            assert!(normalize_response_metadata(&value).is_none());
        }
    }

    #[test]
    fn accepts_a_plus_zero_designator() {
        let mut value = required();
        value["generated_at"] = json!("2026-11-21T12:00:00+00:00");
        let metadata = normalize_response_metadata(&value).expect("valid");
        assert_eq!(metadata.generated_at, "2026-11-21T12:00:00+00:00");
    }

    #[test]
    fn rejects_invalid_latency_values() {
        for latency in [json!(-1), json!(1.5), json!("812")] {
            let mut value = required();
            value["latency_ms"] = latency;
            assert!(normalize_response_metadata(&value).is_none());
        }
    }

    #[test]
    fn accepts_a_newer_schema_and_drops_unknown_fields() {
        let mut value = full_metadata();
        value["schema"] = json!(2);
        value["extra"] = json!("top-level");
        value["usage"]["unknown_counter"] = json!(5);
        value["session_usage"]["unknown_session"] = json!("value");
        value["balance"]["unknown_balance"] = json!(true);

        let metadata = normalize_response_metadata(&value).expect("valid");
        let mut expected = full_metadata();
        expected["schema"] = json!(2);
        assert_eq!(serde_json::to_value(metadata).expect("serialize"), expected);
    }

    #[test]
    fn drops_unknown_nested_fields() {
        let value = json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812,
            "usage": { "input_tokens": 3, "unknown_counter": 5 },
            "session_usage": { "total_tokens": 9, "unknown_session": "value" },
            "balance": {
                "remaining_usd": 1.25,
                "unknown_balance": true,
                "plan_gauge": { "label": "Pro", "unknown_gauge": 1 }
            }
        });

        let metadata = normalize_response_metadata(&value).expect("valid");
        assert_eq!(
            serde_json::to_value(metadata).expect("serialize"),
            json!({
                "schema": 1,
                "generated_at": "2026-11-21T12:00:00.000Z",
                "latency_ms": 812,
                "usage": { "input_tokens": 3 },
                "session_usage": { "total_tokens": 9 },
                "balance": { "remaining_usd": 1.25, "plan_gauge": { "label": "Pro" } }
            })
        );
    }

    #[test]
    fn keeps_valid_groups_when_another_group_is_malformed() {
        let value = json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812,
            "usage": "not an object",
            "session_usage": { "input_tokens": 10, "output_tokens": "many", "total_tokens": -1 },
            "balance": { "remaining_micros": 5000000, "paid_access": "yes", "as_of_ms": -5 }
        });

        let metadata = normalize_response_metadata(&value).expect("valid");
        assert_eq!(
            serde_json::to_value(metadata).expect("serialize"),
            json!({
                "schema": 1,
                "generated_at": "2026-11-21T12:00:00.000Z",
                "latency_ms": 812,
                "session_usage": { "input_tokens": 10 },
                "balance": { "remaining_micros": 5000000 }
            })
        );
    }

    #[test]
    fn accepts_zero_values() {
        let value = json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 0,
            "usage": { "input_tokens": 0, "total_tokens": 0 },
            "session_usage": { "context_percent": 0, "estimated_cost_usd": 0 },
            "balance": { "remaining_usd": 0 }
        });

        let metadata = normalize_response_metadata(&value).expect("valid");
        assert_eq!(serde_json::to_value(metadata).expect("serialize"), value);
    }

    #[test]
    fn omits_empty_optional_groups() {
        let value = json!({
            "schema": 1,
            "generated_at": "2026-11-21T12:00:00.000Z",
            "latency_ms": 812,
            "usage": {},
            "session_usage": { "cost_status": 5 },
            "balance": { "paid_access": null }
        });

        let metadata = normalize_response_metadata(&value).expect("valid");
        assert_eq!(
            serde_json::to_value(metadata).expect("serialize"),
            required()
        );
    }
}
