//! Text for the tray and the native menu: two languages, local-time formatting, countdowns.
//! (The widget window formats its own text in JavaScript.)

use chrono::{DateTime, Datelike, FixedOffset, Timelike, Utc};

use crate::schedule::Kind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    En,
    Ru,
}

impl Locale {
    pub fn from_code(code: &str) -> Locale {
        match code {
            "ru" => Locale::Ru,
            _ => Locale::En,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::Ru => "ru",
        }
    }
}

const WEEKDAYS_EN: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_RU: [&str; 7] = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTHS_EN: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_RU: [&str; 12] = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/// The UTC offset the user's machine has at that moment.
pub fn local_offset(at: DateTime<Utc>) -> FixedOffset {
    *at.with_timezone(&chrono::Local).offset()
}

/// "Sun 11 Oct, 15:00" / "вс 11 окт, 15:00" in the given offset.
pub fn format_local(at: DateTime<Utc>, offset: FixedOffset, locale: Locale) -> String {
    let t = at.with_timezone(&offset);
    let (days, months) = match locale {
        Locale::En => (&WEEKDAYS_EN, &MONTHS_EN),
        Locale::Ru => (&WEEKDAYS_RU, &MONTHS_RU),
    };
    format!(
        "{} {} {}, {:02}:{:02}",
        days[t.weekday().num_days_from_monday() as usize],
        t.day(),
        months[t.month0() as usize],
        t.hour(),
        t.minute()
    )
}

/// "3d 4h", "4h 12m", "12m", "<1m". Never negative.
pub fn format_countdown(secs: i64, locale: Locale) -> String {
    let secs = secs.max(0);
    let (d, h, m) = (secs / 86_400, secs % 86_400 / 3_600, secs % 3_600 / 60);
    let (du, hu, mu) = match locale {
        Locale::En => ("d", "h", "m"),
        Locale::Ru => ("д", "ч", "м"),
    };
    if d > 0 {
        format!("{d}{du} {h}{hu}")
    } else if h > 0 {
        format!("{h}{hu} {m}{mu}")
    } else if m > 0 {
        format!("{m}{mu}")
    } else {
        format!("<1{mu}")
    }
}

/// Compact name for the menu-bar title.
pub fn short_name(kind: Kind, fallback: &str, locale: Locale) -> String {
    match (kind, locale) {
        (Kind::Practice(n), _) => format!("FP{n}"),
        (Kind::SprintQualifying, _) => "SQ".into(),
        (Kind::Sprint, Locale::En) => "Sprint".into(),
        (Kind::Sprint, Locale::Ru) => "Спринт".into(),
        (Kind::Qualifying, Locale::En) => "Quali".into(),
        (Kind::Qualifying, Locale::Ru) => "Квал.".into(),
        (Kind::Race, Locale::En) => "Race".into(),
        (Kind::Race, Locale::Ru) => "Гонка".into(),
        (Kind::Other, _) => fallback.to_string(),
    }
}

/// Full session name.
pub fn long_name(kind: Kind, fallback: &str, locale: Locale) -> String {
    match (kind, locale) {
        (Kind::Practice(n), Locale::En) => format!("Practice {n}"),
        (Kind::Practice(n), Locale::Ru) => format!("Практика {n}"),
        (Kind::SprintQualifying, Locale::En) => "Sprint Qualifying".into(),
        (Kind::SprintQualifying, Locale::Ru) => "Спринт-квалификация".into(),
        (Kind::Sprint, Locale::En) => "Sprint".into(),
        (Kind::Sprint, Locale::Ru) => "Спринт".into(),
        (Kind::Qualifying, Locale::En) => "Qualifying".into(),
        (Kind::Qualifying, Locale::Ru) => "Квалификация".into(),
        (Kind::Race, Locale::En) => "Race".into(),
        (Kind::Race, Locale::Ru) => "Гонка".into(),
        (Kind::Other, _) => fallback.to_string(),
    }
}

/// Track status as shown next to the live order.
pub fn flag_label(locale: Locale, code: &str) -> &'static str {
    match (locale, code) {
        (Locale::En, "YELLOW") => "Yellow flag",
        (Locale::Ru, "YELLOW") => "Жёлтый флаг",
        (Locale::En, "RED") => "Red flag",
        (Locale::Ru, "RED") => "Красный флаг",
        (Locale::En, "SC") => "Safety car",
        (Locale::Ru, "SC") => "Сейфти-кар",
        (Locale::En, "VSC") => "Virtual SC",
        (Locale::Ru, "VSC") => "Виртуальный SC",
        (Locale::En, "SC_END") => "SC ending",
        (Locale::Ru, "SC_END") => "SC заканчивает",
        (Locale::En, "CHEQUERED") => "Finished",
        (Locale::Ru, "CHEQUERED") => "Финиш",
        _ => "",
    }
}

