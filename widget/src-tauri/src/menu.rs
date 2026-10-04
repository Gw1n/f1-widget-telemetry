//! The native tray menu and the menu-bar title, as plain data (so they can be tested).
//! `tray.rs` turns these entries into real menu items.

use chrono::{DateTime, FixedOffset, Utc};

use crate::format::{self, Locale, Text, tr};
use crate::model::Snapshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    /// a bold-ish, disabled heading
    Header(String),
    /// disabled informational line
    Text(String),
    Separator,
    Submenu(String, Vec<Entry>),
    Action { id: &'static str, title: String },
    Check { id: String, title: String, checked: bool },
}

const LIVE_ROWS_IN_MENU: usize = 10;
const RESULT_ROWS_IN_MENU: usize = 10;

fn status_mark(status: &str) -> &'static str {
    match status {
        "finished" => "✓ ",
        "inProgress" => "▶ ",
        _ => "    ",
    }
}

fn at(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

pub fn build_menu(s: &Snapshot, locale: Locale, offset: FixedOffset, autostart: bool) -> Vec<Entry> {
    let mut menu = Vec::new();

    // ── schedule ──
    match (&s.meeting, &s.next) {
        (Some(meeting), Some(next)) => {
            menu.push(Entry::Header(meeting.name.clone()));
            let when = format::format_local(at(next.start_ms), offset, locale);
            menu.push(Entry::Text(if next.status == "inProgress" {
                format!("{} — {}", next.name, tr(locale, Text::InProgress))
            } else {
                format!("{}: {} — {}", tr(locale, Text::NextLabel), next.name, when)
            }));
            if s.weekend.len() > 1 {
                menu.push(Entry::Separator);
                menu.push(Entry::Text(tr(locale, Text::Weekend).to_string()));
                for session in &s.weekend {
                    menu.push(Entry::Text(format!(
                        "{}{} — {}",
                        status_mark(&session.status),
                        session.name,
                        format::format_local(at(session.start_ms), offset, locale)
                    )));
                }
            }
        }
        _ => menu.push(Entry::Text(tr(locale, Text::NoData).to_string())),
    }

    // ── live order ──
    match s.live.status.as_str() {
        "live" if !s.live.rows.is_empty() => {
            menu.push(Entry::Separator);
            let mut title = format!("{} — {}", tr(locale, Text::LiveOrder), s.live.session);
            if let Some(lap) = s.live.lap {
                title.push_str(&format!(" · {}{}", tr(locale, Text::LapAbbrev), lap));
            }
            let flag = format::flag_label(locale, &s.live.flag);
            if !flag.is_empty() {
                title.push_str(&format!(" · {flag}"));
            }
            let leader = locale_leader(locale);
            let rows = s.live.rows.iter().take(LIVE_ROWS_IN_MENU).map(|r| {
                let gap = if r.position == 1 { leader } else if !r.gap.is_empty() { &r.gap } else { "" };
                Entry::Text(format!("{:>2}  {}  {}", r.position, r.driver.acronym, gap).trim_end().to_string())
            });
            menu.push(Entry::Submenu(title, rows.collect()));
        }
        "noAccount" => {
            menu.push(Entry::Separator);
            menu.push(Entry::Action { id: "account", title: tr(locale, Text::LiveNeedsAccount).to_string() });
        }
        _ => {}
    }

    // ── grid and last race ──
    if let Some(grid) = s.grid.as_ref().filter(|g| !g.rows.is_empty()) {
        menu.push(Entry::Separator);
        menu.push(Entry::Submenu(
            format!("{} — {}", tr(locale, Text::StartingGrid), grid.meeting),
            grid.rows
                .iter()
                .map(|r| Entry::Text(format!("{:>2}  {}  {}", r.position, r.driver.acronym, r.driver.name)))
                .collect(),
        ));
    }
    if let Some(result) = s.last_race.as_ref().filter(|r| !r.rows.is_empty()) {
        menu.push(Entry::Submenu(
            format!("{} — {}", tr(locale, Text::LastRace), result.meeting),
            result
                .rows
                .iter()
                .take(RESULT_ROWS_IN_MENU)
                .map(|r| {
                    let pos = r.position.map_or("–".to_string(), |p| p.to_string());
                    Entry::Text(format!("{:>2}  {}  {}", pos, r.driver.acronym, r.driver.name))
                })
                .collect(),
        ));
    }

    // ── app ──
    menu.push(Entry::Separator);
    menu.push(Entry::Action { id: "open", title: tr(locale, Text::OpenWidget).to_string() });
    menu.push(Entry::Action { id: "account", title: tr(locale, Text::Account).to_string() });
    menu.push(Entry::Action { id: "refresh", title: tr(locale, Text::Refresh).to_string() });
    menu.push(Entry::Separator);
    menu.push(Entry::Submenu(
        tr(locale, Text::Language).to_string(),
        vec![
            Entry::Check { id: "lang:en".into(), title: "English".into(), checked: locale == Locale::En },
            Entry::Check { id: "lang:ru".into(), title: "Русский".into(), checked: locale == Locale::Ru },
        ],
    ));
    menu.push(Entry::Check { id: "autostart".into(), title: tr(locale, Text::LaunchAtLogin).to_string(), checked: autostart });
    menu.push(Entry::Separator);
    menu.push(Entry::Action { id: "quit", title: tr(locale, Text::Quit).to_string() });
    menu
}

fn locale_leader(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "Leader",
        Locale::Ru => "Лидер",
    }
}

