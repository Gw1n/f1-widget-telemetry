//! Turns API rows into the views the window and the tray show, and assembles the snapshot.

use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::format::{self, Locale};
use crate::live::{self, LiveState};
use crate::model::*;
use crate::schedule::{self, Kind, Status};

pub type Drivers = HashMap<i64, Driver>;

pub fn driver_cell(drivers: &Drivers, number: i64) -> DriverCell {
    match drivers.get(&number) {
        Some(d) => DriverCell {
            number,
            acronym: d.name_acronym.clone(),
            name: d.full_name.clone(),
            team: d.team_name.clone(),
            color: format!("#{}", d.team_colour.as_deref().filter(|c| !c.is_empty()).unwrap_or("888888")),
        },
        None => DriverCell { number, acronym: format!("#{number}"), color: "#888888".into(), ..Default::default() },
    }
}

pub fn build_result_view(meeting: &str, session: &str, rows: &[ResultRow], drivers: &Drivers) -> ResultView {
    let mut entries: Vec<ResultEntry> = rows
        .iter()
        .map(|r| ResultEntry {
            position: r.position,
            driver: driver_cell(drivers, r.driver_number),
            points: r.points,
            note: if r.dsq {
                "DSQ"
            } else if r.dns {
                "DNS"
            } else if r.dnf {
                "DNF"
            } else {
                ""
            }
            .into(),
            gap: Some(live::format_gap(&r.gap_to_leader)).filter(|g| !g.is_empty()),
        })
        .collect();
    // classified drivers first, in order; the rest keep their relative order at the end
    entries.sort_by_key(|e| (e.position.is_none(), e.position.unwrap_or(0), e.driver.number));
    ResultView { meeting: meeting.into(), session: session.into(), rows: entries }
}

/// The grid is keyed by the qualifying session; sprint qualifying may appear in the same reply.
pub fn build_grid_view(meeting: &str, rows: &[GridRow], quali_key: i64, drivers: &Drivers) -> GridView {
    let mut entries: Vec<GridEntry> = rows
        .iter()
        .filter(|r| r.session_key == quali_key)
        .map(|r| GridEntry { position: r.position, driver: driver_cell(drivers, r.driver_number), lap_time: r.lap_duration })
        .collect();
    entries.sort_by_key(|e| (e.position, e.driver.number));
    GridView { meeting: meeting.into(), rows: entries }
}

pub fn build_standings_view(drivers_rows: &[ChampionshipDriver], teams_rows: &[ChampionshipTeam], drivers: &Drivers) -> StandingsView {
    let mut standings: Vec<StandingEntry> = drivers_rows
        .iter()
        .filter_map(|r| {
            Some(StandingEntry {
                position: r.position_current?,
                driver: driver_cell(drivers, r.driver_number),
                points: r.points_current.unwrap_or(0.0),
            })
        })
        .collect();
    standings.sort_by_key(|s| s.position);

    let mut teams: Vec<TeamStanding> = teams_rows
        .iter()
        .filter_map(|r| Some(TeamStanding { position: r.position_current?, team: r.team_name.clone(), points: r.points_current.unwrap_or(0.0) }))
        .collect();
    teams.sort_by_key(|t| t.position);

    StandingsView { drivers: standings, teams }
}

// ───────────────────────── what to fetch ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DetailsPlan {
    /// (session_key, meeting_key) of the last finished race
    pub last_race: Option<(i64, i64)>,
    /// (meeting_key, qualifying session_key) of the upcoming race, once qualifying is over
    pub grid: Option<(i64, i64)>,
}

pub fn plan_details(sessions: &[Session], now: DateTime<Utc>) -> DetailsPlan {
    let last_race = schedule::last_finished_race(sessions, now).map(|s| (s.session_key, s.meeting_key));

    let grid = schedule::next_session(sessions, now).and_then(|next| {
        let quali = schedule::qualifying_of(sessions, next.meeting_key)?;
        let race = schedule::race_of(sessions, next.meeting_key)?;
        (quali.date_end <= now && race.date_end > now).then_some((next.meeting_key, quali.session_key))
    });

    DetailsPlan { last_race, grid }
}

