# Engineering decisions

Each entry records a decision, the alternative that was rejected, and why.
Ordered roughly by how much they shape the system.

---

## 1. The change engine is a pure function with no database access

**Decision:** `app/domain/` imports nothing from `app/persistence/`. The engine
takes value objects and returns value objects, and `now` is passed in as a
parameter instead of read from the clock.

**Rejected:** Letting the engine query snapshots directly. It would have been
fewer lines.

**Why:** The engine is the product, so it needs to be exhaustively testable.
Making it pure means its 33 tests run in 0.2 seconds with no Postgres, no
fixtures, and no I/O, which makes it practical to cover edge cases that would
be tedious to set up through the database. It also means a scoring bug can
never be confused with a persistence bug. The cost is a mapping layer in
`services/brief.py`, about forty lines with no logic of its own.

---

## 2. Append-only snapshots plus a separate "latest" projection

**Decision:** `market_snapshots` is never updated. `latest_quotes` holds
current state and is promoted only when `new.source_timestamp >
existing.source_timestamp`.

**Rejected:** A single mutable row per symbol.

**Why:** The two tables have genuinely different correctness rules. History
wants completeness: every observation, including the late and the wrong ones,
because they're evidence about feed quality. Current state wants recency and
nothing else. One table can't satisfy both. Enforcing "newest wins" on a
history table destroys the audit trail, and keeping everything in a
current-state table turns every read into a `max()` subquery. Splitting them
is what makes out-of-order handling a one-line `WHERE` clause instead of a
distributed-systems problem.

---

## 3. Ingestion is shared, not per-request

**Decision:** One background task polls the union of all watched symbols on
an interval. Request handlers only read.

**Rejected:** Fetching quotes when a user loads their brief.

**Why:** Two problems, one structural and one about honesty. Structurally,
per-request fetching multiplies provider load by users, and every popular
symbol gets fetched once per viewer. More importantly, two users looking at
the same stock at the same moment would see different prices, which quietly
breaks the claim that the system knows what the market did. Provider cost now
scales with distinct symbols, not with traffic.

---

## 4. The intra-window swing signal

**Decision:** The engine scores the highest and lowest price *within* the
window, not just the endpoints.

**Rejected:** Comparing only the checkpoint price to the current price.

**Why:** This is the strongest argument for the whole architecture. A stock
that ran +7% and settled back at +0.4% reads as "nothing happened" to any
system that only compares last price to current price, and that's exactly the
event a returning user most needs to know about. Supporting this signal is
the reason snapshots are stored as a series rather than a last-known value.

It's weighted at 34 points, equal to an explicit threshold cross. It started
at 22, and a test caught that as unreachable: the swing signal fires exactly
when the endpoint move is small, so the plain move signal is silent and there
is nothing for the swing signal to add to. At 22 it could never clear the
25-point NOTABLE floor, meaning it could never surface the one case it exists
to catch. There's now a regression test asserting that every standalone
signal outweighs the NOTABLE band.

---

## 5. Per-symbol baselines rather than one global threshold

**Decision:** "Unusual" is measured in standard deviations of that symbol's
own recent returns, not as a fixed percentage.

**Rejected:** "Alert me above 3%."

**Why:** 3% is a routine afternoon for a volatile mid-cap and a genuine event
for a large-cap utility. A single global threshold is the main reason
conventional watchlists cry wolf: it's simultaneously too sensitive for some
holdings and too blunt for others. The user's `min_move_pct` is kept as a
separate signal because personal relevance and statistical unusualness are
different questions, and the product answers both.

---

## 6. The engine withholds signals rather than guessing

**Decision:** When a baseline has fewer than five observations, or zero
variance, the "unusual move" signal doesn't fire at all.

**Rejected:** Firing the unusual-move signal anyway off a thin baseline.

**Why:** A product whose whole point is "we only tell you what matters"
can't afford a confident-sounding claim built on three data points. The plain
move signal still fires, so the observation isn't lost, only the comparison
is withheld. Silence is cheaper than a false alert here.

---

## 7. Viewing the brief does not create a checkpoint

**Decision:** `GET /brief` is a pure read. Marking the market as seen is an
explicit `POST /checkpoint`.

**Rejected:** Checkpointing automatically on page load.

**Why:** A user who opens the tab, gets interrupted, and closes it hasn't
actually read anything. Auto-checkpointing would erase exactly the changes
they came back for, silently and without any way to recover them. Separating
the two costs one button and makes the destructive action deliberate.

---

## 8. Checkpoints are idempotent on a client-supplied key

