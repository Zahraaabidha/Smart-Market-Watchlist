# Engineering decisions

Each entry records a decision, the alternative that was rejected, and why.
Ordered roughly by how much they shape the system.

---

## 1. The change engine is a pure function with no database access

`app/domain/` imports nothing from `app/persistence/`. The engine takes value
objects and returns value objects; `now` is a parameter, never a clock read.

**Rejected:** letting the engine query snapshots directly. It would have been
fewer lines.

**Why:** the engine is the product. Making it pure means its 33 tests run in
0.2 seconds with no Postgres, no fixtures and no I/O, so the scoring rules can
be exercised exhaustively across edge cases that would be tedious to set up
through the database. It also means a scoring bug can never be confused with a
persistence bug. The cost is a mapping layer in `services/brief.py`, which is
about forty lines and has no logic in it.

---

## 2. Append-only snapshots plus a separate "latest" projection

`market_snapshots` is never updated. `latest_quotes` holds current state and is
promoted only when `new.source_timestamp > existing.source_timestamp`.

**Rejected:** a single mutable row per symbol.

**Why:** the two tables have genuinely different correctness rules. History
wants completeness — every observation, including the late and the wrong ones,
because they are evidence about feed quality. Current state wants recency and
nothing else. One table cannot satisfy both: enforcing "newest wins" on a
history table destroys the audit trail, and keeping everything in a current-state
table makes every read a `max()` subquery.

Splitting them is what makes out-of-order handling a one-line `WHERE` clause
instead of a distributed-systems problem.

---

## 3. Ingestion is shared, not per-request

One background task polls the union of all watched symbols on an interval.
Request handlers only read.

**Rejected:** fetching quotes when a user loads their brief.

**Why:** two problems, one structural and one about honesty. Structurally,
per-request fetching multiplies provider load by users, and every popular
symbol gets fetched once per viewer. More importantly, two users looking at the
same stock at the same moment would see different prices, which quietly
destroys the claim that the system knows what the market did.

Provider cost now scales with distinct symbols, not with traffic.

---

## 4. The intra-window swing signal

The engine scores the highest and lowest price *within* the window, not just
the endpoints.

**Why:** this is the strongest argument for the whole architecture. A stock
that ran +7% and settled back at +0.4% is reported as "nothing happened" by any
system that compares last price to current price — and that is precisely the
event a returning user most needs to know about. Supporting this signal is the
reason snapshots are stored as a series rather than as a last-known value.

**Calibration note:** this signal is weighted at 34 points, equal to an explicit
threshold cross. It was initially 22, which a test caught as unreachable: the
swing signal fires exactly when the endpoint move is small, so the plain move
signal is silent and there is nothing to add to it. At 22 it could never clear
the 25-point NOTABLE floor, meaning the signal could not surface the one case it
exists to catch. There is now a regression guard asserting that every
standalone signal outweighs the NOTABLE band.

---

## 5. Per-symbol baselines rather than one global threshold

"Unusual" is measured in standard deviations of that symbol's own recent
returns, not as a fixed percentage.

**Rejected:** "alert me above 3%".

**Why:** 3% is a routine afternoon for a volatile mid-cap and a genuine event
for a large-cap utility. A single global threshold is the main reason
conventional watchlists cry wolf: it is simultaneously too sensitive for some
holdings and too blunt for others. The user's `min_move_pct` is kept as a
separate signal because personal relevance and statistical unusualness are
different questions, and the product answers both.

---

## 6. The engine withholds signals rather than guessing

When a baseline has fewer than five observations, or zero variance, the
"unusual move" signal does not fire at all.

**Why:** a product whose entire proposition is "we only tell you what matters"
cannot afford a confident-sounding claim derived from three data points. The
plain move signal still fires, so the observation is not lost — only the
comparison is withheld. Silence is cheaper than a false alert here.

---

## 7. Viewing the brief does not create a checkpoint

`GET /brief` is a pure read. Marking the market as seen is an explicit
`POST /checkpoint`.

**Rejected:** checkpointing automatically on page load.

