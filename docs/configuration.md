# Configuration

Token Orchestrator has one desktop configuration surface:

- **Widget (GUI)** — the desktop app's Settings panel. It is the normal configuration path.

The widget reads supported `.env` values as first-run defaults. GUI values are saved in the Electron user-data directory and take precedence afterward. The desktop widget is local-only; the legacy headless agent and standalone hub are retained for compatibility but are no longer part of the desktop product.

The core environment keys are:

```env
TOKEN_MONITOR_SECRET=
TOKEN_MONITOR_DEVICE_ID=
TOKEN_MONITOR_CLIENTS=
TOKEN_MONITOR_WATCH_POLLING=
TOKEN_MONITOR_PROJECTS_ENABLED=
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
| **Collection** | Tracked clients, client visibility/order, collection cadence, custom pricing, export, and Windows WSL scanning. |
| **AI Tool Limits** | Enabled limit providers, refresh cadence, display options, provider ordering, and account credentials. Codex and Antigravity support multiple managed accounts. |

There is no system-tray icon or tray-only mode. The widget remains a normal window and can be minimized or closed from its title bar.

## Storage

On Windows, the widget stores settings, credentials, managed accounts, and collector state under:

```text
%APPDATA%\\Token Orchestrator
```

Set `TOKEN_MONITOR_SHARED_DIR` to move shared collector files.
