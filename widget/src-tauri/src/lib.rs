pub mod api;
pub mod format;
pub mod hub;
pub mod live;
pub mod menu;
pub mod model;
pub mod schedule;
pub mod settings;
pub mod tray;
pub mod view;

use std::sync::Arc;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_autostart::MacosLauncher;

use crate::hub::Hub;
use crate::model::Snapshot;

// ── commands called from the widget window ─────────────────────────

#[tauri::command]
fn get_snapshot(hub: State<'_, Arc<Hub>>) -> Snapshot {
    hub.snapshot()
}

#[tauri::command]
fn set_locale(hub: State<'_, Arc<Hub>>, code: String) {
    hub.set_locale(&code);
}

#[tauri::command]
async fn login(hub: State<'_, Arc<Hub>>, username: String, password: String, remember: bool) -> Result<(), String> {
    hub.inner().clone().login(&username, &password, remember).await
}

#[tauri::command]
async fn logout(hub: State<'_, Arc<Hub>>) -> Result<(), ()> {
    hub.inner().clone().logout().await;
    Ok(())
}

#[tauri::command]
fn refresh(hub: State<'_, Arc<Hub>>) {
    hub.refresh();
}

/// Used by `F1W_DEBUG=1`: the web view reports what it rendered.
#[tauri::command]
fn debug_report(report: String) {
    eprintln!("WEBVIEW {report}");
}

#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, on: bool) {
    let _ = window.set_always_on_top(on);
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::open_widget(app, None)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![get_snapshot, set_locale, login, logout, refresh, set_always_on_top, debug_report])
        .setup(|app| {
            // a menu-bar utility: no Dock icon, no app switcher entry
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_dir = app.path().app_config_dir()?;
            let hub = Hub::new(config_dir);
            app.manage(hub.clone());

            let presenter = tray::setup(app.handle(), hub.clone())?;
            tauri::async_runtime::spawn(hub.run(move || presenter.refresh()));

            if std::env::var_os("F1W_OPEN_WINDOW").is_some() {
                tray::open_widget(app.handle(), std::env::var("F1W_OPEN_WINDOW").ok().as_deref().filter(|t| !t.is_empty() && *t != "1"));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the widget");

    app.run(|_app, event| {
        // closing the window must not quit: the tray is the app
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}
