//! Persistent settings (a small JSON file) and the OpenF1 credentials (OS keychain).

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Settings {
    pub locale: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { locale: "en".into() }
    }
}

impl Settings {
    const FILE: &'static str = "settings.json";

    /// Missing or unreadable files yield the defaults.
    pub fn load(dir: &Path) -> Settings {
        fs::read_to_string(dir.join(Self::FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> io::Result<()> {
        fs::create_dir_all(dir)?;
        fs::write(dir.join(Self::FILE), serde_json::to_string_pretty(self)?)
    }
}

/// The password never touches disk in plain text: it lives in the macOS Keychain /
/// Windows Credential Manager, as one JSON entry.
pub mod secrets {
    use keyring::Entry;
    use serde::{Deserialize, Serialize};

    const SERVICE: &str = "dev.gw1n.f1widget";
    const ACCOUNT: &str = "openf1";

    #[derive(Serialize, Deserialize)]
    struct Stored {
        username: String,
        password: String,
    }

    fn entry() -> Result<Entry, keyring::Error> {
        Entry::new(SERVICE, ACCOUNT)
    }

    pub fn load() -> Option<(String, String)> {
        let json = entry().ok()?.get_password().ok()?;
        let stored: Stored = serde_json::from_str(&json).ok()?;
        Some((stored.username, stored.password))
    }

    pub fn save(username: &str, password: &str) -> Result<(), keyring::Error> {
        let json = serde_json::to_string(&Stored { username: username.into(), password: password.into() })
            .expect("serialisable");
        entry()?.set_password(&json)
    }

    pub fn clear() {
        if let Ok(entry) = entry() {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("test-scratch").join(name);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn settings_round_trip() {
        let dir = scratch_dir("settings_round_trip");
        Settings { locale: "ru".into() }.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir).locale, "ru");
    }

    #[test]
    fn missing_or_broken_settings_fall_back_to_english() {
        let dir = scratch_dir("settings_missing");
        assert_eq!(Settings::load(&dir), Settings::default());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), "{ not json").unwrap();
        assert_eq!(Settings::load(&dir).locale, "en");
    }
}