**Decision:** A checkpoint request carries an idempotency key, enforced by a
unique constraint on `(watchlist_id, idempotency_key)`.

**Rejected:** Accepting checkpoint requests as-is, with no duplicate guard.

**Why:** This looked like box-ticking until I traced the actual failure mode.
A double-submitted checkpoint creates a second window seconds after the
first, so the next brief compares against a moment when nothing had yet
happened. The user returns to an empty brief and concludes the market was
quiet. Nothing is corrupted in a way a constraint would normally catch, it's
just silently wrong. That's worth a unique constraint.

---

## 9. Cross-user access returns 404, not 403

**Decision:** Requesting another user's watchlist returns 404.

**Rejected:** Returning 403 Forbidden for rows that exist but aren't yours.

**Why:** A 403 confirms the row exists. Anyone enumerating ids could map the
size and shape of other users' data without ever reading it. 404 makes "not
yours" and "not there" indistinguishable from outside.

---

## 10. Ownership checks live in the lookup, not beside it

**Decision:** `get_owned_watchlist(session, user, id)` filters on `user_id`
in the same query that loads the row. No service function accepts a bare id
and trusts it.

**Rejected:** A separate `check_owner()` call made alongside the lookup.

**Why:** A separate check is a check someone can forget to call. Fusing it
into the load makes the unsafe version unavailable: there's no function that
returns a watchlist without verifying ownership, so a future route can't skip
it by accident.

---

## 11. Deterministic replay provider instead of a live feed

**Decision:** Quotes are a pure function of `(seed, symbol, tick index)`,
computed via a hash rather than accumulated through a stateful PRNG.

**Rejected:** A live feed as the default data source, or a stateful random
walk for replay.

**Why:** The demo has to be reproducible and the tests have to be
deterministic. Computing each tick independently means history for any
moment can be produced without replaying everything before it, and the same
seed gives the same market on any machine. Snapping timestamps to a
15-second grid is what makes repeated polling naturally idempotent: three
polls inside one tick produce one identical event, and the unique constraint
collapses the rest. A live provider implements the same interface, so
nothing above `integrations/` would need to change.

---

## 12. No news or event signal

**Decision:** The product doesn't surface news or corporate events.

**Rejected:** Approximating a news signal with headline scraping.

**Why:** There's no free, reliable, symbol-mapped news source. Scraped
headlines would put unverifiable claims inside a feature whose entire value
depends on being trustworthy. Cutting it protects the thing that makes the
product worth using.

---

## 13. No AI layer

**Decision:** Explanations shown to the user are assembled directly from the
scoring signals, not generated by a model.

**Rejected:** Running the explanations through an LLM to rewrite them.

**Why:** The explanations are already complete sentences built from verified
numbers. An LLM rewriting them would add latency, cost, and a hallucination
surface over text that's currently guaranteed correct, while making the
reasoning harder to defend, not easier. The deterministic explanations are
the feature.

---

## 14. In-process asyncio ingestion, not Celery or a separate worker

**Decision:** Ingestion runs as a background loop inside the API process.

**Rejected:** A message broker with a separate worker process.

**Why:** The work is one provider call and one bulk insert per interval. A
broker, a worker process, and a result backend would be three new failure
modes in service of a task that takes milliseconds. The loop is isolated in
`main.py` and calls only `services.ingestion`, so extracting it later is
just a matter of moving the entrypoint. That move is worth making once
ingestion no longer finishes inside one interval, or once the API needs to
scale independently of it; it's documented in the README as a next step
rather than built ahead of time.

---

## 15. PostgreSQL-specific upserts

**Decision:** `ON CONFLICT ... WHERE` is used directly rather than through a
database-agnostic abstraction.

**Rejected:** A portable upsert (or a read-then-write) that would also work
against other databases.

**Why:** The conditional upsert is the out-of-order guarantee. Expressing it
portably would mean a read-then-write, which races under concurrent
ingestion, trading away a real correctness property for a portability nobody
asked for. The integration tests require real Postgres and skip loudly
rather than silently running against a different engine than the one that
ships.

---

## 16. Volatility is scaled by the square root of time

**Decision:** The move being judged is compared against `stdev *
sqrt(periods)`, not against the raw per-observation baseline stdev.

**Rejected:** Comparing the window's move directly against per-observation
volatility.

**Why:** The baseline stdev is per-observation, but the move being judged
spans the whole window, so comparing them directly is a horizon mismatch.
This surfaced when the demo printed "13.7x this stock's normal move size" for
routine drift: a three-hour move measured against 15-second volatility reads
as 10-25 sigma, so the unusual-move signal fired for nearly every symbol,
including one that had only moved 0.81%. Scaling by the square root of time
assumes window and baseline observations share a sampling interval, which
holds because both come from the same ingestion cadence. Unscaled, the
signal that exists to prevent crying wolf was the loudest source of it.

