//! Pure schedule logic: which session is next, which weekend it belongs to, when live data applies.

use chrono::{DateTime, Duration, Utc};

use crate::model::Session;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Practice(u8),
    SprintQualifying,
    Sprint,
    Qualifying,
    Race,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Finished,
    InProgress,
    Upcoming,
}

/// OpenF1 names: "Practice 1", "Sprint Qualifying" (older: "Sprint Shootout"), "Sprint", "Qualifying", "Race".
pub fn classify(session_name: &str) -> Kind {
    let name = session_name.trim().to_ascii_lowercase();
    if let Some(n) = name.strip_prefix("practice ") {
        return n.trim().parse().map(Kind::Practice).unwrap_or(Kind::Other);
    }
    match name.as_str() {
        "sprint qualifying" | "sprint shootout" => Kind::SprintQualifying,
        "sprint" => Kind::Sprint,
        "qualifying" => Kind::Qualifying,
        "race" => Kind::Race,
        _ => Kind::Other,
    }
}

pub fn status(session: &Session, now: DateTime<Utc>) -> Status {
    if now >= session.date_end {
        Status::Finished
    } else if now >= session.date_start {
        Status::InProgress
    } else {
        Status::Upcoming
    }
}

fn active(sessions: &[Session]) -> impl Iterator<Item = &Session> {
    sessions.iter().filter(|s| !s.is_cancelled)
}

/// The session on track right now, or else the next one to start.
pub fn next_session(sessions: &[Session], now: DateTime<Utc>) -> Option<&Session> {
    active(sessions)
        .filter(|s| s.date_end > now)
        .min_by_key(|s| s.date_start)
}

/// All sessions of a weekend in chronological order.
pub fn weekend(sessions: &[Session], meeting_key: i64) -> Vec<&Session> {
    let mut list: Vec<&Session> = active(sessions).filter(|s| s.meeting_key == meeting_key).collect();
    list.sort_by_key(|s| s.date_start);
    list
}

/// The most recently finished race (not sprint).
pub fn last_finished_race(sessions: &[Session], now: DateTime<Utc>) -> Option<&Session> {
    active(sessions)
        .filter(|s| classify(&s.session_name) == Kind::Race && s.date_end <= now)
        .max_by_key(|s| s.date_end)
}

/// The qualifying session of a weekend (it carries the starting grid in OpenF1).
pub fn qualifying_of(sessions: &[Session], meeting_key: i64) -> Option<&Session> {
    active(sessions).find(|s| s.meeting_key == meeting_key && classify(&s.session_name) == Kind::Qualifying)
}

pub fn race_of(sessions: &[Session], meeting_key: i64) -> Option<&Session> {
    active(sessions).find(|s| s.meeting_key == meeting_key && classify(&s.session_name) == Kind::Race)
}

