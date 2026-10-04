# F1 Widget

A tiny menu-bar / system-tray companion to the full F1 telemetry app. It lives in the tray, so you
don't have to keep the heavy app open.

- **Menu-bar title**: a countdown to the next session (`Race 3d 4h`); during a session with live data,
  `L12 · VER` (lap and the leader).
- **Native menu**: the weekend schedule in *your* local time, the starting grid (after qualifying),
  the last race result and, with an OpenF1 account, the live order. Needs no window at all.
- **Widget window** (on demand): the same data with more room, standings, and the sign-in form. It is
  created when opened and destroyed when closed, so its web view costs no memory the rest of the time.
- English by default, Russian available (tray menu → Language).

## Data

OpenF1 (<https://openf1.org>). The schedule, grid, results and standings are free. **Live positions need
an OpenF1 account with a paid real-time subscription**; without one the widget still works, it just
cannot show the live order. The password is kept in the macOS Keychain / Windows Credential Manager
(only if "Remember" is ticked), never on disk in plain text.

Live data uses only five slow MQTT topics (`position`, `intervals`, `laps`, `stints`, `race_control`),
not the car telemetry the full app streams.

## Memory (measured on macOS, release build)

| State | Physical footprint |
|---|---|
| Tray only (window closed) | about 25–35 MB |
| Window open (widget + WebKit helper processes) | about 170 MB, back to the above when closed |

(`ps` shows ~100 MB RSS for the tray-only process; most of that is shared system frameworks.
Use `footprint -p <pid>` or Activity Monitor's *Memory* column.)

## Develop

The Rust toolchain used here lives *inside* this folder (`.toolchain/`, git-ignored), so nothing is
installed system-wide. Activate it per shell:

```sh
export RUSTUP_HOME="$PWD/.toolchain/rustup" CARGO_HOME="$PWD/.toolchain/cargo" PATH="$PWD/.toolchain/cargo/bin:$PATH"
npm install                                   # the Tauri CLI
npx tauri dev                                 # run
cargo test --manifest-path src-tauri/Cargo.toml --lib   # unit tests
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
npx tauri build                               # app + dmg on macOS (nsis on Windows)
```

If you already have Rust installed, skip the exports.

### Debug switches (environment variables)

| Variable | Effect |
|---|---|
| `F1W_DEBUG=1` | print the tray title, menu and data snapshot to stderr; the web view reports what it rendered |
| `F1W_OPEN_WINDOW=1` (or a tab name) | open the widget window at start |
| `F1W_API_BASE=http://127.0.0.1:PORT` | use a stand-in REST server (test mode; the saved password is never sent there) |
| `F1W_MQTT_URL=tcp://127.0.0.1:PORT` | use a local MQTT broker without TLS |
| `F1W_AUTOLOGIN=user:pass` | test mode only: works together with `F1W_API_BASE` |

### End-to-end test of the live path

`tests/e2e` starts a fake OpenF1 API and a local MQTT broker, runs the real binary against them and
checks: login → bearer token on REST calls → token as the MQTT password → subscriptions (and *only*
those) → stream updates, other sessions ignored → broker outage and reconnect → a broker that rejects
the login.

```sh
cd tests/e2e && npm install
BIN=../../src-tauri/target/debug/f1-widget npm test
BIN=../../src-tauri/target/debug/f1-widget npm run test:denied
```

## Not verified

- **Windows** has never been *run* (no Windows machine here). It is built by the repository workflow
  `.github/workflows/build.yml` on GitHub Actions; a green build proves it compiles and bundles, not that
  the tray and window behave correctly on Windows.
- The **menu-bar icon and title were not seen on screen** (no screen-recording permission in the
  environment where this was built). The tray API calls succeed and the native menu is built without
  errors; please check it once by eye.
- Live data has been tested only against the stand-ins above, never against the real broker.
