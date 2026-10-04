//! Wire formats of the OpenF1 REST API and the snapshot sent to the widget window.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
pub struct Session {
    pub session_key: i64,
    pub session_name: String,
    pub meeting_key: i64,
    pub date_start: DateTime<Utc>,
    pub date_end: DateTime<Utc>,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub country_name: String,
    #[serde(default)]
    pub is_cancelled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Meeting {
    pub meeting_key: i64,
    #[serde(default)]
    pub meeting_name: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub country_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Driver {
    pub driver_number: i64,
    #[serde(default)]
    pub name_acronym: String,
    #[serde(default)]
    pub full_name: String,
    #[serde(default)]
    pub team_name: String,
    #[serde(default)]
    pub team_colour: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GridRow {
    pub position: i64,
    pub driver_number: i64,
    #[serde(default)]
    pub lap_duration: Option<f64>,
    pub session_key: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResultRow {
    #[serde(default)]
    pub position: Option<i64>,
    pub driver_number: i64,
    #[serde(default)]
    pub points: Option<f64>,
    #[serde(default)]
    pub dnf: bool,
    #[serde(default)]
    pub dns: bool,
    #[serde(default)]
    pub dsq: bool,
    /// A number of seconds, a string such as "+1 LAP", or null.
    #[serde(default)]
    pub gap_to_leader: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChampionshipDriver {
    pub driver_number: i64,
    #[serde(default)]
    pub position_current: Option<i64>,
    #[serde(default)]
    pub points_current: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChampionshipTeam {
    pub team_name: String,
    #[serde(default)]
    pub position_current: Option<i64>,
    #[serde(default)]
    pub points_current: Option<f64>,
}

// ───────────────────────── what the window receives ─────────────────────────

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub name: String,
    pub short: String,
    pub start_ms: i64,
    pub end_ms: i64,
    /// "finished" | "inProgress" | "upcoming"
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingView {
    pub name: String,
    pub location: String,
    pub country: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DriverCell {
    pub number: i64,
    pub acronym: String,
    pub name: String,
    pub team: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridEntry {
    pub position: i64,
    pub driver: DriverCell,
    pub lap_time: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultEntry {
    pub position: Option<i64>,
    pub driver: DriverCell,
    pub points: Option<f64>,
    /// "DNF" | "DNS" | "DSQ" or empty
    pub note: String,
    /// seconds behind the winner, or text like "+1 LAP"
    pub gap: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultView {
    pub meeting: String,
    pub session: String,
    pub rows: Vec<ResultEntry>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridView {
    pub meeting: String,
    pub rows: Vec<GridEntry>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StandingEntry {
    pub position: i64,
    pub driver: DriverCell,
    pub points: f64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamStanding {
    pub position: i64,
    pub team: String,
    pub points: f64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StandingsView {
    pub drivers: Vec<StandingEntry>,
    pub teams: Vec<TeamStanding>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRow {
    pub position: i64,
    pub driver: DriverCell,
    pub interval: String,
    pub gap: String,
    /// "SOFT" | "MEDIUM" | ... or empty
    pub compound: String,
    pub tyre_age: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveView {
    /// "noAccount" | "noSession" | "connecting" | "live" | "error"
    pub status: String,
    pub message: Option<String>,
    pub session: String,
    pub lap: Option<i64>,
    /// "GREEN" | "YELLOW" | "RED" | "SC" | "VSC" | "SC_END" | "CHEQUERED"
    pub flag: String,
    pub rows: Vec<LiveRow>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub logged_in: bool,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub locale: String,
    pub now_ms: i64,
    pub meeting: Option<MeetingView>,
    /// the session that is on track now, or the next one
    pub next: Option<SessionView>,
    pub weekend: Vec<SessionView>,
    pub grid: Option<GridView>,
    pub last_race: Option<ResultView>,
    pub standings: Option<StandingsView>,
    pub live: LiveView,
    pub account: AccountView,
    /// last network problem, shown as a hint when there is no data at all
    pub error: Option<String>,
}