/// A session counts as "live" slightly before its start and well after its scheduled end:
/// races overrun, and the data stream keeps going through the cool-down.
pub fn live_candidate(sessions: &[Session], now: DateTime<Utc>) -> Option<&Session> {
    let lead = Duration::minutes(15);
    let tail = Duration::minutes(30);
    active(sessions)
        .filter(|s| now >= s.date_start - lead && now <= s.date_end + tail)
        .min_by_key(|s| {
            // prefer the one actually on track, then the closest to its start
            let in_progress = now >= s.date_start && now < s.date_end;
            (!in_progress, (s.date_start - now).num_seconds().abs())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
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

    fn season() -> Vec<Session> {
        vec![
            session(1, 10, "Practice 1", "2026-10-09T08:30:00Z", "2026-10-09T09:30:00Z"),
            session(2, 10, "Sprint Qualifying", "2026-10-09T12:30:00Z", "2026-10-09T13:14:00Z"),
            session(3, 10, "Sprint", "2026-10-10T09:00:00Z", "2026-10-10T10:00:00Z"),
            session(4, 10, "Qualifying", "2026-10-10T13:00:00Z", "2026-10-10T14:00:00Z"),
            session(5, 10, "Race", "2026-10-11T12:00:00Z", "2026-10-11T14:00:00Z"),
            session(6, 9, "Race", "2026-10-04T07:00:00Z", "2026-10-04T09:00:00Z"),
        ]
    }

    #[test]
    fn classifies_session_names() {
        assert_eq!(classify("Practice 2"), Kind::Practice(2));
        assert_eq!(classify("Sprint Qualifying"), Kind::SprintQualifying);
        assert_eq!(classify("Sprint Shootout"), Kind::SprintQualifying);
        assert_eq!(classify("Sprint"), Kind::Sprint);
        assert_eq!(classify("Qualifying"), Kind::Qualifying);
        assert_eq!(classify(" race "), Kind::Race);
        assert_eq!(classify("Warm-up"), Kind::Other);
        assert_eq!(classify("Practice x"), Kind::Other);
    }

    #[test]
    fn picks_next_session_between_weekends() {
        let s = season();
        let next = next_session(&s, at("2026-10-04T12:41:00Z")).unwrap();
        assert_eq!(next.session_key, 1);
    }

    #[test]
    fn a_running_session_is_still_the_next_one() {
        let s = season();
        let next = next_session(&s, at("2026-10-10T09:30:00Z")).unwrap();
        assert_eq!(next.session_key, 3);
        assert_eq!(status(next, at("2026-10-10T09:30:00Z")), Status::InProgress);
    }

    #[test]
    fn no_next_session_after_the_last_one() {
        assert!(next_session(&season(), at("2026-12-01T00:00:00Z")).is_none());
    }

    #[test]
    fn cancelled_sessions_are_ignored() {
        let mut s = season();
        s[0].is_cancelled = true;
        assert_eq!(next_session(&s, at("2026-10-04T12:41:00Z")).unwrap().session_key, 2);
    }

    #[test]
    fn weekend_is_sorted_and_scoped() {
        let s = season();
        let keys: Vec<i64> = weekend(&s, 10).iter().map(|x| x.session_key).collect();
        assert_eq!(keys, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn finds_last_finished_race_and_qualifying() {
        let s = season();
        assert_eq!(last_finished_race(&s, at("2026-10-04T12:41:00Z")).unwrap().session_key, 6);
        // the sprint never counts as the race
        assert_eq!(last_finished_race(&s, at("2026-10-10T11:00:00Z")).unwrap().session_key, 6);
        assert_eq!(qualifying_of(&s, 10).unwrap().session_key, 4);
        assert_eq!(race_of(&s, 10).unwrap().session_key, 5);
    }

    #[test]
    fn live_window_covers_lead_in_and_overrun() {
        let s = season();
        assert!(live_candidate(&s, at("2026-10-09T08:15:00Z")).is_some(), "exactly 15 min before FP1");
        assert!(live_candidate(&s, at("2026-10-09T08:20:00Z")).is_some(), "10 min before FP1");
        assert!(live_candidate(&s, at("2026-10-09T08:10:00Z")).is_none(), "20 min before is too early");
        assert_eq!(live_candidate(&s, at("2026-10-11T14:20:00Z")).unwrap().session_key, 5, "race overrun");
        assert!(live_candidate(&s, at("2026-10-11T14:45:00Z")).is_none(), "well after the end");
    }

    #[test]
    fn live_candidate_prefers_the_session_on_track() {
        let s = vec![
            session(1, 1, "Sprint Qualifying", "2026-10-09T12:30:00Z", "2026-10-09T13:14:00Z"),
            session(2, 1, "Practice 2", "2026-10-09T13:20:00Z", "2026-10-09T14:20:00Z"),
        ];
        // 13:10: SQ is on track, FP2 is within its 15 min lead-in
        assert_eq!(live_candidate(&s, at("2026-10-09T13:10:00Z")).unwrap().session_key, 1);
        // 13:16: SQ ended 2 min ago, FP2 starts in 4 min: neither is "on track"; closest start wins
        assert_eq!(live_candidate(&s, at("2026-10-09T13:16:00Z")).unwrap().session_key, 2);
    }
}
