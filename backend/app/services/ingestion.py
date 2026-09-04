"""Shared market data ingestion.

One poll serves every user. Market data is a property of a symbol, not of a
viewer, so fetching it per request would multiply provider load by the number
of users watching the same handful of large caps -- and would give two users
looking at the same screen slightly different numbers.

This module owns the two hard correctness rules of the write path:

  DUPLICATES  collapse on a unique constraint, so replaying a feed is safe.
  OUT-OF-ORDER ticks are recorded in history but never regress current state.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.domain.models import Quote
from app.integrations.provider import MarketDataError, MarketDataProvider
from app.persistence.models import LatestQuote, MarketSnapshot

logger = logging.getLogger(__name__)


@dataclass
class IngestResult:
    """What one ingestion pass actually did. Surfaced for observability."""

    fetched: int = 0
    inserted: int = 0
    duplicates: int = 0
    out_of_order: int = 0
    unavailable_symbols: list[str] = None  # type: ignore[assignment]
    provider_failed: bool = False

    def __post_init__(self) -> None:
        if self.unavailable_symbols is None:
            self.unavailable_symbols = []


def ingest_quotes(
    session: Session,
    quotes: Sequence[Quote],
    source: str,
    *,
    historical: bool = False,
) -> IngestResult:
    """Persist observations, enforcing duplicate and ordering rules.

    Runs in the caller's transaction so a partial batch cannot be committed:
    either the whole pass lands or none of it does.

    `historical` marks a deliberate backfill of the past. Such rows are older
    than current state by definition, which is not the same failure as a late
    tick arriving mid-stream -- flagging them as out-of-order would both
    corrupt the feed-quality metric and exclude the entire backfill from
    analysis windows. They are still never promoted over newer state.
    """
    result = IngestResult(fetched=len(quotes))
    if not quotes:
        return result

    # Deterministic ordering is a concurrency requirement, not tidiness.
    # Concurrent writers that touch the same latest_quotes rows in different
    # orders deadlock: a backfill walking symbol-by-symbol and a live poll
    # walking tick-by-tick will each hold a row the other needs. Sorting means
    # every transaction acquires these row locks in the same sequence, which
    # makes that deadlock impossible rather than merely unlikely.
    quotes = sorted(quotes, key=lambda q: (q.symbol, q.source_timestamp))

    symbols = {q.symbol for q in quotes}

    # Load current projection state for every symbol in the batch in one
    # query. Doing this per symbol would be an N+1 on the hottest write path.
    existing = {
        row.symbol: row.source_timestamp
        for row in session.execute(
            select(LatestQuote).where(LatestQuote.symbol.in_(symbols))
        ).scalars()
    }

    for quote in quotes:
        known_latest = existing.get(quote.symbol)
        is_late = known_latest is not None and quote.source_timestamp <= known_latest

        # Append to history unconditionally. ON CONFLICT DO NOTHING makes a
        # replayed event a no-op rather than an error, which is what lets the
        # ingestion loop be retried safely after a partial failure.
        stmt = (
            pg_insert(MarketSnapshot)
            .values(
                symbol=quote.symbol,
                price=quote.price,
                volume=quote.volume,
                source=source,
                source_timestamp=quote.source_timestamp,
                received_at=datetime.now(timezone.utc),
                out_of_order=is_late and not historical,
            )
            .on_conflict_do_nothing(constraint="uq_snapshot_identity")
            # RETURNING, not rowcount: psycopg3 reports rowcount as -1
            # ("unknown") for ON CONFLICT statements, and -1 is truthy, so
            # counting on it silently classifies every duplicate as an insert.
            # A skipped conflict returns no row, which is unambiguous.
            .returning(MarketSnapshot.id)
        )
        inserted = session.execute(stmt).first() is not None

        if inserted:
            result.inserted += 1
        else:
            result.duplicates += 1

        if is_late:
            # Recorded and explicitly not promoted to current state.
            if not historical:
                result.out_of_order += 1
            logger.debug(
                "out-of-order tick for %s: %s is not newer than %s",
                quote.symbol,
                quote.source_timestamp,
                known_latest,
            )
            continue

        _promote_to_latest(session, quote, source)
        existing[quote.symbol] = quote.source_timestamp

    return result


def _promote_to_latest(session: Session, quote: Quote, source: str) -> None:
    """Update the current-state projection, guarded on timestamp ordering.

    The WHERE clause on the upsert is the real defence. The in-memory check in
    the loop above is an optimisation; this is what holds when two ingestion
    passes run concurrently and both believe they have the newest tick.
    """
    stmt = (
        pg_insert(LatestQuote)
        .values(
            symbol=quote.symbol,
            price=quote.price,
            volume=quote.volume,
            source=source,
            source_timestamp=quote.source_timestamp,
            received_at=datetime.now(timezone.utc),
        )
        .on_conflict_do_update(
            index_elements=["symbol"],
            set_={
                "price": quote.price,
                "volume": quote.volume,
                "source": source,
                "source_timestamp": quote.source_timestamp,
                "received_at": datetime.now(timezone.utc),
            },
            where=LatestQuote.source_timestamp < quote.source_timestamp,
        )
    )
    session.execute(stmt)


def poll_and_ingest(
    session: Session,
    provider: MarketDataProvider,
    symbols: Sequence[str],
    now: datetime,
) -> IngestResult:
    """Fetch and persist one round of data for the given symbols.

    A total provider outage is reported, not raised: the product keeps serving
    the last known good data with an explicit staleness warning rather than
    failing the user's request because a vendor is down.
    """
    if not symbols:
        return IngestResult()

    try:
        quotes = provider.fetch_current(symbols, now)
    except MarketDataError:
        logger.warning("provider %s unavailable; serving last known state", provider.name)
        return IngestResult(provider_failed=True, unavailable_symbols=list(symbols))

    result = ingest_quotes(session, quotes, provider.name)
    returned = {q.symbol for q in quotes}
    result.unavailable_symbols = sorted(set(symbols) - returned)
    return result