---

## 17. Meeting the user's own threshold is enough to surface

**Decision:** The move signal contributes `W_MOVE_MIN` (26, just above the
NOTABLE band) at exactly the user's threshold, rising to `W_MOVE_MAX` (48) at
three times it.

**Rejected:** A single weight scaled linearly from zero, the more obvious
formulation.

**Why:** Scaling from zero gives a threshold-meeting move only a third of
its weight, so it lands below the NOTABLE floor. The demo showed a stock
down 2.85% in the "no meaningful change" list for a user who had asked about
2% moves. A preference that doesn't mean what it says is worse than no
preference at all.

---

## 18. The replay market mean-reverts instead of random-walking

**Decision:** Block levels follow an AR(1) process rather than an unbounded
cumulative sum.

**Rejected:** An unbounded random walk, and later a hard cap on accumulated
blocks on top of it.

**Why:** This surfaced when the UI showed RELIANCE at 9,705 against a 2,840
base. An unbounded walk drifts arbitrarily far given enough time, and the
first attempt to bound it with a hard cap just froze the price instead. A
simulated market that triples over eight months makes every baseline
meaningless and every screenshot implausible. AR(1) stays in a realistic
band forever while keeping the local texture of a random walk. Block levels
are interpolated rather than stepped, because a step at each block boundary
would inject an artificial jump that the change engine would correctly, and
very misleadingly, report as a real move.

---

## 19. Ingestion sorts by symbol before writing

**Decision:** Both `ingest_quotes` and `backfill` process symbols in sorted
order.

**Rejected:** Writing in whatever order each caller happened to produce.

**Why:** This surfaced as a real deadlock between the demo's backfill and
the running server's ingestion loop, both upserting `latest_quotes`.
Concurrent transactions that take the same row locks in different orders
deadlock, and backfill walks symbol-by-symbol while a live poll walks
tick-by-tick across symbols, so their lock orders differed. Sorting makes
every writer acquire those locks in the same sequence, which makes the
deadlock impossible rather than merely rare. Sorting inside `ingest_quotes`
alone wasn't enough, since `backfill` calls it once per symbol, so the
guarantee has to hold at the transaction level, not the batch level.

---

## 20. The comparison anchor is the last quote at or before the checkpoint

**Decision:** The brief loads a separate anchor row per symbol instead of
using the first observation inside the window.

**Rejected:** Using the first observation *after* the checkpoint as the
comparison anchor.

**Why:** This surfaced as clicking "Mark as read" and watching the brief
report "No data available" for every symbol, because no new tick had arrived
in the half-second-old window. It was two bugs in one. Using the first
observation after the checkpoint silently discards whatever moved between
the checkpoint and that observation, and it leaves the brief with nothing to
show in the moments right after a checkpoint, when the honest answer is
"these are quiet at their last known prices," not "we have no data about
symbols we've been tracking all day."

---

## 21. Backfill is a distinct ingestion mode

**Decision:** `ingest_quotes(..., historical=True)` records rows without
flagging them out-of-order.

**Rejected:** Running backfill through the same out-of-order check as live
ingestion.

**Why:** This surfaced when a backfill silently excluded itself from every
analysis window. Historical rows are older than current state by definition,
so the ordering check flagged all 10,805 of them as out-of-order, and the
brief filters those out. "Arrived late during streaming" and "we
deliberately loaded the past" are different events that happen to look
identical to a timestamp comparison. Conflating them corrupted the
feed-quality metric and made backfill useless. Historical rows are still
never promoted over newer state.

---

## 22. Surfaced changes are stored, not recomputed

**Decision:** `meaningful_changes` rows are written when a brief is marked
as read, carrying the explanation text verbatim.

**Rejected:** Deriving the timeline from snapshots on demand, which would
need no extra table at all.

**Why:** The engine is deterministic, but only given fixed inputs. Baselines
move as the window advances and old snapshots age out of it, so replaying
last Tuesday's brief a month later can honestly produce a different score
and different wording. "What was I told on Tuesday?" is a question about the
past, not a question about what the current model thinks about the past.
Only meaningful changes are stored; a row per quiet symbol per check would
grow without bound to record that nothing happened. The write is guarded by
the same idempotency key as the checkpoint, so a replayed key returns the
original checkpoint and skips the write, and a double-submit can't duplicate
timeline entries.
