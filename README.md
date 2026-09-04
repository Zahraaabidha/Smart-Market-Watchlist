# Smart Market Watchlist

**A watchlist should not make you scan the market. It should tell you what changed enough to matter.**

Conventional watchlists show you a grid of numbers and leave the analysis to
you. Every price is equally prominent, so nothing is. Come back after four
hours and you are doing the same visual diff you did this morning — against a
list you cannot remember the previous state of.

This product inverts that. The primary screen is not a list of prices; it is a
**Market Brief** that answers one question:

> What changed since I last checked, and what deserves my attention?

---

## The problem it solves

Three failures of the conventional design:

1. **Everything looks equally important.** A 0.2% drift and a 7% collapse get
   the same row, the same font, the same colour treatment.
2. **A fixed alert threshold is wrong for every stock.** "Tell me above 3%" is
   noise for a volatile mid-cap and silence for a stable large-cap.
3. **Comparing last price to current price misses what happened in between.**
   A stock that ran +7% and settled back at +0.4% reads as "nothing happened",
   and that is often the single most important event of the day.

---

## The Meaningful Change Engine

The core of the product is a deterministic scoring engine. It is a **pure
function** — no clock reads, no randomness, no database access — which is what
makes it exhaustively testable and fully explainable.

### Signals

| Signal | Weight | Question it answers |
|---|---|---|
| `move_vs_threshold` | 26 → 48 | Did it move more than *this user* cares about? |
| `unusual_vs_baseline` | up to 28 | Is this move unusual *for this stock*? |
| `volume_anomaly` | up to 18 | Is there conviction behind the move? |
| `threshold_above` / `threshold_below` | 34 | Did it cross a line the user drew? |
| `intrawindow_swing` | up to 34 | Did something big happen *and reverse* while they were away? |

Two calibration rules hold the model together, both found by tests and the demo
rather than by design:

- **Every standalone signal must outweigh the NOTABLE floor.** A swing or a
  threshold cross fires precisely when the endpoint move is small, so no other
  signal is available to add to it. Weighted below 25, such a signal can never
  surface the one case it exists to catch. A regression test asserts this.
- **Meeting the user's own threshold is enough to surface.** `move_vs_threshold`
  starts at 26 — just above the NOTABLE band — rather than scaling from zero. A
  preference that silently means something stricter than it says is worse than
  no preference at all.

Each firing signal contributes points **and its own sentence**. The score is
literally the sum of the explanations shown to the user — a property enforced
by a test, so the interface can never display a number it cannot justify.

The final score is scaled by user priority (0.8× / 1.0× / 1.25×) and by data
freshness, then banded:

| Score | Severity |
|---|---|
| ≥ 70 | Critical |
| ≥ 45 | High |
| ≥ 25 | Notable |
| < 25 | Quiet — shown in the "no meaningful change" list |

### Volatility is scaled by the square root of time

The baseline is a *per-observation* standard deviation, but the move being
judged spans the whole window. Comparing them directly is a horizon mismatch: a
three-hour move measured against 15-second volatility reads as 10–25 sigma, and
the signal fires for everything.

The engine therefore compares against `stdev × √periods`. Without this, the
signal that exists to prevent crying wolf was the loudest source of it — the
demo reported "13.7x this stock's normal move size" for a 0.81% drift.

### Why per-symbol baselines

"Unusual" is measured in standard deviations of that symbol's own recent
returns, not as a fixed percentage. A 4% move fires the unusual-move signal for
a calm stock and stays silent for a volatile one. This is the main defence
against crying wolf.

**When the baseline is thin (fewer than 5 observations, or zero variance), the
signal is withheld entirely.** A product whose value proposition is "we only
tell you what matters" cannot afford confident claims derived from three data
points. The plain move signal still fires — the observation is kept, only the
comparison is withheld.

### The signature signal: intra-window swing

The engine tracks the highest and lowest price *within* the window, not just
the endpoints. This is the reason the system stores a snapshot **series**
rather than a last-known price.

> Swung to +7.0% at its high while you were away, then settled at +0.4%.
> Comparing prices alone would have missed this.

---

## "Since you last checked" history

Marking a brief as read closes its window, and whatever that brief surfaced is
written to `meaningful_changes` against the checkpoint that closed it. The
**History** tab reads it back, grouped by day.

These are **records, not recomputations.** The brief could in principle be
rebuilt from snapshots, but the derivation is only stable while its inputs are:
baselines shift as the window advances and old snapshots age out, so
recomputing last Tuesday's brief next month can legitimately give a different
answer. A user asking "what was I told on Tuesday?" needs the answer they were
actually shown, so the explanation text and score are stored verbatim.

Paging is keyset-based on the primary key rather than `OFFSET`, which stays
fast as history grows and cannot skip or repeat rows when new entries arrive
mid-scroll.

---

## Data freshness as a first-class concept

Freshness is always derived from the **source timestamp** — when the market
produced the tick — never from when the row was written. A row inserted one
second ago carrying a twenty-minute-old quote is stale data.

