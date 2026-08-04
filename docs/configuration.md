# Configuration

Token Orchestrator has two configuration surfaces:

- **Widget (GUI)** — the desktop app's Settings panel. It is the normal configuration path.
- **`.env` and CLI flags** — configuration for the headless agent and standalone hub.

The widget reads `.env` values as first-run defaults. GUI values are saved in the Electron user-data directory and take precedence afterward. The agent and hub use **CLI flag → environment variable (including `.env`) → built-in default**.

The core environment keys are:

```env
TOKEN_MONITOR_HUB_URL=
TOKEN_MONITOR_SECRET=
TOKEN_MONITOR_DEVICE_ID=
TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS=
TOKEN_MONITOR_CLIENTS=
TOKEN_MONITOR_WATCH_POLLING=
TOKEN_MONITOR_PROJECTS_ENABLED=
TOKEN_MONITOR_HISTORY_ENABLED=
TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED=
TOKEN_MONITOR_LIMITS_ENABLED=
TOKEN_MONITOR_LIMIT_PROVIDERS=
```

## Widget settings

Open Settings with the gear button. The current sections are:

| Section | What it controls |
|---|---|
| **General** | Language, launch at login, app updates, Discord Rich Presence, and advanced maintenance options. |
| **Window** | Normal/floating/desktop-pinned behavior, floating bubble mode, and the global show/hide shortcut. The title bar always provides minimize and close controls. |
| **Appearance** | Theme, glass/background treatment, zoom, vendor colors, reduced motion, and display preferences. |
| **Collection** | Tracked clients, client visibility/order, collection cadence, session archive, custom pricing, export, and Windows WSL scanning. |
| **AI Tool Limits** | Enabled limit providers, refresh cadence, display options, provider ordering, and account credentials. Codex and Antigravity support multiple managed accounts. |
| **Multi-device Sync** | Local-only collection, connecting to a hub, or hosting an embedded hub on this device. |

There is no system-tray icon or tray-only mode. The widget remains a normal window and can be minimized or closed from its title bar.

## Headless agent and hub (`.env`)

The agent and hub have no UI. Configure them with a `.env` file in the project root (copy it from `.env.example`):

```env
TOKEN_MONITOR_HUB_URL=               # required in sync mode — http://<lan-ip>:17321
TOKEN_MONITOR_SECRET=                # shared secret; must match the hub
TOKEN_MONITOR_DEVICE_ID=             # optional — defaults to the hostname
TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS= # optional — 0/live, 600000/10min, 1200000/20min, 1800000/30min
TOKEN_MONITOR_CLIENTS=               # optional — defaults to all supported tools; empty disables tracking
TOKEN_MONITOR_PROJECTS_ENABLED=      # optional — defaults off; 1 collects project metadata
TOKEN_MONITOR_HISTORY_ENABLED=       # optional — defaults on; 0 skips trend history
TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED= # optional — defaults on; 0 stops archiving deleted-session usage
TOKEN_MONITOR_LIMITS_ENABLED=        # optional — defaults on; 0 skips CLI probing
TOKEN_MONITOR_LIMIT_PROVIDERS=       # optional — defaults to all supported providers
```

Provider credentials (Grok, DeepSeek, Minimax, Copilot, GLM / GLM Team, Volcengine, Qoder, Ollama, Kimi, …) and proxy settings live in the same file. **`.env.example` is the complete, authoritative list** — start from it rather than copying keys by hand, since it stays in sync with the code.

The widget reads these as first-run defaults; the agent and hub take a CLI flag over an env var over the built-in default. `.env.example` is the authoritative list of supported environment keys and provider credentials.

One-shot run (collect once and exit — useful for cron / launchd):

```bash
npm run agent -- --clients=claude,codex,opencode --once
```

To collect once without posting:

```bash
node src/agent/agent.js --once --dry-run
```

## Storage

On Windows, the widget stores settings, credentials, managed accounts, usage archives, and collector state under:

```text
%APPDATA%\\Token Orchestrator
```

Set `TOKEN_MONITOR_SHARED_DIR` to move shared collector files. The standalone hub stores `data/devices.json` in the project directory by default; use `TOKEN_MONITOR_DATA_FILE` or `--data-file` to choose another file.
