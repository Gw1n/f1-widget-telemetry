# F1 telemetry

An interactive Formula 1 telemetry viewer built on the open [OpenF1](https://openf1.org) API.

> Unofficial and not affiliated with Formula 1 or the FIA. Data comes from OpenF1.

## What's here

- **Desktop app** (Electron, repository root): track map with all cars, timing board with tyres and gaps,
  per-driver telemetry and sector times, lap-vs-lap comparison, replay of any race since 2023, live data,
  and a transparent always-on-top map overlay. English and Russian.
- **[Widget](widget/)** (Tauri + Rust): a tiny menu-bar / system-tray companion with the next session
  countdown in your local time, starting grid, last result and the live order, so you do not need to keep
  the full app running.

## Live data

Replays and the schedule are free. **Live data needs an OpenF1 account with a paid real-time
subscription.** The *Demo live* button replays a finished race through the same pipeline, with no account.

## Run

```sh
npm install
npm start
```

## Build

```sh
npm run dist:mac    # macOS (arm64 + x64), ad-hoc signed
npm run dist:win    # Windows installer + portable exe
```

Windows builds are produced on GitHub Actions (`.github/workflows/build.yml`): open the *Actions* tab and
download the artifacts of the latest run. Builds are **not code-signed**, so macOS Gatekeeper and Windows
SmartScreen will warn on first launch.

See [widget/README.md](widget/README.md) for the widget.
