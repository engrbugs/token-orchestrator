# Data export

Token Orchestrator can export your usage data in **tool-agnostic** formats so you can
pull it into a spreadsheet, an Obsidian dashboard, Grafana, or your own scripts.
Nothing here is specific to any one tool — the app writes standard CSV + JSON and
you connect whatever consumer you like.

## How to export

In **Settings → Collection → Data export**:

- **Export data…** — pick a folder; Token Orchestrator writes the file set below into
  it once, right now.
- **Auto-export to a folder** — turn this on and choose a folder, and Token
  Orchestrator rewrites the file set whenever usage updates, at a frequency you choose
  (30 seconds to 60 minutes; default every minute) and skipped entirely when
  nothing changed, so an idle machine never re-uploads unchanged files through
  iCloud / Obsidian Sync. Point it at a folder inside your Obsidian vault (or any
  synced folder) to keep a dashboard always current, hands-free.

Both actions write the **same** files.

## The files

| File | What it is |
|---|---|
| `token-orchestrator-export.json` | Complete, lossless current snapshot in one JSON object |
| `token-orchestrator-snapshot.csv` | Current totals (today / month / all-time), one row per tool and per model |
| `token-orchestrator-daily.csv` | Legacy daily-history export; no longer populated by the desktop widget |

CSV files are UTF-8 **with BOM** (so Excel opens non-ASCII correctly), RFC 4180
quoted, with a header row and ISO 8601 dates. Cost columns are named `cost_usd`
and are always in USD.

### `token-orchestrator-snapshot.csv`

```
period,dimension,name,tokens,cost_usd
today,tool,codex,20,2
today,model,gpt-5,20,2
month,tool,codex,0,0
allTime,tool,codex,100,9
```

### `token-orchestrator-export.json`

```json
{
  "generatedAt": "2026-07-03T14:30:00.000Z",
  "app": { "name": "token-orchestrator", "version": "0.19.0" },
  "snapshot": { "today": { … }, "month": { … }, "allTime": { … } },
  "daily":   [],
  "monthly": []
}
```

The desktop widget exports the current snapshot. Daily and monthly time-series
fields remain empty for compatibility with older export consumers.

## Privacy

The export contains **only your usage numbers**. It never includes device
identifiers, hostnames, account emails, plan labels, or AI-tool limit/quota
account data. It is safe to drop into a synced vault.

## Recipes

### Obsidian (Dataview)

Point auto-export at a folder inside your vault (e.g. `TokenMonitor/`), then in a
note:

````markdown
```dataviewjs
const raw = await app.vault.adapter.read("TokenMonitor/token-orchestrator-export.json");
const data = JSON.parse(raw);
dv.table(["Date", "Tokens", "Cost (USD)"],
  data.daily.slice(-14).map(d => [d.date, d.tokens, "$" + d.cost.toFixed(2)]));
```
````

Prefer a code-free table? Import `token-orchestrator-snapshot.csv` with a
CSV/table plugin instead.

### Excel / Google Sheets / Numbers

Open `token-orchestrator-snapshot.csv` directly. It is a tidy (long) table, so
it pivots cleanly.

### Grafana / dashboards

Use `token-orchestrator-export.json` or `token-orchestrator-snapshot.csv` as a
JSON/CSV file data source.