**Why:** a user who opens the tab, gets interrupted, and closes it has not read
anything. Auto-checkpointing would erase exactly the changes they came back
for, and the loss would be silent and unrecoverable. Separating them costs one
button and makes the destructive action deliberate.

---

## 8. Checkpoints are idempotent on a client-supplied key

**Why:** this looked like box-ticking until the failure mode was traced. A
double-submitted checkpoint creates a second window seconds after the first,
so the next brief compares against a moment when nothing had yet happened. The
user returns to an empty brief and concludes the market was quiet. The data is
not corrupted in any way a constraint would catch — it is just wrong, silently.
That is worth a unique constraint on `(watchlist_id, idempotency_key)`.

---

## 9. Cross-user access returns 404, not 403

**Why:** 403 confirms the row exists. Anyone enumerating ids could map the
size and shape of other users' data without ever reading it. 404 makes "not
yours" and "not there" indistinguishable from outside.

---

## 10. Ownership checks live in the lookup, not beside it

`get_owned_watchlist(session, user, id)` filters on `user_id` in the same query
that loads the row. No service function accepts a bare id and trusts it.

**Why:** a separate `check_owner()` call is a check someone can forget. Fusing
the check into the load makes the unsafe version unavailable — there is no
function that returns a watchlist without verifying ownership, so a future
route cannot skip it by accident.

---

## 11. Deterministic replay provider instead of a live feed

Quotes are a pure function of `(seed, symbol, tick index)`, computed via hash
rather than accumulated through a stateful PRNG.

**Why:** the demo has to be reproducible and the tests have to be
deterministic. Computing each tick independently means history for any moment
can be produced without replaying everything before it, and the same seed gives
the same market on any machine. Snapping timestamps to a 15-second grid is what
makes repeated polling naturally idempotent — three polls inside one tick
produce one identical event that the unique constraint collapses.

A live provider implements the same interface; nothing above
`integrations/` would change.

---

## 12. No news/event signal

**Why:** the specification lists it as optional and conditional on reliable
data. There is no free, reliable, symbol-mapped news source. Approximating one
with headline scraping would put unverifiable claims inside a feature whose
value depends entirely on being trustworthy. Cutting it protects the thing that
makes the product worth using.

---

## 13. No AI layer

**Why:** the explanations are already complete sentences assembled from
verified numbers. An LLM rewriting them would add latency, cost, and a
hallucination surface over text that is currently guaranteed correct — while
making the reasoning harder to defend, not easier. The deterministic
explanations *are* the feature.

---

## 14. In-process asyncio ingestion, not Celery or a separate worker

**Why:** the work is one provider call and one bulk insert per interval. A
broker, a worker process and a result backend would be three new failure modes
in service of a task that takes milliseconds. The loop is isolated in
`main.py` and calls only `services.ingestion`, so extracting it later is a
matter of moving the entrypoint.

**Extraction trigger:** when ingestion no longer finishes inside one interval,
or when the API needs to scale independently of ingestion. Documented in the
README rather than pre-built.

---

## 15. PostgreSQL-specific upserts

`ON CONFLICT ... WHERE` is used directly rather than through a portable
abstraction.

**Why:** the conditional upsert *is* the out-of-order guarantee. Expressing it
portably would mean a read-then-write, which races under concurrent ingestion —
trading a real correctness property for a portability nobody asked for. The
integration tests therefore require real Postgres and skip loudly rather than
silently running against a different engine than the one that ships.

---

## 16. Volatility is scaled by the square root of time

The baseline is a per-observation standard deviation; the move being judged
spans the whole window. Comparing them directly is a horizon mismatch.

**Found by:** the demo printing "13.7x this stock's normal move size" for
routine drift. A three-hour move measured against 15-second volatility reads as
10-25 sigma, so the "unusual" signal fired for nearly every symbol — including
one that had moved 0.81%.

**Fix:** compare against `stdev * sqrt(periods)`. This assumes window and
baseline observations share a sampling interval, which holds because both come
from the same ingestion cadence.

