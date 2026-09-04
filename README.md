# Groww Focus

An independent hackathon project. Not affiliated with or endorsed by Groww, it just borrows the name because the idea is about focus: showing you what actually changed in your watchlist instead of a wall of numbers.

## The problem

Most watchlist screens are just a grid of live prices. Every row looks equally important, so you end up scanning the whole list every time you open the app, comparing it against what you remember from this morning. Two things make this worse:

- A fixed alert threshold ("tell me if it moves 3%") is wrong for most stocks. It's noise for a volatile name and silence for a calm one.
- Comparing "last price" to "current price" misses what happened in between. A stock that spiked 7% and settled back to +0.4% looks like nothing happened, when that swing was probably the most important thing that occurred that day.

## What it does

Groww Focus replaces the price grid with a **Brief**: a ranked list of what actually changed since you last looked, with a plain-language reason for each one. You mark a brief as reviewed when you're done with it, and the next time you open the app it only shows you what's new since that checkpoint.

The ranking comes from a small scoring engine (`backend/app/domain/engine.py`) that combines a few signals per symbol:

| Signal | What it checks |
|---|---|
| `move_vs_threshold` | Did it move more than the threshold you set for it? |
| `unusual_vs_baseline` | Is this move unusual compared to that symbol's own recent volatility? |
| `volume_anomaly` | Was there unusual trading volume behind the move? |
| `threshold_above` / `threshold_below` | Did it cross a price level you set? |
| `intrawindow_swing` | Did it spike and reverse while you weren't looking? |

Each signal that fires contributes points and a sentence explaining why, and the total is scaled by the priority you gave that symbol and by how fresh the underlying data is. The score then lands in one of four bands:

| Score | Severity |
|---|---|
| ≥ 70 | Critical |
| ≥ 45 | High |
| ≥ 25 | Notable |
| < 25 | Quiet (shown separately as "nothing happened") |

The engine itself is a pure function with no database or clock access, which is what makes it fast to test (`backend/tests/domain/test_engine.py`).

## Key user flow

1. Sign up, which seeds a starter watchlist so the Brief isn't empty on your first visit.
2. Add symbols on the **Watchlist** tab, set a priority per symbol if you want.
3. Tune sensitivity on the **Manage** tab: minimum move %, volume sensitivity, swing sensitivity. These are per-user preferences, not global settings, so a threshold that's right for you doesn't have to be right for anyone else.
4. Open the **Brief**. It shows what changed since your last checkpoint, ranked by score, with a reason for each row. Click a row to open the full price path for that symbol, with the checkpoint, the intra-window high/low, and "now" marked on the chart.
5. Click "I've reviewed this" when you're done. That's a manual action on purpose, nothing gets marked reviewed just from opening the tab, because closing the tab without reading it shouldn't silently erase what you were supposed to see.
6. Check **History** later to see what past briefs surfaced, grouped by day.

## Live and replay data

There are two ways the app gets market data, and the UI always tells you honestly which one you're looking at:

- **Replay** (the default) is a deterministic simulator. It generates prices as a hash of `(seed, symbol, tick index)`, so the same seed always produces the same market and nothing needs an API key. This is what runs out of the box and what the "Replay data" badge in the sidebar refers to. It's a status indicator, not a button. It just tells you which data source is currently backing the Brief. It's read-only because there's nothing to click, replay is either on or the live feed has taken over.
- **Live** wraps [Twelve Data](https://twelvedata.com/) for real NSE/BSE quotes. It only turns on if you set `MARKET_PROVIDER=live` and provide `TWELVE_DATA_API_KEY`. If the live call fails for any reason, the app automatically falls back to replay data and flips a `degraded` flag rather than showing nothing. The UI reflects this too: the badge switches to "Degraded" with a banner explaining the vendor is unavailable.

The one thing the UI is careful never to do is call replay data "Live", even if it's ticking in real time. If it's simulated, it says so.

The **Demo** button (visible when `DEMO_MODE=true`, which is the default in local dev) is a separate thing from all of this: it's an action, not a status. Clicking it seeds your current account's watchlist with the replay universe, backfills some price history, and sets a checkpoint three hours in the past, so you immediately get a populated Brief to look at instead of starting from an empty account. It always uses replay data regardless of which provider mode you're in. It's meant purely as a "show me something interesting right now" button for trying the app out.

## Tech stack

- **Backend:** FastAPI + SQLAlchemy on Postgres, bearer-token auth with bcrypt password hashing. Layered as `domain` (pure scoring logic, no DB imports), `services` (orchestration and transactions), `persistence` (models), `integrations` (the market data provider abstraction), and `api` (routers).
- **Frontend:** React + TypeScript + Tailwind, built with Vite. The price-path chart is a hand-rolled SVG chart rather than a charting library dependency, since it only needs to draw one specific chart shape.
- **Tests:** pytest, split into fast domain tests (no infrastructure needed) and integration tests that need Postgres and skip themselves if it's not reachable.

## A few reliability details worth knowing about

- Market snapshots are deduped on `(source, symbol, source_timestamp)`, so replaying the same feed twice never creates duplicate rows.
- A late-arriving tick is recorded but flagged `out_of_order` and excluded from scoring, and can never overwrite a newer "current" price, thanks to a conditional upsert (`WHERE latest.source_timestamp < new.source_timestamp`).
- Checkpoints are idempotent on a client-supplied key, so a double-tap on "I've reviewed this" can't accidentally create two checkpoints seconds apart and blank out the next brief.
- Adding a symbol you already have just returns the existing one instead of erroring, since a duplicate add is much more likely to be a double click than intent.
- Cross-user access to another account's watchlist returns 404, not 403, so you can't use the response to confirm whether a given watchlist ID exists.

## Setup

Needs Docker (for Postgres), Python 3.11+, and Node 20+.

```bash
docker compose up -d db
```

Backend:

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate      # Windows; source .venv/bin/activate on macOS/Linux
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn app.main:app --reload
```

There's no separate migration step, tables are created automatically on startup.

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` and create an account. It comes with a starter watchlist so the Brief isn't empty.

To see a populated Brief immediately without registering by hand, run the demo seed script instead:

```bash
cd backend
python -m app.demo           # fixed replay window, same output every run
python -m app.demo --live    # same market, anchored to now, seeds demo@example.com / demo-password-123
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local Postgres | Connection string |
| `ENVIRONMENT` | `development` | `production` requires a real `SECRET_KEY` |
| `SECRET_KEY` | demo value | JWT signing key |
| `INGEST_INTERVAL_SECONDS` | `15` | How often the ingestion loop polls |
| `BASELINE_WINDOW_SIZE` | `40` | Observations kept per symbol for the baseline |
| `MARKET_PROVIDER` | `replay` | `live` enables Twelve Data with a replay fallback |
| `TWELVE_DATA_API_KEY` | (none) | Required for live mode; without it the app just stays on replay |
| `TWELVE_DATA_EXCHANGE` | `NSE` | Exchange qualifier for the live provider |

No key is hardcoded anywhere, and the app runs fully in replay mode with zero external credentials.

## Deployment

There's a `backend/Dockerfile` and a `docker-compose.yml` that runs Postgres and the API together (`docker compose up -d`, then set `SECRET_KEY` in your environment for anything beyond local testing). The frontend has no server component, it's a static Vite build (`npm run build` in `frontend/`) that can be served from any static host, as long as `/api` is proxied or otherwise pointed at wherever the backend is running.

## Tests

```bash
cd backend
.venv/Scripts/python -m pytest
```

Domain tests run with no infrastructure. Integration tests need Postgres and skip themselves (loudly) if it's unreachable, since they exercise a Postgres-specific `ON CONFLICT ... WHERE` clause that wouldn't mean the same thing against SQLite.

## What's intentionally not here

- No news or event feed. There isn't a reliable, free, symbol-mapped news source, and a scraped approximation didn't seem worth the risk to a feature that's supposed to be trustworthy.
- No AI-generated summaries. The reasons shown in the Brief are assembled directly from the scoring signals, so they're already accurate by construction. Running them through an LLM would add latency and a chance of getting something wrong, for no real benefit.
- No outlier rejection on incoming prices. A bad print from the feed would currently be scored like a real move. Telling a genuine circuit-breaker event apart from a data glitch needs information (corporate actions, halts) this project doesn't have.
- One watchlist per user in the UI, though the schema supports more.
- No password reset or email verification flow.

## Known limitations

- Baselines are computed from replay history rather than real daily OHLC data, so "normal volatility" reflects the simulated series, not the actual market.
- History only records meaningful changes, not a row for every quiet check, so it stays small over time.
- The ingestion loop runs inside the single API process. Running multiple API replicas would currently duplicate polling work; splitting ingestion into its own process is the obvious next step if that ever matters.

For the reasoning behind specific design decisions (and the alternatives that were rejected), see [docs/decisions.md](docs/decisions.md).