/// The text next to the icon in the menu bar (Windows shows it as the tooltip).
pub fn tray_title(s: &Snapshot, locale: Locale) -> String {
    if s.live.status == "live" && !s.live.rows.is_empty() {
        let leader = &s.live.rows[0].driver.acronym;
        return match s.live.lap {
            Some(lap) => format!("{}{} · {}", tr(locale, Text::LapAbbrev), lap, leader),
            None => format!("LIVE · {leader}"),
        };
    }
    let Some(next) = &s.next else { return "F1".into() };
    if next.status == "inProgress" {
        return format!("{} · LIVE", next.short);
    }
    let secs = (next.start_ms - s.now_ms) / 1000;
    format!("{} {}", next.short, format::format_countdown(secs, locale))
}

pub fn tray_tooltip(s: &Snapshot, locale: Locale, offset: FixedOffset) -> String {
    let Some(next) = &s.next else { return "F1 Widget".into() };
    let name = s.meeting.as_ref().map(|m| m.name.as_str()).unwrap_or("");
    let when = format::format_local(at(next.start_ms), offset, locale);
    format!("{name}\n{} — {when}", next.name)
}

/// A string that changes exactly when the menu's content changes.
pub fn signature(entries: &[Entry]) -> String {
    format!("{entries:?}")
}

