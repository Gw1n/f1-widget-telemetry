//! The widget's brain: keeps the schedule, grid, results and live order up to date and tells
//! the UI when something changed. Knows nothing about windows or the tray.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Utc};
use tokio::sync::{mpsc, watch};

use crate::api::{Api, LoginError};
use crate::format::Locale;
use crate::live::{self, LiveEvent, LiveState, MqttConfig};
use crate::model::Snapshot;
use crate::schedule;
use crate::settings::{Settings, secrets};
use crate::view::{self, Conn, DetailsPlan, Drivers, Store};

// Refresh deadlines are wall-clock times, not `Instant`s: on macOS the monotonic clock stands
// still while the machine sleeps, so after a night asleep nothing would look overdue.
fn minutes(n: i64) -> ChronoDuration {
    ChronoDuration::minutes(n)
}
/// Don't push UI updates faster than this, however fast live rows arrive.
const MIN_NOTIFY_GAP: Duration = Duration::from_millis(1500);
/// The countdown in the menu bar changes by the minute; refresh it at least this often.
const HEARTBEAT: Duration = Duration::from_secs(20);

#[derive(Default)]
struct Timers {
    schedule_due: Option<DateTime<Utc>>,
    details_due: Option<DateTime<Utc>>,
    details_plan: DetailsPlan,
    last_notify: Option<Instant>,
}

struct LiveControl {
    session_key: i64,
    stop: watch::Sender<bool>,
}

pub struct Hub {
    pub api: Arc<Api>,
    store: Mutex<Store>,
    config_dir: PathBuf,
    timers: Mutex<Timers>,
    live: Mutex<Option<LiveControl>>,
    dirty: AtomicBool,
    schedule_busy: AtomicBool,
    details_busy: AtomicBool,
    mqtt: MqttConfig,
}

fn iso(at: DateTime<Utc>) -> String {
    // OpenF1 takes UTC timestamps without the zone suffix
    at.format("%Y-%m-%dT%H:%M:%S").to_string()
}

