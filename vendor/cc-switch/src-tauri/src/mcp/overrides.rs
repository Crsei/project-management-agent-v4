//! Explicit agent patches may change native options; absent options still keep
//! the source adapter's native-owned merge policy. Connection fields are already
//! replaced with the effective spec by each adapter before this helper runs.
use serde_json::{Map, Value};
fn merge(target: &mut Value, patch: &Value) {
    if let Some(patch) = patch.as_object() {
        if !target.is_object() { *target = Value::Object(Map::new()); }
        let target = target.as_object_mut().unwrap();
        for (key, value) in patch {
            if value.is_null() { target.remove(key); }
            else { merge(target.entry(key.clone()).or_insert(Value::Null), value); }
        }
    } else { *target = patch.clone(); }
}
pub(crate) fn apply_options(native: &mut Map<String, Value>, patch: Option<&Value>, connection_fields: &[&str]) {
    for (key, value) in patch.and_then(Value::as_object).into_iter().flatten() {
        if connection_fields.contains(&key.as_str()) || matches!(key.as_str(), "enabled" | "disabled" | "serverName" | "serverUrl" | "transport") { continue; }
        if value.is_null() { native.remove(key); }
        else { merge(native.entry(key.clone()).or_insert(Value::Null), value); }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn absent_options_stay_native_but_explicit_removals_are_respected() {
        let mut native = json!({"timeout":10,"auth":{"keep":true,"remove":"fixture"},"enabled":true,"nativeOnly":1});
        apply_options(native.as_object_mut().unwrap(), Some(&json!({"timeout":null,"auth":{"remove":null,"new":2},"enabled":false})), &["command","env"]);
        assert_eq!(native,json!({"auth":{"keep":true,"new":2},"enabled":true,"nativeOnly":1}));
    }
}
