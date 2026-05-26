# claude-statuses

> The "is any part of Claude down right now?" view that [status.claude.com](https://status.claude.com) hides.

Anthropic's status page lists six Claude products as separate components — `claude.ai`, Claude Console, Claude API, Claude Code, Claude Cowork, Claude for Government — each with its own uptime number. That layout obscures the question users actually have:

> **At any given moment, is _any_ part of Claude impacted? Over the last 90 days, what fraction of the time was _something_ broken?**

This project polls Anthropic's public Statuspage once a day via GitHub Actions, archives every incident (with all its updates) into this repo, and renders an **aggregate** timeline + uptime % across all components on a static GitHub Pages site.

Inspired by [`mrshu/github-statuses`](https://github.com/mrshu/github-statuses).

## How it works

- **`scripts/fetch.mjs`** — cron-driven poll (daily at 04:00 UTC). Pulls the public Statuspage endpoints + the homepage HTML, merges new incident updates into `data/incidents.jsonl` idempotently (one minified JSON record per line, sorted by `started_at`), and refreshes the rest of `data/`.
- **`scripts/backfill.mjs`** — one-shot seed. The public `/api/v2/incidents.json` caps at the most recent 50 incidents, so this scrapes `/history?page=N` for every historical slug, then fetches `/incidents/<slug>.json` individually.
- **`scripts/derive.mjs`** — reads the raw inputs and emits the `data/derived/*.json` files the site reads.
- **`site/`** — vanilla HTML/CSS/JS. Fetches `data/derived/*.json` at runtime; lazily fetches a single per-incident JSON file when a card is expanded. The deploy workflow splits `data/incidents.jsonl` into per-id files (`data/incidents/<id>.json`) into the published artifact only — the source repo keeps only the JSONL.

## Data sources

All upstream sources live under `https://status.claude.com`. Nothing is authenticated; everything is publicly served HTML or JSON.

### Raw inputs (written by `fetch.mjs` / `backfill.mjs`)

| File | Upstream source | How we get it | Cadence |
|---|---|---|---|
| `data/components.json` | `/api/v2/components.json` | Direct JSON fetch. Also read directly by the site to populate the component filter `<select>`. | Every poll. |
| `data/incidents.jsonl` | `/api/v2/incidents.json` (recent ~50) and `/incidents/<slug>.json` for backfilled history. | `fetch.mjs` merges `/api/v2/incidents.json` every poll. `backfill.mjs` paginates `/history?page=N` HTML for every historical slug (the public API caps at 50), then fetches `/incidents/<slug>.json` for each. Merge is idempotent on `id` + `incident_updates[].id`. | Every poll (incremental); `backfill.mjs` one-shot for history. |
| `data/uptime-data.json` | `https://status.claude.com/` homepage HTML | The page embeds `var uptimeData = { <componentId>: { days: [{date, outages:{p,m}, related_events}] } }` — the exact per-day partial / major outage seconds Statuspage itself renders, for all 6 components × 90 days in a single response. `fetch.mjs` greps for `var uptimeData` and brace-matches the JS object back out. | Every poll. |
| `data/uptime-history.json` | `/uptime/<componentId>.json?page=N` | Per-component, paginated 3 months at a time back to 2023. `fetch.mjs` walks pages until empty, for each of the 6 components. | At most once per 24 h (older months are static). |

### Derived outputs (written by `derive.mjs`)

| File | Built from | Contents |
|---|---|---|
| `data/derived/aggregate.json` | `daily-90d.json` aggregate row | Per-window (`24h`, `7d`, `30d`, `90d`) raw `major_seconds` / `critical_seconds` / `total_seconds` plus `stats.incident_count`. The client computes the displayed uptime % from these (weights live in `site/app.js`). |
| `data/derived/daily-90d.json` | `uptime-data.json` (authoritative per-day `{p, m}` seconds) + `incidents.jsonl` (for the `incident_ids` per day) | 90-day daily bucket grid: one row per component + a synthetic `is_aggregate: true` "All Claude" row. Drives both the hero panel bars and the per-component chart. |
| `data/derived/incidents-index.json` | `incidents.jsonl` | Slim per-incident metadata (`id, name, started_at, resolved_at, impact, components`). Initial payload for the incident list view; full update bodies are pulled lazily from `data/incidents/<id>.json` on card expand (per-id files are emitted by `scripts/split-incidents.mjs` at deploy time, or served JIT by `scripts/serve.mjs` locally). |
| `data/derived/aggregate-history.json` | `uptime-history.json` | Multi-year monthly calendar, union-merged across components (max `p` and `m` per day, union of related events). Drives the historical uptime section. |

## Local usage

```sh
node scripts/backfill.mjs        # seed data/incidents.jsonl (one-time)
node scripts/derive.mjs          # build data/derived/
node scripts/serve.mjs           # serve site at http://localhost:8000
```

Subsequent polls:

```sh
node scripts/fetch.mjs           # idempotent; no-ops if nothing changed
```

## Deploy

Fork, enable GitHub Pages (source: GitHub Actions), and the `fetch.yml` cron + `deploy.yml` deploy take over.

## License

MIT.