impl Hub {
    pub fn new(config_dir: PathBuf) -> Arc<Hub> {
        let settings = Settings::load(&config_dir);
        let store = Store { locale: Locale::from_code(&settings.locale), ..Default::default() };
        Arc::new(Hub {
            api: Arc::new(match std::env::var("F1W_API_BASE") {
                Ok(base) => Api::with_base(&base),
                Err(_) => Api::new(),
            }),
            store: Mutex::new(store),
            config_dir,
            timers: Mutex::new(Timers::default()),
            live: Mutex::new(None),
            dirty: AtomicBool::new(true),
            schedule_busy: AtomicBool::new(false),
            details_busy: AtomicBool::new(false),
            mqtt: MqttConfig::from_env(),
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        self.store.lock().unwrap().snapshot(Utc::now())
    }

    pub fn locale(&self) -> Locale {
        self.store.lock().unwrap().locale
    }

    /// Something visible changed; the UI is refreshed on the next tick of the loop.
    fn changed(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    // ── user actions ────────────────────────────────────────────────

    pub fn set_locale(&self, code: &str) {
        let locale = Locale::from_code(code);
        self.store.lock().unwrap().locale = locale;
        if let Err(e) = (Settings { locale: locale.code().into() }).save(&self.config_dir) {
            eprintln!("settings not saved: {e}");
        }
        self.changed();
    }

    pub async fn login(self: &Arc<Self>, username: &str, password: &str, remember: bool) -> Result<(), String> {
        match self.api.login(username, password).await {
            Ok(()) => {}
            Err(LoginError::BadCredentials) => return Err("bad_credentials".into()),
            Err(LoginError::Failed(msg)) => return Err(msg),
        }
        if remember {
            if let Err(e) = secrets::save(username, password) {
                eprintln!("credentials not stored: {e}");
            }
        } else {
            secrets::clear();
        }
        self.store.lock().unwrap().account = Some(username.to_string());
        self.changed();
        self.ensure_live();
        Ok(())
    }

    pub async fn logout(self: &Arc<Self>) {
        self.api.logout().await;
        secrets::clear();
        self.store.lock().unwrap().account = None;
        self.stop_live();
        self.changed();
    }

    /// Re-fetch everything on the next tick.
    pub fn refresh(&self) {
        let mut t = self.timers.lock().unwrap();
        t.schedule_due = None;
        t.details_due = None;
    }

    /// `F1W_AUTOLOGIN=user:pass`, honoured only together with `F1W_API_BASE` (a test server).
    async fn test_login(&self) {
        let Ok(creds) = std::env::var("F1W_AUTOLOGIN") else { return };
        let Some((user, pass)) = creds.split_once(':') else { return };
        if self.api.login(user, pass).await.is_ok() {
            self.store.lock().unwrap().account = Some(user.to_string());
            self.changed();
        }
    }

    async fn restore_credentials(&self) {
        if let Some((username, password)) = secrets::load() {
            self.api.set_credentials(username.clone(), password).await;
            self.store.lock().unwrap().account = Some(username);
            self.changed();
        }
    }

    // ── the loop ────────────────────────────────────────────────────

    /// Runs forever; `notify` is called when the UI should redraw.
    pub async fn run(self: Arc<Self>, notify: impl Fn() + Send + Sync + 'static) {
        if std::env::var_os("F1W_API_BASE").is_some() {
            // Test mode against a stand-in server: never send the real saved password there.
            self.test_login().await;
        } else {
            self.restore_credentials().await;
        }
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            self.periodic();

            let due = {
                let mut t = self.timers.lock().unwrap();
                let since = t.last_notify.map(|at| at.elapsed());
                let heartbeat = since.is_none_or(|s| s >= HEARTBEAT);
                let pending = self.dirty.load(Ordering::Relaxed) && since.is_none_or(|s| s >= MIN_NOTIFY_GAP);
                if heartbeat || pending {
                    t.last_notify = Some(Instant::now());
                    true
                } else {
                    false
                }
            };
            if due {
                self.dirty.store(false, Ordering::Relaxed);
                notify();
            }
        }
    }

    fn periodic(self: &Arc<Self>) {
        let now = Utc::now();

        let schedule_due = self.timers.lock().unwrap().schedule_due.is_none_or(|at| now >= at);
        if schedule_due && !self.schedule_busy.swap(true, Ordering::AcqRel) {
            let hub = self.clone();
            tokio::spawn(async move {
                hub.refresh_schedule().await;
                hub.schedule_busy.store(false, Ordering::Release);
            });
        }

        // details depend on the schedule, so wait until there is one
        let have_sessions = !self.store.lock().unwrap().sessions.is_empty();
        if have_sessions {
            let plan = view::plan_details(&self.store.lock().unwrap().sessions, Utc::now());
            let (plan_changed, due) = {
                let t = self.timers.lock().unwrap();
                (plan != t.details_plan, t.details_due.is_none_or(|at| now >= at))
            };
            if (plan_changed || due) && !self.details_busy.swap(true, Ordering::AcqRel) {
                let hub = self.clone();
                tokio::spawn(async move {
                    hub.refresh_details(plan).await;
                    hub.details_busy.store(false, Ordering::Release);
                });
            }
        }

        self.ensure_live();
    }

    // ── schedule ────────────────────────────────────────────────────

    async fn refresh_schedule(&self) {
        let year = chrono::Local::now().year();
        let result: Result<()> = async {
            let mut sessions = self.api.sessions(year).await?;
            let mut meetings = self.api.meetings(year).await?;
            // late in the season the next year's calendar may already exist
            if schedule::next_session(&sessions, Utc::now()).is_none() {
                sessions.extend(self.api.sessions(year + 1).await.unwrap_or_default());
                meetings.extend(self.api.meetings(year + 1).await.unwrap_or_default());
            }
            let mut store = self.store.lock().unwrap();
            store.sessions = sessions;
            store.meetings = meetings.into_iter().map(|m| (m.meeting_key, m)).collect();
            store.error = None;
            Ok(())
        }
        .await;

        let mut t = self.timers.lock().unwrap();
        match result {
            Ok(()) => t.schedule_due = Some(Utc::now() + minutes(30)),
            Err(e) => {
                self.store.lock().unwrap().error = Some(e.to_string());
                t.schedule_due = Some(Utc::now() + minutes(1));
            }
        }
        drop(t);
        self.changed();
    }

    // ── grid, last result, standings ────────────────────────────────

    async fn refresh_details(&self, plan: DetailsPlan) {
        let name_of = |meeting_key: i64| self.store.lock().unwrap().meeting_name(meeting_key);
        let mut ok = true;

        if let Some((session_key, meeting_key)) = plan.last_race {
            let fetched: Result<_> = async {
                let rows = self.api.session_result(session_key).await?;
                let drivers: Drivers = self.api.drivers(session_key).await?.into_iter().map(|d| (d.driver_number, d)).collect();
                let champ = self.api.championship_drivers(session_key).await.unwrap_or_default();
                let teams = self.api.championship_teams(session_key).await.unwrap_or_default();
                Ok((rows, drivers, champ, teams))
            }
            .await;
            match fetched {
                Ok((rows, drivers, champ, teams)) => {
                    let meeting = name_of(meeting_key);
                    let mut store = self.store.lock().unwrap();
                    store.last_race = Some(view::build_result_view(&meeting, "Race", &rows, &drivers)).filter(|v| !v.rows.is_empty());
                    store.standings = Some(view::build_standings_view(&champ, &teams, &drivers)).filter(|v| !v.drivers.is_empty());
                }
                Err(e) => {
                    eprintln!("results not loaded: {e}");
                    ok = false;
                }
            }
        } else {
            let mut store = self.store.lock().unwrap();
            store.last_race = None;
            store.standings = None;
        }

        match plan.grid {
            Some((meeting_key, quali_key)) => {
                let fetched: Result<_> = async {
                    let rows = self.api.starting_grid(meeting_key).await?;
                    let drivers: Drivers = self.api.drivers(quali_key).await?.into_iter().map(|d| (d.driver_number, d)).collect();
                    Ok((rows, drivers))
                }
                .await;
                match fetched {
                    Ok((rows, drivers)) => {
                        let meeting = name_of(meeting_key);
                        let grid = view::build_grid_view(&meeting, &rows, quali_key, &drivers);
                        self.store.lock().unwrap().grid = Some(grid).filter(|g| !g.rows.is_empty());
                    }
                    Err(e) => {
                        eprintln!("grid not loaded: {e}");
                        ok = false;
                    }
                }
            }
            None => self.store.lock().unwrap().grid = None,
        }

        // remember the plan even after a failure: the retry is driven by `details_due`,
        // otherwise "plan changed" would fire again on every tick
        let mut t = self.timers.lock().unwrap();
        t.details_plan = plan;
        t.details_due = Some(Utc::now() + if !ok {
            minutes(1)
        } else if plan.grid.is_some() {
            minutes(15) // race week: the grid and results can still change
        } else {
            minutes(120)
        });
        drop(t);
        self.changed();
    }

    // ── live ────────────────────────────────────────────────────────

    fn desired_live_session(&self) -> Option<i64> {
        let store = self.store.lock().unwrap();
        store.account.as_ref()?;
        schedule::live_candidate(&store.sessions, Utc::now()).map(|s| s.session_key)
    }

    /// Start, switch or stop the live feed so it matches "a session is on and we have an account".
    fn ensure_live(self: &Arc<Self>) {
        let desired = self.desired_live_session();
        let current = self.live.lock().unwrap().as_ref().map(|c| c.session_key);
        match (desired, current) {
            (Some(want), Some(have)) if want == have => {}
            (Some(want), _) => {
                self.stop_live();
                self.start_live(want);
            }
            (None, Some(_)) => self.stop_live(),
            (None, None) => {}
        }
    }

    fn stop_live(&self) {
        if let Some(control) = self.live.lock().unwrap().take() {
            let _ = control.stop.send(true);
        }
        let mut store = self.store.lock().unwrap();
        store.live = None;
        store.conn = Conn::Connecting;
        drop(store);
        self.changed();
    }

    fn start_live(self: &Arc<Self>, session_key: i64) {
        let (stop_tx, stop_rx) = watch::channel(false);
        *self.live.lock().unwrap() = Some(LiveControl { session_key, stop: stop_tx });
        {
            let mut store = self.store.lock().unwrap();
            store.live = Some(LiveState::new(session_key));
            store.conn = Conn::Connecting;
        }

        let hub = self.clone();
        tokio::spawn(async move {
            let (tx, mut rx) = mpsc::unbounded_channel();
            // the stream starts buffering into the channel straight away...
            tokio::spawn(live::run_mqtt(hub.api.clone(), hub.mqtt.clone(), tx, stop_rx.clone()));
            // ...while the current state is fetched; stream rows are applied after it, so they win
            hub.bootstrap_live(session_key, stop_rx.clone()).await;

            let mut stop = stop_rx;
            loop {
                tokio::select! {
                    event = rx.recv() => match event {
                        Some(event) => hub.apply_live_event(session_key, event),
                        None => break,
                    },
                    _ = stop.changed() => break,
                }
            }
        });
    }

    /// REST catch-up for a session that is already under way.
    async fn bootstrap_live(&self, session_key: i64, stop: watch::Receiver<bool>) {
        if let Ok(drivers) = self.api.drivers(session_key).await {
            let drivers: Drivers = drivers.into_iter().map(|d| (d.driver_number, d)).collect();
            let mut store = self.store.lock().unwrap();
            if let Some(live) = store.live.as_mut().filter(|l| l.session_key == session_key) {
                live.drivers = drivers.keys().map(|&n| (n, view::driver_cell(&drivers, n))).collect();
            }
        }

        // intervals change every few seconds, so only the last couple of minutes are needed
        let since = iso(Utc::now() - ChronoDuration::minutes(2));
        let paths = [
            ("position", format!("/v1/position?session_key={session_key}")),
            ("intervals", format!("/v1/intervals?session_key={session_key}&date>={since}")),
            ("laps", format!("/v1/laps?session_key={session_key}")),
            ("stints", format!("/v1/stints?session_key={session_key}")),
            ("race_control", format!("/v1/race_control?session_key={session_key}")),
        ];
        for (topic, path) in paths {
            if *stop.borrow() {
                return;
            }
            match self.api.raw(&path).await {
                Ok(rows) => {
                    let mut store = self.store.lock().unwrap();
                    if let Some(live) = store.live.as_mut().filter(|l| l.session_key == session_key) {
                        rows.iter().for_each(|row| live.apply_row(topic, row));
                    }
                }
                Err(e) => eprintln!("live bootstrap {topic}: {e}"),
            }
        }
        self.changed();
    }

    fn apply_live_event(&self, session_key: i64, event: LiveEvent) {
        {
            let mut store = self.store.lock().unwrap();
            match event {
                LiveEvent::Connected => store.conn = Conn::Connected,
                LiveEvent::Reconnecting(why) => store.conn = Conn::Reconnecting(why),
                LiveEvent::Denied => store.conn = Conn::Denied,
                LiveEvent::Message { topic, payload } => {
                    if let Some(live) = store.live.as_mut().filter(|l| l.session_key == session_key) {
                        live.apply_payload(&topic, &payload);
                    }
                }
            }
        }
        self.changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_for_the_api_have_no_zone_suffix() {
        let t: DateTime<Utc> = "2026-10-11T12:34:56.789Z".parse().unwrap();
        assert_eq!(iso(t), "2026-10-11T12:34:56");
    }
}