// ───────────────────────── the snapshot ─────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Conn {
    #[default]
    Connecting,
    Connected,
    Reconnecting(String),
    Denied,
}

#[derive(Default)]
pub struct Store {
    pub locale: Locale,
    pub sessions: Vec<Session>,
    pub meetings: HashMap<i64, Meeting>,
    pub grid: Option<GridView>,
    pub last_race: Option<ResultView>,
    pub standings: Option<StandingsView>,
    pub live: Option<LiveState>,
    pub conn: Conn,
    pub account: Option<String>,
    pub error: Option<String>,
}

fn kind_of(s: &Session) -> Kind {
    schedule::classify(&s.session_name)
}

fn session_view(s: &Session, now: DateTime<Utc>, locale: Locale) -> SessionView {
    let kind = kind_of(s);
    SessionView {
        name: format::long_name(kind, &s.session_name, locale),
        short: format::short_name(kind, &s.session_name, locale),
        start_ms: s.date_start.timestamp_millis(),
        end_ms: s.date_end.timestamp_millis(),
        status: match schedule::status(s, now) {
            Status::Finished => "finished",
            Status::InProgress => "inProgress",
            Status::Upcoming => "upcoming",
        }
        .into(),
    }
}

impl Store {
    pub fn meeting_name(&self, meeting_key: i64) -> String {
        self.meetings
            .get(&meeting_key)
            .map(|m| m.meeting_name.clone())
            .filter(|n| !n.is_empty())
            .or_else(|| {
                self.sessions
                    .iter()
                    .find(|s| s.meeting_key == meeting_key)
                    .map(|s| format!("{} {}", s.country_name, s.location))
            })
            .unwrap_or_default()
    }

    pub fn snapshot(&self, now: DateTime<Utc>) -> Snapshot {
        let locale = self.locale;
        let next = schedule::next_session(&self.sessions, now);

        let meeting = next.map(|n| {
            let m = self.meetings.get(&n.meeting_key);
            MeetingView {
                name: self.meeting_name(n.meeting_key),
                location: m.map(|m| m.location.clone()).filter(|l| !l.is_empty()).unwrap_or_else(|| n.location.clone()),
                country: m.map(|m| m.country_name.clone()).filter(|c| !c.is_empty()).unwrap_or_else(|| n.country_name.clone()),
            }
        });
        let weekend = next
            .map(|n| schedule::weekend(&self.sessions, n.meeting_key).into_iter().map(|s| session_view(s, now, locale)).collect())
            .unwrap_or_default();

        Snapshot {
            locale: locale.code().into(),
            now_ms: now.timestamp_millis(),
            meeting,
            next: next.map(|s| session_view(s, now, locale)),
            weekend,
            grid: self.grid.clone(),
            last_race: self.last_race.clone(),
            standings: self.standings.clone(),
            live: self.live_view(now),
            account: AccountView { logged_in: self.account.is_some(), username: self.account.clone() },
            error: self.error.clone(),
        }
    }