| State | Age | Score weight |
|---|---|---|
| `fresh` | ≤ 60s | 1.00 |
| `delayed` | ≤ 15m | 0.85 |
| `stale` | > 15m | 0.50 |

- A brief reports its **worst** freshness, not its best.
- Stale data is never silently presented as current — the UI shows an explicit
  banner and the engine adds a `freshness_penalty` reason.
- A **future** source timestamp (clock skew, broken feed) is treated as stale,
  not as maximally fresh, so a bad feed cannot manufacture confident alerts.

---

## Architecture

A modular monolith: one FastAPI process, one Postgres, one React SPA.

```
backend/app/
  domain/         pure logic — engine, baselines, freshness.  NO db imports
  services/       orchestration, transactions, ownership checks
  persistence/    SQLAlchemy models
  integrations/   MarketDataProvider abstraction + replay provider
  api/            thin routers: parse, authorize, delegate, serialize
  core/           config, security, error types
frontend/src/     React + TypeScript + Tailwind
```

The rule that `domain/` imports nothing from `persistence/` is the most
important structural decision in the repository. It is why 54 domain tests run
in about a second with no infrastructure, and why a scoring bug can never be
confused with a persistence bug.

### Data flow

```
ReplayProvider ──> ingestion loop (every 15s, all watched symbols)
                        │
                        ├──> market_snapshots   (append-only, deduped)
                        └──> latest_quotes      (promoted only if newer)
                                    │
      user request ──> brief service ──> domain engine ──> ranked changes
                                                                │
                                                        Market Brief UI
```

---

## Reliability

### Duplicate events

`market_snapshots` is uniquely keyed on `(source, symbol, source_timestamp)`
with `ON CONFLICT DO NOTHING`. Replaying a feed any number of times inserts
exactly one row, which makes the ingestion loop safe to retry after a partial
failure.

The replay provider snaps timestamps to a 15-second grid, so polling faster
than the feed ticks produces identical events that collapse naturally rather
than three near-identical rows.

### Out-of-order events

Handled by splitting history from current state:

- **`market_snapshots`** records the late tick and flags it `out_of_order`, so
  feed quality stays measurable.
- **`latest_quotes`** is updated through a conditional upsert
  (`WHERE latest.source_timestamp < new.source_timestamp`), so a late tick can
  never regress what we present as current.

The `WHERE` clause is the real guarantee — it holds even when two ingestion
passes run concurrently and both believe they hold the newest tick. Ties do not
promote: equal timestamps are not newer.

Out-of-order rows are excluded from the analysis window, because they were
never part of what the user could have seen — including them would let a late
tick invent a swing that never happened.

### Conflicting values

Two vendors reporting different prices for the same instant both persist, since
`source` is part of the identity key. Disagreement is evidence, not noise to be
silently resolved.

### Concurrent writers

Ingestion sorts by symbol before writing, in both `ingest_quotes` and
`backfill`. Concurrent transactions that take the same `latest_quotes` row
locks in different orders deadlock — a backfill walking symbol-by-symbol and a
live poll walking tick-by-tick did exactly that during development. A
deterministic order makes the deadlock impossible rather than merely rare.

Backfill is also a distinct ingestion mode: historical rows are older than
current state by definition, which is not the same event as a late tick
arriving mid-stream. Conflating them flagged an entire backfill as
out-of-order and silently excluded it from every analysis window.

### Idempotency

- **Adding a symbol** is idempotent — a duplicate add returns the existing row.
  A double-tap is far more likely than a genuine intent to error.
- **Checkpoints** are idempotent on a client-supplied key. This matters more
  than it appears: a double-submitted checkpoint creates a second window
  seconds after the first, so the next brief compares against a moment when
  nothing had yet happened. The user returns to an empty brief and concludes
  the market was quiet. Nothing a constraint would catch — just silently wrong.

### Graceful degradation

- **Total provider outage** → last known good data is preserved and served with
  an explicit staleness banner. The ingestion loop survives and retries.
- **Partial failure** → healthy symbols ingest normally; unavailable ones are
  listed explicitly rather than rendered as unchanged.
- **Network failure in the browser** → the last good brief stays on screen; a
  failed background refresh does not blank the page.
- **Long absence** → the comparison window is bounded to 7 days, and the UI
  says so rather than implying a month-long comparison.

---

## Security

- Bearer-token auth (JWT), bcrypt password hashing.
- **Ownership checks are fused into the lookup.** `get_owned_watchlist(session,
  user, id)` filters on `user_id` in the same query that loads the row. There
  is no function that returns a watchlist without verifying ownership, so a
  future route cannot forget to check.
- **Cross-user access returns 404, not 403** — a 403 would confirm the row
  exists and let an attacker map other users' data by enumerating ids.
- Login failures return one message for both "no such user" and "wrong
  password", so the endpoint cannot enumerate accounts.
- Unhandled exceptions return a generic message; the trace goes to the log.
- The app refuses to start in `production` with the demo `SECRET_KEY`.

---

## Setup

