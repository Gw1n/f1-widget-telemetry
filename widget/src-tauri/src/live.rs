//! Live order: a reducer over OpenF1 rows (REST bootstrap + MQTT stream) and the MQTT client.
//!
//! The widget needs only a handful of slow topics (positions, intervals, laps, stints,
//! race control), unlike the full app, which also streams every car's position and telemetry.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, watch};

use crate::api::Api;
use crate::model::{DriverCell, LiveRow, LiveView};

pub const TOPICS: [&str; 5] = ["position", "intervals", "laps", "stints", "race_control"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flag {
    Green,
    Yellow,
    Red,
    Sc,
    Vsc,
    ScEnd,
    Chequered,
}

impl Flag {
    pub fn as_str(self) -> &'static str {
        match self {
            Flag::Green => "GREEN",
            Flag::Yellow => "YELLOW",
            Flag::Red => "RED",
            Flag::Sc => "SC",
            Flag::Vsc => "VSC",
            Flag::ScEnd => "SC_END",
            Flag::Chequered => "CHEQUERED",
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Stint {
    number: i64,
    compound: String,
    lap_start: i64,
    age_at_start: i64,
}

#[derive(Debug, Clone)]
pub struct LiveState {
    pub session_key: i64,
    positions: HashMap<i64, i64>,
    /// driver -> (interval to the car ahead, gap to the leader)
    gaps: HashMap<i64, (Value, Value)>,
    laps: HashMap<i64, i64>,
    stints: HashMap<i64, Stint>,
    flag: Flag,
    pub drivers: HashMap<i64, DriverCell>,
}

fn int(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Seconds as "+1.2", text such as "+1 LAP" as is, null/zero as nothing.
pub fn format_gap(v: &Value) -> String {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(x) if x > 0.0 => format!("+{x:.1}"),
            _ => String::new(),
        },
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

impl LiveState {
    pub fn new(session_key: i64) -> Self {
        LiveState {
            session_key,
            positions: HashMap::new(),
            gaps: HashMap::new(),
            laps: HashMap::new(),
            stints: HashMap::new(),
            flag: Flag::Green,
            drivers: HashMap::new(),
        }
    }

    /// Apply a message payload: one JSON object or an array of them.
    pub fn apply_payload(&mut self, topic: &str, payload: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(payload) else { return };
        match value {
            Value::Array(rows) => rows.iter().for_each(|row| self.apply_row(topic, row)),
            row => self.apply_row(topic, &row),
        }
    }

    pub fn apply_row(&mut self, topic: &str, row: &Value) {
        // the broker feed is global: ignore other sessions
        if int(row, "session_key").is_some_and(|k| k != self.session_key) {
            return;
        }
        let topic = topic.strip_prefix("v1/").unwrap_or(topic);
        let driver = int(row, "driver_number");

        match (topic, driver) {
            ("position", Some(d)) => {
                if let Some(p) = int(row, "position") {
                    self.positions.insert(d, p);
                }
            }
            ("intervals", Some(d)) => {
                let interval = row.get("interval").cloned().unwrap_or(Value::Null);
                let gap = row.get("gap_to_leader").cloned().unwrap_or(Value::Null);
                self.gaps.insert(d, (interval, gap));
            }
            ("laps", Some(d)) => {
                if let Some(n) = int(row, "lap_number") {
                    let entry = self.laps.entry(d).or_insert(n);
                    *entry = (*entry).max(n);
                }
            }
            ("stints", Some(d)) => {
                let number = int(row, "stint_number").unwrap_or(0);
                let newer = self.stints.get(&d).is_none_or(|s| number >= s.number);
                if newer {
                    self.stints.insert(
                        d,
                        Stint {
                            number,
                            compound: text(row, "compound").to_string(),
                            lap_start: int(row, "lap_start").unwrap_or(1),
                            age_at_start: int(row, "tyre_age_at_start").unwrap_or(0),
                        },
                    );
                }
            }
            ("race_control", _) => self.apply_race_control(row),
            _ => {}
        }
    }

    fn apply_race_control(&mut self, row: &Value) {
        let message = text(row, "message");
        match text(row, "category") {
            "SafetyCar" => {
                if message.contains("DEPLOYED") {
                    self.flag = if message.contains("VIRTUAL") { Flag::Vsc } else { Flag::Sc };
                } else if message.contains("ENDING") || message.contains("IN THIS LAP") {
                    self.flag = Flag::ScEnd;
                }
            }
            "Flag" if text(row, "scope") == "Track" => {
                self.flag = match text(row, "flag") {
                    "GREEN" | "CLEAR" => Flag::Green,
                    "YELLOW" | "DOUBLE YELLOW" => Flag::Yellow,
                    "RED" => Flag::Red,
                    "CHEQUERED" => Flag::Chequered,
                    _ => self.flag,
                };
            }
            _ => {}
        }
    }

    pub fn flag(&self) -> Flag {
        self.flag
    }

    /// Highest lap any driver has reached (the leader's lap, in practice).
    pub fn lap(&self) -> Option<i64> {
        self.laps.values().copied().max()
    }

    pub fn has_positions(&self) -> bool {
        !self.positions.is_empty()
    }

    pub fn view(&self, session_name: &str) -> LiveView {
        let mut rows: Vec<LiveRow> = self
            .positions
            .iter()
            .map(|(&number, &position)| {
                let (interval, gap) = self.gaps.get(&number).cloned().unwrap_or((Value::Null, Value::Null));
                let stint = self.stints.get(&number);
                let lap = self.laps.get(&number).copied();
                let tyre_age = stint.map(|s| (s.age_at_start + (lap.unwrap_or(s.lap_start) - s.lap_start)).max(0));
                LiveRow {
                    position,
                    driver: self.drivers.get(&number).cloned().unwrap_or_else(|| DriverCell {
                        number,
                        acronym: format!("#{number}"),
                        color: "#888888".into(),
                        ..Default::default()
                    }),
                    interval: if position == 1 { String::new() } else { format_gap(&interval) },
                    gap: if position == 1 { String::new() } else { format_gap(&gap) },
                    compound: stint.map(|s| s.compound.clone()).unwrap_or_default(),
                    tyre_age,
                }
            })
            .collect();
        rows.sort_by_key(|r| (r.position, r.driver.number));

        LiveView {
            status: "live".into(),
            message: None,
            session: session_name.to_string(),
            lap: self.lap(),
            flag: self.flag.as_str().into(),
            rows,
        }
    }
}

// ───────────────────────── MQTT ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MqttConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
}

impl Default for MqttConfig {
    /// OpenF1's broker: MQTT over TLS, the access token as the password.
    fn default() -> Self {
        MqttConfig { host: "mqtt.openf1.org".into(), port: 8883, tls: true }
    }
}

impl MqttConfig {
    /// `F1W_MQTT_URL=tcp://127.0.0.1:1883` points the widget at a local test broker.
    pub fn from_env() -> Self {
        std::env::var("F1W_MQTT_URL").ok().and_then(|u| Self::parse(&u)).unwrap_or_default()
    }

    pub fn parse(url: &str) -> Option<Self> {
        let (scheme, rest) = url.split_once("://")?;
        let (host, port) = rest.trim_end_matches('/').rsplit_once(':')?;
        Some(MqttConfig { host: host.into(), port: port.parse().ok()?, tls: scheme != "tcp" && scheme != "mqtt" })
    }
}

#[derive(Debug)]
pub enum LiveEvent {
    Connected,
    Reconnecting(String),
    Denied,
    Message { topic: String, payload: Vec<u8> },
}

/// Runs the MQTT client until `stop` flips. A new client (with a fresh token) is built every
/// 50 minutes, because the broker password is a token that expires after an hour.
pub async fn run_mqtt(api: std::sync::Arc<Api>, config: MqttConfig, tx: mpsc::UnboundedSender<LiveEvent>, mut stop: watch::Receiver<bool>) {
    use rumqttc::{AsyncClient, ConnectReturnCode, ConnectionError, Event, MqttOptions, Packet, QoS, Transport};

    // a denial right after a (re)start is usually an expired token, so the first one is retried silently
    let mut last_denied: Option<std::time::Instant> = None;

    loop {
        if *stop.borrow() {
            return;
        }
        let token = match api.token().await {
            Ok(t) => t,
            Err(e) => {
                let _ = tx.send(LiveEvent::Reconnecting(e.to_string()));
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(15)) => continue,
                    _ = stop.changed() => return,
                }
            }
        };

        let username = api.username().await.unwrap_or_else(|| "openf1".into());
        let client_id = format!("f1w-{:08x}", std::process::id() ^ (chrono::Utc::now().timestamp_subsec_nanos()));
        let mut options = MqttOptions::new(client_id, config.host.clone(), config.port);
        options.set_credentials(username, token);
        options.set_keep_alive(Duration::from_secs(30));
        if config.tls {
            options.set_transport(Transport::tls_with_default_config());
        }
        let (client, mut events) = AsyncClient::new(options, 64);
        let renew = tokio::time::sleep(Duration::from_secs(50 * 60));
        tokio::pin!(renew);

        loop {
            tokio::select! {
                event = events.poll() => match event {
                    Ok(Event::Incoming(Packet::ConnAck(_))) => {
                        for topic in TOPICS {
                            let _ = client.subscribe(format!("v1/{topic}"), QoS::AtMostOnce).await;
                        }
                        let _ = tx.send(LiveEvent::Connected);
                    }
                    Ok(Event::Incoming(Packet::Publish(p))) => {
                        let _ = tx.send(LiveEvent::Message { topic: p.topic, payload: p.payload.to_vec() });
                    }
                    Ok(_) => {}
                    Err(ConnectionError::ConnectionRefused(
                        ConnectReturnCode::BadUserNamePassword | ConnectReturnCode::NotAuthorized,
                    )) => {
                        if last_denied.is_some_and(|at| at.elapsed() < Duration::from_secs(60)) {
                            // denied again with a fresh token: the account itself is the problem
                            let _ = tx.send(LiveEvent::Denied);
                            tokio::select! {
                                _ = tokio::time::sleep(Duration::from_secs(120)) => break,
                                _ = stop.changed() => return,
                            }
                        }
                        last_denied = Some(std::time::Instant::now());
                        break; // rebuild the client with a freshly issued token
                    }
                    Err(e) => {
                        let _ = tx.send(LiveEvent::Reconnecting(e.to_string()));
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                            _ = stop.changed() => return,
                        }
                    }
                },
                _ = &mut renew => break,
                _ = stop.changed() => {
                    let _ = client.disconnect().await;
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state() -> LiveState {
        let mut s = LiveState::new(7);
        for (n, acr) in [(1, "VER"), (4, "NOR"), (16, "LEC")] {
            s.drivers.insert(n, DriverCell { number: n, acronym: acr.into(), color: "#112233".into(), ..Default::default() });
        }
        s
    }

    #[test]
    fn orders_rows_by_position_and_blanks_the_leaders_gaps() {
        let mut s = state();
        s.apply_row("v1/position", &json!({ "session_key": 7, "driver_number": 4, "position": 2 }));
        s.apply_row("v1/position", &json!({ "session_key": 7, "driver_number": 1, "position": 1 }));
        s.apply_row("v1/intervals", &json!({ "session_key": 7, "driver_number": 4, "interval": 2.34, "gap_to_leader": 2.34 }));
        s.apply_row("v1/intervals", &json!({ "session_key": 7, "driver_number": 1, "interval": 0, "gap_to_leader": 0 }));
        let v = s.view("Race");
        assert_eq!(v.rows.iter().map(|r| r.driver.acronym.as_str()).collect::<Vec<_>>(), ["VER", "NOR"]);
        assert_eq!(v.rows[0].gap, "");
        assert_eq!(v.rows[1].interval, "+2.3");
    }

    #[test]
    fn lapped_cars_keep_their_text_gap() {
        let mut s = state();
        s.apply_row("position", &json!({ "driver_number": 16, "position": 3 }));
        s.apply_row("intervals", &json!({ "driver_number": 16, "interval": "+1 LAP", "gap_to_leader": "+1 LAP" }));
        assert_eq!(s.view("Race").rows[0].gap, "+1 LAP");
    }

    #[test]
    fn rows_of_other_sessions_are_ignored() {
        let mut s = state();
        s.apply_row("v1/position", &json!({ "session_key": 99, "driver_number": 1, "position": 1 }));
        assert!(!s.has_positions());
    }

    #[test]
    fn a_later_position_replaces_an_earlier_one() {
        let mut s = state();
        s.apply_row("position", &json!({ "driver_number": 1, "position": 3 }));
        s.apply_row("position", &json!({ "driver_number": 1, "position": 1 }));
        assert_eq!(s.view("Race").rows[0].position, 1);
    }

    #[test]
    fn tyre_age_counts_laps_since_the_stint_began() {
        let mut s = state();
        s.apply_row("position", &json!({ "driver_number": 1, "position": 1 }));
        s.apply_row("stints", &json!({ "driver_number": 1, "stint_number": 1, "compound": "MEDIUM", "lap_start": 1, "tyre_age_at_start": 0 }));
        s.apply_row("laps", &json!({ "driver_number": 1, "lap_number": 12 }));
        let row = &s.view("Race").rows[0];
        assert_eq!((row.compound.as_str(), row.tyre_age), ("MEDIUM", Some(11)));

        // a new stint after the pit stop, on used tyres
        s.apply_row("stints", &json!({ "driver_number": 1, "stint_number": 2, "compound": "HARD", "lap_start": 13, "tyre_age_at_start": 3 }));
        s.apply_row("laps", &json!({ "driver_number": 1, "lap_number": 20 }));
        let row = &s.view("Race").rows[0];
        assert_eq!((row.compound.as_str(), row.tyre_age), ("HARD", Some(10)));
    }

    #[test]
    fn an_old_stint_message_does_not_overwrite_a_newer_stint() {
        let mut s = state();
        s.apply_row("position", &json!({ "driver_number": 1, "position": 1 }));
        s.apply_row("stints", &json!({ "driver_number": 1, "stint_number": 2, "compound": "HARD", "lap_start": 13 }));
        s.apply_row("stints", &json!({ "driver_number": 1, "stint_number": 1, "compound": "MEDIUM", "lap_start": 1 }));
        assert_eq!(s.view("Race").rows[0].compound, "HARD");
    }

    #[test]
    fn race_control_drives_the_flag_state() {
        let mut s = state();
        let rc = |category: &str, flag: &str, scope: &str, message: &str| {
            json!({ "category": category, "flag": flag, "scope": scope, "message": message })
        };
        s.apply_row("race_control", &rc("Flag", "YELLOW", "Track", "YELLOW IN TRACK"));
        assert_eq!(s.flag(), Flag::Yellow);
        s.apply_row("race_control", &rc("Flag", "YELLOW", "Sector", "YELLOW IN SECTOR 4"));
        s.apply_row("race_control", &rc("Flag", "GREEN", "Sector", "CLEAR IN SECTOR 4"));
        assert_eq!(s.flag(), Flag::Yellow, "sector flags do not change the track state");
        s.apply_row("race_control", &rc("SafetyCar", "", "", "SAFETY CAR DEPLOYED"));
        assert_eq!(s.flag(), Flag::Sc);
        s.apply_row("race_control", &rc("SafetyCar", "", "", "SAFETY CAR IN THIS LAP"));
        assert_eq!(s.flag(), Flag::ScEnd);
        s.apply_row("race_control", &rc("Flag", "GREEN", "Track", "GREEN LIGHT"));
        assert_eq!(s.flag(), Flag::Green);
        s.apply_row("race_control", &rc("SafetyCar", "", "", "VIRTUAL SAFETY CAR DEPLOYED"));
        assert_eq!(s.flag(), Flag::Vsc);
        s.apply_row("race_control", &rc("Flag", "RED", "Track", "RED FLAG"));
        assert_eq!(s.flag(), Flag::Red);
        s.apply_row("race_control", &rc("Flag", "CHEQUERED", "Track", "CHEQUERED FLAG"));
        assert_eq!(s.flag(), Flag::Chequered);
    }

    #[test]
    fn payloads_may_be_objects_arrays_or_garbage() {
        let mut s = state();
        s.apply_payload("v1/position", br#"{"session_key":7,"driver_number":1,"position":1}"#);
        s.apply_payload("v1/position", br#"[{"session_key":7,"driver_number":4,"position":2},{"session_key":7,"driver_number":16,"position":3}]"#);
        s.apply_payload("v1/position", b"not json");
        s.apply_payload("v1/position", b"");
        assert_eq!(s.view("Race").rows.len(), 3);
    }

    #[test]
    fn unknown_drivers_get_a_placeholder_instead_of_vanishing() {
        let mut s = state();
        s.apply_row("position", &json!({ "driver_number": 99, "position": 1 }));
        assert_eq!(s.view("Race").rows[0].driver.acronym, "#99");
    }

    #[test]
    fn gap_formatting() {
        assert_eq!(format_gap(&json!(2.349)), "+2.3");
        assert_eq!(format_gap(&json!(0)), "");
        assert_eq!(format_gap(&json!(null)), "");
        assert_eq!(format_gap(&json!("+2 LAPS")), "+2 LAPS");
    }

    #[test]
    fn broker_url_parsing() {
        assert_eq!(MqttConfig::parse("tcp://127.0.0.1:18884"), Some(MqttConfig { host: "127.0.0.1".into(), port: 18884, tls: false }));
        assert_eq!(MqttConfig::parse("tls://mqtt.example.org:8883/"), Some(MqttConfig { host: "mqtt.example.org".into(), port: 8883, tls: true }));
        assert_eq!(MqttConfig::parse("garbage"), None);
        assert_eq!(MqttConfig::default().port, 8883);
    }
}