**Why it matters:** unscaled, the signal that exists to prevent crying wolf was
the loudest source of it.

---

## 17. Meeting the user's own threshold is enough to surface

The move signal contributes `W_MOVE_MIN` (26, just above the NOTABLE band) at
exactly the user's threshold, rising to `W_MOVE_MAX` (48) at three times it.

**Rejected:** a single weight scaled linearly from zero, which is the obvious
formulation.

**Why:** scaling from zero gives a threshold-meeting move only a third of its
weight, so it lands below the NOTABLE floor. The demo showed a stock down 2.85%
in the "no meaningful change" list for a user who had asked about 2% moves. A
preference that does not mean what it says is worse than no preference.

---

## 18. The replay market mean-reverts instead of random-walking

Block levels follow an AR(1) process rather than an unbounded cumulative sum.

**Found by:** the UI showing RELIANCE at 9,705 against a 2,840 base. An
unbounded walk drifts arbitrarily far given enough time, and the first attempt
to bound it with a hard cap on accumulated blocks just froze the price instead.

**Why:** a simulated market that triples over eight months makes every baseline
meaningless and every screenshot implausible. AR(1) stays in a realistic band
forever while keeping the local texture of a random walk. Block levels are
interpolated rather than stepped, because a step at each block boundary would
inject an artificial jump that the change engine would correctly — and very
misleadingly — report as a real move.

---

## 19. Ingestion sorts by symbol before writing

Both `ingest_quotes` and `backfill` process symbols in sorted order.

**Found by:** a real deadlock between the demo's backfill and the running
server's ingestion loop, both upserting `latest_quotes`.

**Why:** concurrent transactions that take the same row locks in different
orders deadlock. Backfill walks symbol-by-symbol while a live poll walks
tick-by-tick across symbols, so their lock orders differed. Sorting makes every
writer acquire those locks in the same sequence, which makes the deadlock
impossible rather than merely rare.

Sorting inside `ingest_quotes` alone was not sufficient — `backfill` calls it
once per symbol, so the ordering guarantee has to hold at the transaction
level, not the batch level.

---

## 20. The comparison anchor is the last quote at or before the checkpoint

The brief loads a separate anchor row per symbol rather than using the first
observation inside the window.

**Found by:** clicking "Mark as read" and watching the brief report "No data
available" for every symbol — because no new tick had arrived in the
half-second-old window.

**Why:** two bugs in one. Using the first observation *after* the checkpoint
silently discards whatever moved between the checkpoint and that observation.
And it leaves the brief with nothing to show in the moments after a checkpoint,
when the honest answer is "these are quiet at their last known prices", not
"we have no data about symbols we have been tracking all day".

---

## 21. Backfill is a distinct ingestion mode

`ingest_quotes(..., historical=True)` records rows without flagging them
out-of-order.

**Found by:** a backfill silently excluding itself from every analysis window.
Historical rows are older than current state by definition, so the ordering
check flagged all 10,805 of them as out-of-order, and the brief filters those
out.

**Why:** "arrived late during streaming" and "we deliberately loaded the past"
are different events that happen to look identical to a timestamp comparison.
Conflating them corrupted the feed-quality metric and made backfill useless.
Historical rows are still never promoted over newer state.

---

## 22. Surfaced changes are stored, not recomputed

`meaningful_changes` rows are written when a brief is marked as read, carrying
the explanation text verbatim.

**Rejected:** deriving the timeline from snapshots on demand, which would need
no extra table at all.

**Why:** the engine is deterministic, but only given fixed inputs. Baselines
move as the window advances and old snapshots age out of it, so replaying last
Tuesday's brief a month later can honestly produce a different score and
different wording. "What was I told on Tuesday?" is a question about the past,
not a question about what the current model thinks about the past.

Only meaningful changes are stored. A row per quiet symbol per check would grow
without bound to record that nothing happened.

The write is guarded by the same idempotency key as the checkpoint: a replayed
key returns the original checkpoint and skips the write, so a double-submit
cannot duplicate timeline entries.
