# Engineering decisions

Short notes on the choices that shape Groww Focus.

## 1. Keep the scoring engine pure

**Decision:** `app/domain/` has no database or clock access. It takes values in and returns values out.

**Rejected:** Let the engine query snapshots directly.

**Why:** The core scoring rules stay easy to test and reason about. The tradeoff is a small mapping layer in `services/brief.py`.

## 2. Keep history separate from current state

**Decision:** `market_snapshots` is append-only. `latest_quotes` stores current state and only accepts newer source timestamps.

**Rejected:** One mutable table per symbol.

**Why:** History needs every observation. Current state needs the newest valid value. They have different correctness rules.

## 3. Ingest once for all watched symbols

**Decision:** One background task polls the union of watched symbols. Request handlers read stored data.

**Rejected:** Fetch market data whenever a user opens Brief.

**Why:** Provider load should depend on distinct symbols, not page traffic, and everyone should see the same stored observation.

## 4. Score the move inside the window

**Decision:** The engine considers the highest and lowest price between the checkpoint and now.

**Rejected:** Compare only the starting and ending prices.

**Why:** A large move that reverses before the user returns would otherwise disappear.

## 5. Use per-symbol volatility

**Decision:** Unusual movement is measured against each symbol's own recent volatility.

**Rejected:** One fixed percentage for every symbol.

**Why:** A move that is unusual for one stock can be normal for another.

## 6. Do not guess from thin data

**Decision:** The unusual-move signal stays off until the baseline has enough observations and non-zero variance.

**Rejected:** Estimate unusual movement from a tiny sample.

**Why:** A weak baseline is not enough evidence for a confident alert.

## 7. Make review explicit

**Decision:** `GET /brief` is read-only. A separate checkpoint action records that the user reviewed it.

**Rejected:** Create a checkpoint automatically when Brief opens.

**Why:** Opening a page does not mean the user actually read it.

## 8. Make checkpoints idempotent

**Decision:** Checkpoints use a client-supplied idempotency key with a database uniqueness constraint.

**Rejected:** Accept every checkpoint request as a new checkpoint.

**Why:** Double submissions should not silently change the next review window.

## 9. Enforce ownership during lookup

**Decision:** Watchlist lookup filters by both watchlist ID and user ID.

**Rejected:** Load by ID and perform a separate ownership check.

**Why:** The safe lookup becomes the default path, so callers cannot easily forget the ownership check. Cross-user access returns 404.

## 10. Use deterministic replay data

**Decision:** Replay prices are derived from `(seed, symbol, tick index)`.

**Rejected:** Use a stateful random walk as the replay source.

**Why:** Tests and demos stay reproducible, and a live provider can use the same interface.

## 11. Keep live data behind a provider interface

**Decision:** Twelve Data is one provider implementation. Replay is another, with replay available as fallback.

**Rejected:** Put provider-specific logic throughout the application.

**Why:** The scoring and application layers do not need to know where the market data came from.

## 12. Do not add a news signal

**Decision:** The product does not surface scraped news or corporate-event headlines.

**Rejected:** Build a lightweight headline-scraping feature.

**Why:** The project does not have a reliable symbol-mapped news source, and incorrect headlines would undermine trust.

## 13. Do not add an AI explanation layer

**Decision:** Brief explanations are generated directly from verified scoring signals.

**Rejected:** Send the explanation through an LLM.

**Why:** The current approach is deterministic, cheaper, faster, and easier to verify.

## 14. Keep ingestion in the API process for now

**Decision:** Market ingestion runs in an asyncio background loop inside the API process.

**Rejected:** Add Celery, a broker, and a separate worker.

**Why:** The current workload is small enough that extra infrastructure would mostly add failure modes. The ingestion boundary is kept isolated so it can be extracted later.

## 15. Use PostgreSQL-specific upserts

**Decision:** The current-state upsert uses PostgreSQL's conditional `ON CONFLICT` behavior.

**Rejected:** Read-then-write logic or a database-neutral abstraction.

**Why:** The database operation is part of the correctness guarantee for out-of-order data.

## 16. Scale volatility to the review window

**Decision:** The volatility baseline is scaled by `sqrt(time)` before comparing it with a multi-hour move.

**Rejected:** Compare a multi-hour move directly with per-observation volatility.

**Why:** The two measurements use different time horizons.

## 17. Make the user's threshold meaningful

**Decision:** A move that reaches the user's configured threshold is strong enough to enter the attention bands.

**Rejected:** Scale the signal from zero so that an exact threshold is still too weak to surface.

**Why:** A preference should behave the way the user expects.

## 18. Keep replay prices bounded

**Decision:** Replay block levels use a mean-reverting process instead of an unbounded random walk.

**Rejected:** Let the simulated price drift forever.

**Why:** Long replay windows should stay plausible enough for demos and baselines.

## 19. Keep database lock ordering consistent

**Decision:** Ingestion paths process symbols in a consistent order.

**Rejected:** Let concurrent writers acquire locks in arbitrary order.

**Why:** Consistent ordering prevents the deadlock found between live ingestion and backfill.

## 20. Anchor the brief at the last known checkpoint price

**Decision:** The brief uses the latest quote at or before the checkpoint as its anchor.

**Rejected:** Wait for the first quote after the checkpoint.

**Why:** The latter can produce an empty-looking brief immediately after review even when the symbol has known data.

## 21. Treat backfill as historical ingestion

**Decision:** Backfill records historical observations without treating them as late live arrivals.

**Rejected:** Run backfill through the same out-of-order handling as streaming data.

**Why:** Historical loading and late live data are different cases and should not affect feed-quality handling in the same way.

## 22. Store surfaced changes

**Decision:** When a brief is reviewed, meaningful changes are written to `meaningful_changes`.

**Rejected:** Recompute historical briefs from snapshots later.

**Why:** The inputs and baselines change over time. History should record what the user was actually shown.