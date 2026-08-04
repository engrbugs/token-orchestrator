# Token Orchestrator

Token Orchestrator is a local-first desktop companion for AI coding usage, provider limits, account management, history, and optional multi-device sync.

## Current app

The widget provides:

- Local usage and cost collection through `tokscale`
- AI Tool Limits for supported providers, including multiple Codex and Antigravity accounts
- Session details, project attribution, daily history, and trends
- Optional self-hosted sync through the Node hub or Cloudflare Worker hub
- Floating-bubble mode and global show/hide shortcuts
- A normal title bar with always-available minimize and close controls

The app has no system-tray icon. Usage collection continues in the background while the widget is open or minimized.

Supported client and provider identifiers are maintained in the code and documented in [Configuration](docs/configuration.md) and [`.env.example`](.env.example).

## Getting started

1. Install the latest release from GitHub Releases.
2. Launch the widget and open Settings to configure tracked clients and provider limits.
3. Add provider credentials only for the services you want to query.
4. Configure Multi-device Sync only when another hub should receive this device's data.

The widget works locally without a hub. The headless agent and standalone hub are configured with `.env` or command-line options; see [Configuration](docs/configuration.md).

## Data locations

On Windows, application data is stored under `%APPDATA%\\Token Orchestrator`. This includes `settings.json`, `credentials.json`, usage archives, collector state, and managed account data. The location can be overridden for shared collector data with `TOKEN_MONITOR_SHARED_DIR`.

A standalone Node hub stores its device database at `data/devices.json` by default. The path can be changed with `TOKEN_MONITOR_DATA_FILE` or the hub's `--data-file` option.

See [Privacy](docs/privacy.md) for network and sync behavior and [API](docs/API.md) for the hub wire format.

## Development

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm start          # Electron widget
npm run hub        # Node hub on port 17321
npm run agent      # headless collector
npm test           # node:test suite
npm run lint       # ESLint
npm run verify     # lint + tests
```

For a collector dry run without posting data:

```bash
node src/agent/agent.js --once --dry-run
```

## License

MIT
