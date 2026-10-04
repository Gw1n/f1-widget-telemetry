//! Tray icon, native menu and the widget window: the only place that talks to Tauri's UI APIs.

use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, IsMenuItem, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

use crate::format::{self, Locale};
use crate::hub::Hub;
use crate::menu::{self, Entry};

const TRAY_ID: &str = "main";
const WINDOW: &str = "widget";

#[cfg(target_os = "macos")]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-template.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-color.png");

/// Native items for a menu model. Boxed because submenus and plain items are different types.
fn native_items(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for entry in entries {
        match entry {
            Entry::Header(text) | Entry::Text(text) => {
                items.push(Box::new(MenuItemBuilder::new(text).enabled(false).build(app)?));
            }
            Entry::Separator => items.push(Box::new(PredefinedMenuItem::separator(app)?)),
            Entry::Action { id, title } => items.push(Box::new(MenuItemBuilder::with_id(*id, title).build(app)?)),
            Entry::Check { id, title, checked } => {
                items.push(Box::new(CheckMenuItemBuilder::with_id(id.as_str(), title).checked(*checked).build(app)?));
            }
            Entry::Submenu(title, children) => {
                let children = native_items(app, children)?;
                let refs: Vec<&dyn IsMenuItem<Wry>> = children.iter().map(|c| c.as_ref()).collect();
                items.push(Box::new(SubmenuBuilder::new(app, title).items(&refs).build()?));
            }
        }
    }
    Ok(items)
}

fn native_menu(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Menu<Wry>> {
    let items = native_items(app, entries)?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    MenuBuilder::new(app).items(&refs).build()
}

/// Opens (or focuses) the small widget window. It is created on demand and destroyed when
/// closed, so the web view's memory is only used while the window is up.
pub fn open_widget(app: &AppHandle, tab: Option<&str>) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Some(tab) = tab {
            let _ = window.emit("navigate", tab);
        }
        return;
    }

    let script = format!(
        "window.__F1W_TAB = {}; window.__F1W_DEBUG = {};",
        serde_json::to_string(&tab).unwrap_or_else(|_| "null".into()),
        std::env::var_os("F1W_DEBUG").is_some()
    );
    let built = tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::App("index.html".into()))
        .title("F1 Widget")
        .inner_size(380.0, 620.0)
        .min_inner_size(330.0, 420.0)
        .initialization_script(&script)
        .build();
    match built {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(e) => eprintln!("could not open the widget window: {e}"),
    }
}

/// Keeps the tray in sync with the hub: title, tooltip, menu and the window's data.
pub struct Presenter {
    app: AppHandle,
    hub: Arc<Hub>,
    tray: TrayIcon,
    last_menu: Mutex<String>,
    last_title: Mutex<String>,
}

impl Presenter {
    pub fn refresh(&self) {
        let snapshot = self.hub.snapshot();
        let locale = Locale::from_code(&snapshot.locale);
        let now = chrono::DateTime::from_timestamp_millis(snapshot.now_ms).unwrap_or_default();
        let offset = format::local_offset(now);

        let title = menu::tray_title(&snapshot, locale);
        {
            let mut last = self.last_title.lock().unwrap();
            if *last != title {
                // macOS shows this next to the icon; elsewhere the tooltip carries the same information
                let result = self.tray.set_title(Some(&title));
                if std::env::var_os("F1W_DEBUG").is_some() {
                    eprintln!("TRAY set_title({title:?}) -> {result:?}, id={:?}", self.tray.id());
                }
                *last = title.clone();
            }
        }
        let tooltip = format!("{title}\n{}", menu::tray_tooltip(&snapshot, locale, offset));
        let _ = self.tray.set_tooltip(Some(tooltip));

        let autostart = self.app.autolaunch().is_enabled().unwrap_or(false);
        let entries = menu::build_menu(&snapshot, locale, offset, autostart);
        let signature = menu::signature(&entries);
        {
            let mut last = self.last_menu.lock().unwrap();
            if *last != signature {
                match native_menu(&self.app, &entries) {
                    Ok(native) => {
                        let _ = self.tray.set_menu(Some(native));
                        *last = signature;
                    }
                    Err(e) => eprintln!("menu not built: {e}"),
                }
            }
        }

        if std::env::var_os("F1W_DEBUG").is_some() {
            eprintln!("TITLE {title}");
            eprintln!("MENU\n  {}", menu::flatten(&entries).join("\n  "));
            eprintln!("SNAPSHOT {}", serde_json::to_string(&snapshot).unwrap_or_default());
        }
        let _ = self.app.emit_to(WINDOW, "snapshot", &snapshot);
    }
}

/// Create the tray icon and wire up its menu actions. Returns the presenter the hub loop calls.
pub fn setup(app: &AppHandle, hub: Arc<Hub>) -> tauri::Result<Arc<Presenter>> {
    let icon = Image::from_bytes(TRAY_ICON)?;
    let empty = MenuBuilder::new(app).build()?;

    let menu_hub = hub.clone();
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&empty)
        // macOS opens the menu on click; Windows opens the window on left click and the menu on right click
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "open" => open_widget(app, None),
                "account" => open_widget(app, Some("account")),
                "refresh" => menu_hub.refresh(),
                "quit" => app.exit(0),
                "autostart" => {
                    let manager = app.autolaunch();
                    let _ = if manager.is_enabled().unwrap_or(false) { manager.disable() } else { manager.enable() };
                }
                other => {
                    if let Some(code) = other.strip_prefix("lang:") {
                        menu_hub.set_locale(code);
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event
                && !cfg!(target_os = "macos")
            {
                open_widget(tray.app_handle(), None);
            }
        })
        .build(app)?;

    Ok(Arc::new(Presenter {
        app: app.clone(),
        hub,
        tray,
        last_menu: Mutex::new(String::new()),
        last_title: Mutex::new(String::new()),
    }))
}