/// Convenience for tests and the debug output.
pub fn flatten(entries: &[Entry]) -> Vec<String> {
    fn walk(entries: &[Entry], depth: usize, out: &mut Vec<String>) {
        for e in entries {
            let pad = "  ".repeat(depth);
            match e {
                Entry::Header(t) | Entry::Text(t) => out.push(format!("{pad}{t}")),
                Entry::Separator => out.push(format!("{pad}---")),
                Entry::Action { title, .. } => out.push(format!("{pad}[{title}]")),
                Entry::Check { title, checked, .. } => out.push(format!("{pad}({}) {title}", if *checked { "x" } else { " " })),
                Entry::Submenu(title, items) => {
                    out.push(format!("{pad}{title} >"));
                    walk(items, depth + 1, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(entries, 0, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn offset() -> FixedOffset {
        FixedOffset::east_opt(3 * 3600).unwrap() // Moscow
    }

    fn cell(n: i64, acr: &str, name: &str) -> DriverCell {
        DriverCell { number: n, acronym: acr.into(), name: name.into(), team: "T".into(), color: "#fff".into() }
    }

    fn session(name: &str, short: &str, start: &str, status: &str) -> SessionView {
        let t = start.parse::<DateTime<Utc>>().unwrap().timestamp_millis();
        SessionView { name: name.into(), short: short.into(), start_ms: t, end_ms: t + 3_600_000, status: status.into() }
    }

    fn snapshot() -> Snapshot {
        let weekend = vec![
            session("Practice 1", "FP1", "2026-10-09T08:30:00Z", "finished"),
            session("Qualifying", "Quali", "2026-10-10T13:00:00Z", "upcoming"),
            session("Race", "Race", "2026-10-11T12:00:00Z", "upcoming"),
        ];
        Snapshot {
            locale: "en".into(),
            now_ms: "2026-10-09T10:00:00Z".parse::<DateTime<Utc>>().unwrap().timestamp_millis(),
            meeting: Some(MeetingView { name: "Singapore Grand Prix".into(), location: "Marina Bay".into(), country: "Singapore".into() }),
            next: Some(weekend[1].clone()),
            weekend,
            live: LiveView { status: "noSession".into(), flag: "GREEN".into(), ..Default::default() },
            ..Default::default()
        }
    }

    #[test]
    fn title_counts_down_to_the_next_session() {
        let s = snapshot();
        // 2026-10-09 10:00 -> 2026-10-10 13:00 is 1 day 3 hours
        assert_eq!(tray_title(&s, Locale::En), "Quali 1d 3h");
        assert_eq!(tray_title(&s, Locale::Ru), "Quali 1д 3ч");
    }

    #[test]
    fn title_says_live_while_a_session_is_on_track() {
        let mut s = snapshot();
        s.next.as_mut().unwrap().status = "inProgress".into();
        assert_eq!(tray_title(&s, Locale::En), "Quali · LIVE");
    }

    #[test]
    fn title_shows_lap_and_leader_when_live_data_flows() {
        let mut s = snapshot();
        s.live = LiveView {
            status: "live".into(),
            lap: Some(12),
            rows: vec![LiveRow { position: 1, driver: cell(1, "VER", "Max"), ..Default::default() }],
            flag: "GREEN".into(),
            ..Default::default()
        };
        assert_eq!(tray_title(&s, Locale::En), "L12 · VER");
        assert_eq!(tray_title(&s, Locale::Ru), "К12 · VER");
    }

    #[test]
    fn title_without_a_schedule_is_just_the_brand() {
        assert_eq!(tray_title(&Snapshot::default(), Locale::En), "F1");
    }

    #[test]
    fn menu_lists_the_weekend_in_local_time_with_status_marks() {
        let lines = flatten(&build_menu(&snapshot(), Locale::En, offset(), false));
        assert_eq!(lines[0], "Singapore Grand Prix");
        assert_eq!(lines[1], "Next: Qualifying — Sat 10 Oct, 16:00");
        assert!(lines.contains(&"✓ Practice 1 — Fri 9 Oct, 11:30".to_string()));
        assert!(lines.contains(&"    Race — Sun 11 Oct, 15:00".to_string()));
    }

    #[test]
    fn menu_has_the_app_controls_with_checked_language() {
        let lines = flatten(&build_menu(&snapshot(), Locale::Ru, offset(), true));
        assert!(lines.contains(&"[Открыть виджет]".to_string()));
        assert!(lines.contains(&"  (x) Русский".to_string()));
        assert!(lines.contains(&"  ( ) English".to_string()));
        assert!(lines.contains(&"(x) Запускать при входе".to_string()));
        assert_eq!(lines.last().unwrap(), "[Выйти]");
    }

    #[test]
    fn menu_without_data_says_so() {
        let lines = flatten(&build_menu(&Snapshot::default(), Locale::En, offset(), false));
        assert_eq!(lines[0], "No schedule data yet");
    }

    #[test]
    fn menu_offers_sign_in_when_a_session_is_live_without_an_account() {
        let mut s = snapshot();
        s.live = LiveView { status: "noAccount".into(), flag: "GREEN".into(), ..Default::default() };
        let menu = build_menu(&s, Locale::En, offset(), false);
        assert!(menu.contains(&Entry::Action { id: "account", title: "Sign in for live positions".into() }));
    }

    #[test]
    fn live_order_shows_gaps_flag_and_lap_in_a_submenu() {
        let mut s = snapshot();
        s.live = LiveView {
            status: "live".into(),
            session: "Race".into(),
            lap: Some(7),
            flag: "SC".into(),
            rows: vec![
                LiveRow { position: 1, driver: cell(1, "VER", "Max"), ..Default::default() },
                LiveRow { position: 2, driver: cell(4, "NOR", "Lando"), gap: "+2.1".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let lines = flatten(&build_menu(&s, Locale::En, offset(), false));
        assert!(lines.contains(&"Live order — Race · L7 · Safety car >".to_string()));
        assert!(lines.contains(&"   1  VER  Leader".to_string()));
        assert!(lines.contains(&"   2  NOR  +2.1".to_string()));
    }

    #[test]
    fn live_order_in_the_menu_is_capped_at_ten_rows() {
        let mut s = snapshot();
        s.live = LiveView {
            status: "live".into(),
            flag: "GREEN".into(),
            rows: (1..=20).map(|p| LiveRow { position: p, driver: cell(p, &format!("D{p:02}"), ""), ..Default::default() }).collect(),
            ..Default::default()
        };
        let menu = build_menu(&s, Locale::En, offset(), false);
        let sub = menu.iter().find_map(|e| match e { Entry::Submenu(t, items) if t.starts_with("Live order") => Some(items.len()), _ => None });
        assert_eq!(sub, Some(10));
    }

    #[test]
    fn grid_and_last_race_appear_as_submenus() {
        let mut s = snapshot();
        s.grid = Some(GridView { meeting: "Singapore GP".into(), rows: vec![GridEntry { position: 1, driver: cell(4, "NOR", "Lando Norris"), lap_time: Some(90.1) }] });
        s.last_race = Some(ResultView {
            meeting: "Bahrain GP".into(),
            session: "Race".into(),
            rows: vec![ResultEntry { position: Some(1), driver: cell(12, "ANT", "Kimi Antonelli"), ..Default::default() }],
        });
        let lines = flatten(&build_menu(&s, Locale::En, offset(), false));
        assert!(lines.contains(&"Starting grid — Singapore GP >".to_string()));
        assert!(lines.contains(&"   1  NOR  Lando Norris".to_string()));
        assert!(lines.contains(&"Last race — Bahrain GP >".to_string()));
        assert!(lines.contains(&"   1  ANT  Kimi Antonelli".to_string()));
    }

    #[test]
    fn signature_changes_only_with_content() {
        let a = build_menu(&snapshot(), Locale::En, offset(), false);
        let b = build_menu(&snapshot(), Locale::En, offset(), false);
        assert_eq!(signature(&a), signature(&b));
        let c = build_menu(&snapshot(), Locale::En, offset(), true);
        assert_ne!(signature(&a), signature(&c));
    }
}
