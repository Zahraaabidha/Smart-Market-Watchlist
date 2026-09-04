"""Historical backfill for newly watched symbols.

Without this, the product is subtly broken on a fresh install: baselines are
computed from snapshots older than the analysis window, and a symbol nobody has
watched before has none. `Baseline.is_reliable` would be false forever, so the
"unusual for this stock" and volume-anomaly signals could never fire -- the two
signals that most distinguish this product from a price table.

Backfilling once, when a symbol first appears, gives the engine something to
compare against from the first brief onward.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.integrations.provider import MarketDataError, MarketDataProvider
from app.persistence.models import MarketSnapshot
from app.services.ingestion import ingest_quotes

logger = logging.getLogger(__name__)

# Enough history for a stable baseline without pulling a large series on
# startup. At the 15s replay tick this is ~1400 observations per symbol, which
# the baseline window then trims to its configured size.
BACKFILL_WINDOW = timedelta(hours=6)


def symbols_without_history(
    session: Session, symbols: Sequence[str]
) -> list[str]:
    """Which of these symbols we have never stored a snapshot for.

    One query for all symbols rather than one per symbol, since this runs on
    every ingestion pass.
    """
    if not symbols:
        return []

    known = set(
        session.execute(
            select(MarketSnapshot.symbol)
            .where(MarketSnapshot.symbol.in_(symbols))
            .distinct()
        ).scalars()
    )
    return [s for s in symbols if s not in known]


def backfill(
    session: Session,
    provider: MarketDataProvider,
    symbols: Sequence[str],
    now: datetime,
    window: timedelta = BACKFILL_WINDOW,
) -> int:
    """Load recent history for the given symbols. Returns rows inserted.

    Failures are per symbol and non-fatal: one unavailable instrument must not
    prevent the others from getting a baseline. Ingestion goes through the
    normal path, so backfilled rows get the same duplicate and ordering
    guarantees as live ones and re-running this is safe.
    """
    inserted = 0
    since = now - window

    # Sorted for the same reason ingestion sorts its batch: this transaction
    # takes latest_quotes row locks one symbol at a time, and a live poll is
    # doing the same concurrently. Both must walk the symbols in the same order
    # or they deadlock against each other. Sorting inside ingest_quotes is not
    # enough on its own, because backfill calls it once per symbol.
    for symbol in sorted(symbols):
        try:
            history = provider.fetch_history(symbol, since, now)
        except MarketDataError:
            logger.warning("backfill unavailable for %s; skipping", symbol)
            continue

        if not history:
            continue

        result = ingest_quotes(session, history, provider.name, historical=True)
        inserted += result.inserted
        logger.info("backfilled %s: %s observations", symbol, result.inserted)

    return inserted