**Requirements:** Docker (for PostgreSQL), Python 3.11+, Node 20+.

```bash
docker compose up -d db
```

### Run the demo

```bash
cd backend
python -m app.demo           # fixed replay window, byte-identical every run
python -m app.demo --live    # same market, anchored to now, seeds a UI account
```

`--live` seeds `demo@example.com` / `demo-password-123`. Sign in with it to see
a populated brief immediately.

### Manual setup

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate      # Windows;  source .venv/bin/activate on macOS/Linux
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn app.main:app --reload
```

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 and create an account — it is seeded with a starter
watchlist so the brief is never an empty page.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local Postgres | Connection string |
| `ENVIRONMENT` | `development` | `production` enforces a real `SECRET_KEY` |
| `SECRET_KEY` | demo value | JWT signing key |
| `INGEST_INTERVAL_SECONDS` | `15` | Shared polling cadence |
| `BASELINE_WINDOW_SIZE` | `40` | Observations retained per baseline |

No secret is hardcoded. The app runs fully in demo mode without external
credentials.

---

## Tests

```bash
cd backend
.venv/Scripts/python -m pytest
```

Domain tests need no infrastructure. Integration tests require Postgres and
**skip loudly** if it is unreachable — they exercise `ON CONFLICT ... WHERE`,
which is Postgres-specific, and running them against SQLite would test a
different system than the one that ships.

Coverage is concentrated on the highest-risk logic: scoring thresholds and
calibration, baseline reliability, freshness weighting, ranking determinism,
duplicate and out-of-order ingestion, provider failure, and cross-user
authorization.

---

## Demo mode

The replay provider generates quotes as a pure function of
`(seed, symbol, tick index)` using a hash rather than a stateful PRNG. The same
seed produces the same market on any machine, and any point in history can be
computed without replaying everything before it.

The default universe spans a calm large-cap, a volatile mid-cap and a very
quiet name, so per-symbol baselines have something real to discriminate
between.

---

## Trade-offs and what was deliberately cut

**No news/event signal.** There is no free, reliable, symbol-mapped news
source. Approximating one with headline scraping would put unverifiable claims
inside a feature whose entire value depends on being trustworthy.

**No AI layer.** The explanations are already complete sentences assembled from
verified numbers. An LLM rewriting them would add latency, cost and a
hallucination surface over text that is currently guaranteed correct — while
making the reasoning harder to defend, not easier.

**No Redis, Celery, or separate worker.** Ingestion is one provider call and
one bulk insert per interval. A broker and worker process would be new failure
modes in service of a task that takes milliseconds.

**Viewing the brief does not create a checkpoint.** A user who opens the tab,
gets interrupted and closes it has not read anything. Auto-checkpointing would
silently erase exactly the changes they came back for.

---

## Known limitations

- The replay provider simulates a market; it is not live data. A live provider
  implements the same interface with no changes above `integrations/`.
- Baselines are computed from the replay history rather than true daily OHLC
  bars, so "normal volatility" reflects the simulated series.
- One watchlist per user is surfaced in the UI, though the schema and API
  support many.
- History records only meaningful changes. Keeping a row per quiet symbol per
  check would grow without bound to record that nothing happened.
- No email verification or password reset.
- **No outlier rejection on incoming prices.** A feed glitch reporting a 4x
  price would be scored as a genuine move and surfaced as critical. This is a
  deliberate gap rather than an oversight: distinguishing bad data from a real
  circuit-breaker event, halt, or stock split needs corporate-actions data the
  system does not have, and a naive percentage filter would suppress exactly
  the extreme events the product exists to report. The honest fix is to flag
  suspect prints rather than silently drop them.
- The ingestion loop is per-process; running multiple API replicas would
  duplicate polling work (see below).

---

## How this scales

**Already done:**
- Market data is fetched **once per symbol**, not once per user or per request.
  Provider cost scales with distinct symbols, not traffic.
- Brief assembly bulk-loads all symbol windows in two queries regardless of
  watchlist size — no N+1.
- `ix_snapshots_symbol_time` serves the window query directly.
- `latest_quotes` avoids a correlated `max()` subquery on every read.

**Next steps, in the order they would become necessary:**

1. **Separate the ingestion loop into its own process.** Trigger: ingestion no
   longer finishes within one interval, or the API needs to scale independently.
   The loop already calls only `services.ingestion`, so this is a move of the
   entrypoint.
2. **Cache the brief per (watchlist, checkpoint).** Trigger: repeated reads
   between checkpoints dominating the query load. The result is deterministic
   for a given window, so it caches cleanly.
3. **Partition `market_snapshots` by time** and age out old partitions. Trigger:
   the table outgrowing comfortable index maintenance.
4. **Materialise baselines** on a schedule instead of computing per brief.
   Trigger: baseline history queries becoming the dominant cost.

Redis is not in this list until step 2 demonstrates a real need. Nothing here
is pre-built.

---

## Engineering decisions

See [docs/decisions.md](docs/decisions.md) for the reasoning behind each major
choice, including the alternatives that were rejected and why.
