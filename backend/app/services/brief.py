"""Market Brief assembly.

Turns stored snapshots plus a user checkpoint into the answer to one question:
"what changed since I last checked, and what deserves my attention?"

All market reasoning is delegated to the pure domain engine. This module's job
is data access: load the right windows efficiently, hand them to the engine,
and package the result. It contains no scoring logic, which is what keeps the
engine testable without a database.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.domain import engine as change_engine
from app.domain import freshness as fresh
from app.domain.baseline import compute_baseline
from app.domain.models import (
    AttentionPreferences,
    DetectedChange,
    Quote,
    WatchedSymbol,
)
from app.persistence.models import (
    LatestQuote,
    MarketSnapshot,
    User,
    UserCheckpoint,
    Watchlist,
    WatchlistItem,
)

# How far back to look when a user has no checkpoint at all, or returns after
# a very long absence. Without a bound, a user away for a month would pull
# their entire snapshot history into memory to build one brief.
MAX_LOOKBACK = timedelta(days=7)


@dataclass
class BriefResult:
    watchlist_id: int
    watchlist_name: str
    last_checked_at: datetime | None
    generated_at: datetime
    monitored_count: int
    attention: list[DetectedChange]
    quiet: list[DetectedChange]
    unavailable_symbols: list[str]
    overall_freshness: str
    window_truncated: bool


def _to_quote(row: MarketSnapshot | LatestQuote) -> Quote:
    return Quote(
        symbol=row.symbol,
        price=Decimal(str(row.price)),
        volume=int(row.volume),
        source_timestamp=row.source_timestamp,
    )


def _latest_checkpoint(session: Session, watchlist_id: int) -> UserCheckpoint | None:
    return session.execute(
        select(UserCheckpoint)
        .where(UserCheckpoint.watchlist_id == watchlist_id)
        .order_by(UserCheckpoint.checked_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def build_brief(
    session: Session,
    user: User,
    watchlist: Watchlist,
    now: datetime,
) -> BriefResult:
    """Assemble the brief for one watchlist.

    Ownership is assumed to have been verified by the caller; this function
    never looks up a watchlist by id on its own, so it cannot be the place an
    authorization check is forgotten.
    """
    settings = get_settings()
    items: list[WatchlistItem] = list(watchlist.items)

    if not items:
        return BriefResult(
            watchlist_id=watchlist.id,
            watchlist_name=watchlist.name,
            last_checked_at=None,
            generated_at=now,
            monitored_count=0,
            attention=[],
            quiet=[],
            unavailable_symbols=[],
            overall_freshness=fresh.Freshness.STALE.value,
            window_truncated=False,
        )

    checkpoint = _latest_checkpoint(session, watchlist.id)
    checkpoint_time = checkpoint.checked_at if checkpoint else None

    floor = now - MAX_LOOKBACK
    window_truncated = False
    if checkpoint_time is None:
        window_start = floor
    elif checkpoint_time < floor:
        # A user returning after a long absence gets a bounded, honest window
        # rather than a slow query and a misleading month-long "since you last
        # checked" comparison.
        window_start = floor
        window_truncated = True
    else:
        window_start = checkpoint_time

    symbols = [item.symbol for item in items]

    # One query for every symbol's window, rather than one per symbol.
    # Bulk-loading here is what keeps brief cost flat as a watchlist grows.
    snapshot_rows = session.execute(
        select(MarketSnapshot)
        .where(
            MarketSnapshot.symbol.in_(symbols),
            MarketSnapshot.source_timestamp >= window_start,
            # A brief evaluated at time T must never consider observations
            # from after T. Without this the window is unbounded above, which
            # breaks any evaluation at a past instant -- replay, backtesting,
            # or a demo sharing a database with live ingestion.
            MarketSnapshot.source_timestamp <= now,
        )
        .order_by(MarketSnapshot.symbol, MarketSnapshot.source_timestamp)
    ).scalars().all()

    # The last observation at or before the checkpoint: the price as it stood
    # when the user actually last looked. Using the first observation *after*
    # the checkpoint instead would silently discard whatever moved between the
    # two, and would leave the brief with nothing at all to show in the moments
    # after a checkpoint, when no new tick has arrived yet.
    anchor_rows = session.execute(
        select(MarketSnapshot)
        .where(
            MarketSnapshot.symbol.in_(symbols),
            MarketSnapshot.source_timestamp <= window_start,
            MarketSnapshot.out_of_order.is_(False),
        )
        .distinct(MarketSnapshot.symbol)
        .order_by(MarketSnapshot.symbol, MarketSnapshot.source_timestamp.desc())
    ).scalars().all()

    anchors: dict[str, Quote] = {row.symbol: _to_quote(row) for row in anchor_rows}

    windows: dict[str, list[Quote]] = defaultdict(list)
    for row in snapshot_rows:
        # Out-of-order rows are retained in history but excluded from the
        # analysis window: they were never part of what the user could have
        # seen, and including them would let a late tick invent a swing.
        if row.out_of_order:
            continue
        windows[row.symbol].append(_to_quote(row))

    # Baseline history: a longer window than the analysis window, because
    # "normal for this stock" cannot be judged from the same few minutes being
    # analysed. Loaded in one query for all symbols.
    baseline_start = window_start - timedelta(days=2)
    baseline_rows = session.execute(
        select(MarketSnapshot)
        .where(
            MarketSnapshot.symbol.in_(symbols),
            MarketSnapshot.source_timestamp >= baseline_start,
            MarketSnapshot.source_timestamp < window_start,
            MarketSnapshot.out_of_order.is_(False),
        )
        .order_by(MarketSnapshot.symbol, MarketSnapshot.source_timestamp)
    ).scalars().all()

    baseline_history: dict[str, list[Quote]] = defaultdict(list)
    for row in baseline_rows:
        baseline_history[row.symbol].append(_to_quote(row))

    prefs = AttentionPreferences(
        min_move_pct=float(user.min_move_pct),
        volume_sensitivity=float(user.volume_sensitivity),
        swing_sensitivity=float(user.swing_sensitivity),
    )

    attention: list[DetectedChange] = []
    quiet: list[DetectedChange] = []
    unavailable: list[str] = []
    freshness_states: list[fresh.Freshness] = []

    for item in items:
        anchor = anchors.get(item.symbol)
        observed = windows.get(item.symbol, [])

        # The anchor leads the window so that every comparison starts from the
        # checkpoint price. With no new ticks yet, the anchor alone is a valid
        # one-point window: the symbol is quiet at its last known price, which
        # is the truth, rather than "no data" for a symbol we know plenty about.
        if anchor is not None:
            window = [anchor, *observed]
        elif observed:
            window = observed
        else:
            # Genuinely nothing on record. Reported explicitly rather than
            # rendered as a flat line, which would be indistinguishable from
            # "nothing happened".
            unavailable.append(item.symbol)
            continue

        history = baseline_history.get(item.symbol, [])
        # Trim to the configured window so baselines stay bounded and stable.
        history = history[-settings.baseline_window_size :]
        baseline = compute_baseline(item.symbol, history)

        watched = WatchedSymbol(
            symbol=item.symbol,
            priority=item.priority,
            threshold_above=(
                Decimal(str(item.threshold_above))
                if item.threshold_above is not None
                else None
            ),
            threshold_below=(
                Decimal(str(item.threshold_below))
                if item.threshold_below is not None
                else None
            ),
        )

        # The checkpoint quote is the first observation in the window: the
        # price as it stood when the user last looked.
        change = change_engine.evaluate_symbol(
            watched=watched,
            checkpoint_quote=window[0],
            window=window,
            baseline=baseline,
            prefs=prefs,
            now=now,
        )
        if change is None:
            unavailable.append(item.symbol)
            continue

        freshness_states.append(fresh.Freshness(change.freshness))
        if change_engine.is_meaningful(change):
            attention.append(change)
        else:
            quiet.append(change)

    # The brief reports its worst freshness, not its best. Claiming the whole
    # view is fresh because one symbol is would be exactly the silent
    # staleness this product promises not to do.
    if freshness_states:
        order = [fresh.Freshness.FRESH, fresh.Freshness.DELAYED, fresh.Freshness.STALE]
        overall = max(freshness_states, key=order.index)
    else:
        overall = fresh.Freshness.STALE

    return BriefResult(
        watchlist_id=watchlist.id,
        watchlist_name=watchlist.name,
        last_checked_at=checkpoint_time,
        generated_at=now,
        monitored_count=len(items),
        attention=change_engine.rank(attention),
        quiet=change_engine.rank(quiet),
        unavailable_symbols=sorted(unavailable),
        overall_freshness=overall.value,
        window_truncated=window_truncated,
    )