    fn live_view(&self, now: DateTime<Utc>) -> LiveView {
        let blank = |status: &str, session: String| LiveView { status: status.into(), session, flag: "GREEN".into(), ..Default::default() };

        let Some(candidate) = schedule::live_candidate(&self.sessions, now) else {
            return blank("noSession", String::new());
        };
        let name = format::long_name(kind_of(candidate), &candidate.session_name, self.locale);
        if self.account.is_none() {
            return blank("noAccount", name);
        }
        // a rejected login means the stream is not running; REST bootstrap rows would be stale data
        if self.conn == Conn::Denied {
            return LiveView { message: Some("denied".into()), ..blank("error", name) };
        }
        if let Some(live) = self.live.as_ref().filter(|l| l.session_key == candidate.session_key && l.has_positions()) {
            return live.view(&name);
        }
        match &self.conn {
            Conn::Reconnecting(why) => LiveView { message: Some(why.clone()), ..blank("error", name) },
            _ => blank("connecting", name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn drivers() -> Drivers {
        [(1, "VER", "3671C6"), (4, "NOR", "FF8000"), (16, "LEC", "")]
            .into_iter()
            .map(|(n, acr, colour)| {
                (n, Driver {
                    driver_number: n,
                    name_acronym: acr.into(),
                    full_name: format!("Driver {acr}"),
                    team_name: "Team".into(),
                    team_colour: (!colour.is_empty()).then(|| colour.to_string()),
                })
            })
            .collect()
    }

    fn session(key: i64, meeting: i64, name: &str, start: &str, end: &str) -> Session {
        Session {
            session_key: key,
            session_name: name.into(),
            meeting_key: meeting,
            date_start: at(start),
            date_end: at(end),
            location: "Marina Bay".into(),
            country_name: "Singapore".into(),
            is_cancelled: false,
        }
    }

    fn weekend() -> Vec<Session> {
        vec![
            session(1, 10, "Practice 1", "2026-10-09T08:30:00Z", "2026-10-09T09:30:00Z"),
            session(4, 10, "Qualifying", "2026-10-10T13:00:00Z", "2026-10-10T14:00:00Z"),
            session(5, 10, "Race", "2026-10-11T12:00:00Z", "2026-10-11T14:00:00Z"),
            session(6, 9, "Race", "2026-10-04T07:00:00Z", "2026-10-04T09:00:00Z"),
        ]
    }

    #[test]
    fn driver_cells_fall_back_for_unknown_numbers_and_missing_colours() {
        let d = drivers();
        assert_eq!(driver_cell(&d, 1).color, "#3671C6");
        assert_eq!(driver_cell(&d, 16).color, "#888888");
        assert_eq!(driver_cell(&d, 77).acronym, "#77");
    }

    #[test]
    fn results_put_classified_drivers_first_and_flag_retirements() {
        let rows = vec![
            ResultRow { position: None, driver_number: 16, points: None, dnf: true, dns: false, dsq: false, gap_to_leader: json!(null) },
            ResultRow { position: Some(2), driver_number: 4, points: Some(18.0), dnf: false, dns: false, dsq: false, gap_to_leader: json!(2.307) },
            ResultRow { position: Some(1), driver_number: 1, points: Some(25.0), dnf: false, dns: false, dsq: false, gap_to_leader: json!(0) },
        ];
        let v = build_result_view("GP", "Race", &rows, &drivers());
        let order: Vec<_> = v.rows.iter().map(|r| r.driver.acronym.as_str()).collect();
        assert_eq!(order, ["VER", "NOR", "LEC"]);
        assert_eq!(v.rows[0].gap, None, "the winner has no gap");
        assert_eq!(v.rows[1].gap.as_deref(), Some("+2.3"));
        assert_eq!(v.rows[2].note, "DNF");
    }

    #[test]
    fn the_grid_only_uses_the_qualifying_session() {
        let rows = vec![
            GridRow { position: 1, driver_number: 4, lap_duration: Some(90.1), session_key: 4 },
            GridRow { position: 2, driver_number: 1, lap_duration: Some(90.3), session_key: 4 },
            GridRow { position: 1, driver_number: 1, lap_duration: Some(88.0), session_key: 2 }, // sprint qualifying
        ];
        let v = build_grid_view("GP", &rows, 4, &drivers());
        assert_eq!(v.rows.iter().map(|r| r.driver.acronym.as_str()).collect::<Vec<_>>(), ["NOR", "VER"]);
    }

    #[test]
    fn standings_sort_by_position() {
        let rows = vec![
            ChampionshipDriver { driver_number: 4, position_current: Some(2), points_current: Some(200.0) },
            ChampionshipDriver { driver_number: 1, position_current: Some(1), points_current: Some(250.0) },
            ChampionshipDriver { driver_number: 16, position_current: None, points_current: None },
        ];
        let teams = vec![ChampionshipTeam { team_name: "B".into(), position_current: Some(2), points_current: Some(1.0) }];
        let v = build_standings_view(&rows, &teams, &drivers());
        assert_eq!(v.drivers.iter().map(|s| s.driver.acronym.as_str()).collect::<Vec<_>>(), ["VER", "NOR"]);
        assert_eq!(v.teams.len(), 1);
    }

    #[test]
    fn plans_the_last_race_and_the_grid_only_after_qualifying() {
        let s = weekend();
        // between weekends: results of the last race, no grid yet
        let plan = plan_details(&s, at("2026-10-05T12:00:00Z"));
        assert_eq!(plan, DetailsPlan { last_race: Some((6, 9)), grid: None });
        // after qualifying, before the race: the grid of this weekend
        let plan = plan_details(&s, at("2026-10-10T15:00:00Z"));
        assert_eq!(plan.grid, Some((10, 4)));
        // once the race is over there is no upcoming grid any more
        let plan = plan_details(&s, at("2026-10-12T00:00:00Z"));
        assert_eq!(plan.grid, None);
        assert_eq!(plan.last_race, Some((5, 10)));
    }

    #[test]
    fn snapshot_shows_the_next_session_and_its_weekend() {
        let store = Store { sessions: weekend(), locale: Locale::En, ..Default::default() };
        let snap = store.snapshot(at("2026-10-05T12:00:00Z"));
        assert_eq!(snap.next.as_ref().unwrap().name, "Practice 1");
        assert_eq!(snap.next.as_ref().unwrap().status, "upcoming");
        assert_eq!(snap.weekend.len(), 3);
        assert_eq!(snap.live.status, "noSession");
        assert!(snap.meeting.unwrap().country.contains("Singapore"));
    }

    #[test]
    fn snapshot_localises_session_names() {
        let store = Store { sessions: weekend(), locale: Locale::Ru, ..Default::default() };
        let snap = store.snapshot(at("2026-10-05T12:00:00Z"));
        assert_eq!(snap.next.unwrap().name, "Практика 1");
        assert_eq!(snap.locale, "ru");
    }

    #[test]
    fn live_status_follows_account_session_and_connection() {
        let now = at("2026-10-11T12:30:00Z"); // the race is on track
        let mut store = Store { sessions: weekend(), ..Default::default() };

        assert_eq!(store.snapshot(now).live.status, "noAccount");

        store.account = Some("me".into());
        assert_eq!(store.snapshot(now).live.status, "connecting");

        store.conn = Conn::Reconnecting("timeout".into());
        let v = store.snapshot(now).live;
        assert_eq!((v.status.as_str(), v.message.as_deref()), ("error", Some("timeout")));

        store.conn = Conn::Denied;
        assert_eq!(store.snapshot(now).live.message.as_deref(), Some("denied"));
        // ...even when rows from the REST bootstrap exist: they would be stale
        let mut stale = LiveState::new(5);
        stale.apply_row("position", &json!({ "driver_number": 1, "position": 1 }));
        store.live = Some(stale);
        assert_eq!(store.snapshot(now).live.status, "error");
        store.live = None;

        let mut live = LiveState::new(5);
        live.apply_row("position", &json!({ "driver_number": 1, "position": 1 }));
        store.live = Some(live);
        store.conn = Conn::Connected;
        let v = store.snapshot(now).live;
        assert_eq!((v.status.as_str(), v.rows.len(), v.session.as_str()), ("live", 1, "Race"));

        // data from a different session is not shown
        store.live = Some(LiveState::new(99));
        assert_eq!(store.snapshot(now).live.status, "connecting");
    }

    #[test]
    fn an_in_progress_session_is_reported_as_such() {
        let store = Store { sessions: weekend(), ..Default::default() };
        let snap = store.snapshot(at("2026-10-11T12:30:00Z"));
        assert_eq!(snap.next.unwrap().status, "inProgress");
    }
}
