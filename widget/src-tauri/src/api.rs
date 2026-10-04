//! OpenF1 REST client: rate-limited, with optional bearer-token authentication.
//! Historical data and the schedule are free; live endpoints need a paid account.

use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use reqwest::{Client, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::model::{ChampionshipDriver, ChampionshipTeam, Driver, GridRow, Meeting, ResultRow, Session};

const BASE: &str = "https://api.openf1.org";
/// The API allows 3 requests/second; stay well under it.
const MIN_GAP: Duration = Duration::from_millis(450);
const MAX_ATTEMPTS: u32 = 4;
const TOKEN_MARGIN: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub enum LoginError {
    BadCredentials,
    Failed(String),
}

impl std::fmt::Display for LoginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoginError::BadCredentials => write!(f, "bad_credentials"),
            LoginError::Failed(msg) => write!(f, "{msg}"),
        }
    }
}

struct Token {
    value: String,
    expires_at: Instant,
}

#[derive(Default)]
struct Auth {
    credentials: Option<(String, String)>,
    token: Option<Token>,
}

pub struct Api {
    client: Client,
    base: String,
    /// When the last request went out; holding the lock serialises requests.
    gate: Mutex<Instant>,
    auth: Mutex<Auth>,
}

impl Api {
    pub fn new() -> Self {
        Self::with_base(BASE)
    }

    pub fn with_base(base: &str) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("f1-widget/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Api {
            client,
            base: base.trim_end_matches('/').to_string(),
            gate: Mutex::new(Instant::now() - MIN_GAP),
            auth: Mutex::new(Auth::default()),
        }
    }

    // ── authentication ──────────────────────────────────────────────

    pub async fn login(&self, username: &str, password: &str) -> Result<(), LoginError> {
        let res = self
            .client
            .post(format!("{}/token", self.base))
            .form(&[("username", username), ("password", password)])
            .send()
            .await
            .map_err(|e| LoginError::Failed(e.to_string()))?;

        let status = res.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::BAD_REQUEST {
            return Err(LoginError::BadCredentials);
        }
        if !status.is_success() {
            return Err(LoginError::Failed(format!("HTTP {status}")));
        }
        let body: Value = res.json().await.map_err(|e| LoginError::Failed(e.to_string()))?;
        let value = body["access_token"]
            .as_str()
            .ok_or_else(|| LoginError::Failed("no access_token in the reply".into()))?
            .to_string();
        // `expires_in` comes as a string ("3600") in the documented reply
        let ttl = body["expires_in"]
            .as_u64()
            .or_else(|| body["expires_in"].as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(3600);

        let mut auth = self.auth.lock().await;
        auth.credentials = Some((username.to_string(), password.to_string()));
        auth.token = Some(Token { value, expires_at: Instant::now() + Duration::from_secs(ttl) });
        Ok(())
    }

    /// Remember credentials without contacting the server (they came from the keychain).
    pub async fn set_credentials(&self, username: String, password: String) {
        let mut auth = self.auth.lock().await;
        auth.credentials = Some((username, password));
        auth.token = None;
    }

    pub async fn logout(&self) {
        *self.auth.lock().await = Auth::default();
    }

    pub async fn username(&self) -> Option<String> {
        self.auth.lock().await.credentials.as_ref().map(|(u, _)| u.clone())
    }

    /// A token valid for at least a couple of minutes, logging in again when needed.
    pub async fn token(&self) -> Result<String> {
        let credentials = {
            let auth = self.auth.lock().await;
            if let Some(t) = &auth.token
                && t.expires_at > Instant::now() + TOKEN_MARGIN
            {
                return Ok(t.value.clone());
            }
            auth.credentials.clone()
        };
        let (user, pass) = credentials.ok_or_else(|| anyhow!("not signed in"))?;
        self.login(&user, &pass).await.map_err(|e| anyhow!("{e}"))?;
        let auth = self.auth.lock().await;
        Ok(auth.token.as_ref().map(|t| t.value.clone()).unwrap_or_default())
    }

    // ── requests ────────────────────────────────────────────────────

    async fn bearer(&self) -> Option<String> {
        self.auth.lock().await.credentials.as_ref()?;
        self.token().await.ok()
    }

    /// GET a JSON array. 404 means "no rows". 429/5xx are retried with a growing pause.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<Vec<T>> {
        let url = format!("{}{}", self.base, path);
        let mut last_error = anyhow!("request failed");

        for attempt in 0..MAX_ATTEMPTS {
            {
                let mut last = self.gate.lock().await;
                let wait = MIN_GAP.saturating_sub(last.elapsed());
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
                *last = Instant::now();
            }

            let mut request = self.client.get(&url);
            if let Some(token) = self.bearer().await {
                request = request.bearer_auth(token);
            }
            match request.send().await {
                Ok(res) => {
                    let status = res.status();
                    if status == StatusCode::NOT_FOUND {
                        return Ok(Vec::new());
                    }
                    if status == StatusCode::UNAUTHORIZED {
                        // a stale token must not break the free endpoints: retry anonymously
                        self.auth.lock().await.token = None;
                        last_error = anyhow!("HTTP 401");
                        continue;
                    }
                    if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                        last_error = anyhow!("HTTP {status}");
                        tokio::time::sleep(Duration::from_secs(u64::from(attempt) + 1)).await;
                        continue;
                    }
                    if !status.is_success() {
                        return Err(anyhow!("HTTP {status} for {path}"));
                    }
                    return res.json::<Vec<T>>().await.map_err(|e| anyhow!("bad reply for {path}: {e}"));
                }
                Err(e) => {
                    last_error = anyhow!("{e}");
                    tokio::time::sleep(Duration::from_secs(u64::from(attempt) + 1)).await;
                }
            }
        }
        Err(last_error.context(format!("GET {path}")))
    }

    pub async fn raw(&self, path: &str) -> Result<Vec<Value>> {
        self.get::<Value>(path).await
    }

    // ── typed endpoints ─────────────────────────────────────────────

    pub async fn sessions(&self, year: i32) -> Result<Vec<Session>> {
        self.get(&format!("/v1/sessions?year={year}")).await
    }

    pub async fn meetings(&self, year: i32) -> Result<Vec<Meeting>> {
        self.get(&format!("/v1/meetings?year={year}")).await
    }

    pub async fn drivers(&self, session_key: i64) -> Result<Vec<Driver>> {
        self.get(&format!("/v1/drivers?session_key={session_key}")).await
    }

    /// The grid is keyed by the *qualifying* session, so ask by meeting.
    pub async fn starting_grid(&self, meeting_key: i64) -> Result<Vec<GridRow>> {
        self.get(&format!("/v1/starting_grid?meeting_key={meeting_key}")).await
    }

    pub async fn session_result(&self, session_key: i64) -> Result<Vec<ResultRow>> {
        self.get(&format!("/v1/session_result?session_key={session_key}")).await
    }

    pub async fn championship_drivers(&self, session_key: i64) -> Result<Vec<ChampionshipDriver>> {
        self.get(&format!("/v1/championship_drivers?session_key={session_key}")).await
    }

    pub async fn championship_teams(&self, session_key: i64) -> Result<Vec<ChampionshipTeam>> {
        self.get(&format!("/v1/championship_teams?session_key={session_key}")).await
    }
}

impl Default for Api {
    fn default() -> Self {
        Self::new()
    }
}