/// Strings of the native menu.
#[derive(Debug, Clone, Copy)]
pub enum Text {
    OpenWidget,
    Account,
    Refresh,
    Language,
    LaunchAtLogin,
    Quit,
    NextLabel,
    InProgress,
    Weekend,
    StartingGrid,
    LiveOrder,
    LiveNeedsAccount,
    LastRace,
    NoData,
    LapAbbrev,
}

pub fn tr(locale: Locale, text: Text) -> &'static str {
    match (locale, text) {
        (Locale::En, Text::OpenWidget) => "Open widget",
        (Locale::Ru, Text::OpenWidget) => "Открыть виджет",
        (Locale::En, Text::Account) => "Account…",
        (Locale::Ru, Text::Account) => "Аккаунт…",
        (Locale::En, Text::Refresh) => "Refresh",
        (Locale::Ru, Text::Refresh) => "Обновить",
        (Locale::En, Text::Language) => "Language",
        (Locale::Ru, Text::Language) => "Язык",
        (Locale::En, Text::LaunchAtLogin) => "Launch at login",
        (Locale::Ru, Text::LaunchAtLogin) => "Запускать при входе",
        (Locale::En, Text::Quit) => "Quit",
        (Locale::Ru, Text::Quit) => "Выйти",
        (Locale::En, Text::NextLabel) => "Next",
        (Locale::Ru, Text::NextLabel) => "Далее",
        (Locale::En, Text::InProgress) => "on track now",
        (Locale::Ru, Text::InProgress) => "идёт сейчас",
        (Locale::En, Text::Weekend) => "Weekend",
        (Locale::Ru, Text::Weekend) => "Уикенд",
        (Locale::En, Text::StartingGrid) => "Starting grid",
        (Locale::Ru, Text::StartingGrid) => "Стартовая решётка",
        (Locale::En, Text::LiveOrder) => "Live order",
        (Locale::Ru, Text::LiveOrder) => "Позиции в реальном времени",
        (Locale::En, Text::LiveNeedsAccount) => "Sign in for live positions",
        (Locale::Ru, Text::LiveNeedsAccount) => "Войди, чтобы видеть позиции",
        (Locale::En, Text::LastRace) => "Last race",
        (Locale::Ru, Text::LastRace) => "Прошлая гонка",
        (Locale::En, Text::NoData) => "No schedule data yet",
        (Locale::Ru, Text::NoData) => "Расписание ещё не загружено",
        (Locale::En, Text::LapAbbrev) => "L",
        (Locale::Ru, Text::LapAbbrev) => "К",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn formats_in_the_users_offset_not_in_utc() {
        let t = at("2026-10-11T12:00:00Z"); // a Sunday
        let moscow = FixedOffset::east_opt(3 * 3600).unwrap();
        let new_york = FixedOffset::west_opt(4 * 3600).unwrap();
        assert_eq!(format_local(t, moscow, Locale::En), "Sun 11 Oct, 15:00");
        assert_eq!(format_local(t, new_york, Locale::En), "Sun 11 Oct, 08:00");
        assert_eq!(format_local(t, moscow, Locale::Ru), "вс 11 окт, 15:00");
    }

    #[test]
    fn the_date_can_roll_over_with_the_offset() {
        let t = at("2026-10-11T22:30:00Z");
        let sydney = FixedOffset::east_opt(11 * 3600).unwrap();
        assert_eq!(format_local(t, sydney, Locale::En), "Mon 12 Oct, 09:30");
    }

    #[test]
    fn countdown_picks_the_two_most_significant_units() {
        assert_eq!(format_countdown(3 * 86_400 + 4 * 3_600 + 59, Locale::En), "3d 4h");
        assert_eq!(format_countdown(4 * 3_600 + 12 * 60, Locale::En), "4h 12m");
        assert_eq!(format_countdown(12 * 60 + 5, Locale::En), "12m");
        assert_eq!(format_countdown(40, Locale::En), "<1m");
        assert_eq!(format_countdown(-500, Locale::En), "<1m");
        assert_eq!(format_countdown(2 * 86_400 + 3_600, Locale::Ru), "2д 1ч");
    }

    #[test]
    fn locale_codes_round_trip_and_default_to_english() {
        assert_eq!(Locale::from_code("ru"), Locale::Ru);
        assert_eq!(Locale::from_code("en"), Locale::En);
        assert_eq!(Locale::from_code("fr"), Locale::En);
        assert_eq!(Locale::Ru.code(), "ru");
    }

    #[test]
    fn session_names_in_both_languages() {
        assert_eq!(short_name(Kind::Practice(1), "", Locale::En), "FP1");
        assert_eq!(short_name(Kind::Race, "", Locale::Ru), "Гонка");
        assert_eq!(long_name(Kind::SprintQualifying, "", Locale::En), "Sprint Qualifying");
        assert_eq!(long_name(Kind::Other, "Warm-up", Locale::Ru), "Warm-up");
    }
}
