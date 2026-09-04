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

# Points kept in the path attached to each attention card. The card sparkline
# only needs the shape; the full-resolution series is available from the
# dedicated path endpoint for the detail view.
CARD_PATH_POINTS = 56
# Cap for the detail endpoint. Enough to render a smooth line for a multi-day
# absence without shipping thousands of points.
DETAIL_PATH_POINTS = 240


@dataclass
class SymbolPath:
    """The price path across the user's absence window.

    This is what makes the product's signature claim visible: an endpoint
    comparison shows where a price ended, this shows the route it took. The
    high and low are the intra-window extremes the engine already scores
    against -- surfacing them here is serialization, not new logic.
    """

    # (timestamp, price, gap_before) -- `gap_before` is True when this point
    # follows a genuine break in data collection (see `_gap_threshold`) rather
    # than the previous point in the series. The first point is never marked:
    # there is nothing before it in the returned series to have gapped from.
    points: list[tuple[datetime, Decimal, bool]]
    checkpoint_at: datetime | None
    checkpoint_price: Decimal
    window_high: Decimal
    window_low: Decimal
    window_start: datetime
    window_end: datetime


@dataclass
class SymbolPathDetail(SymbolPath):
    """Everything the detail view needs, including data-trust fields."""

    symbol: str
    current_value: Decimal
    source: str
    source_timestamp: datetime
    received_at: datetime | None
    freshness: str
    last_checked_at: datetime | None


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
    paths: dict[str, SymbolPath]
    market_source: str


def _downsample_indices(quotes: list[Quote], cap: int) -> list[int]:
    """Indices `_downsample` keeps, in order.

    Split out from `_downsample` so gap detection (below) can be computed
    against the exact same selection without re-deriving it, and so a caller
    that needs to reason about what got thinned out between two kept points
    (as opposed to what never existed at all) has the original indices to
    work with.
    """
    if len(quotes) <= cap:
        return list(range(len(quotes)))

    hi = max(range(len(quotes)), key=lambda i: quotes[i].price)
    lo = min(range(len(quotes)), key=lambda i: quotes[i].price)
    keep = {0, len(quotes) - 1, hi, lo}

    stride = len(quotes) / cap
    keep.update(int(i * stride) for i in range(cap))
    return sorted(keep)


def _downsample(quotes: list[Quote], cap: int) -> list[Quote]:
    """Thin a series to at most `cap` points, keeping shape and both extremes.

    A plain stride would sometimes drop the exact high or low, which is the one
    point the path exists to show. Those indices are pinned before striding.
    """
    return [quotes[i] for i in _downsample_indices(quotes, cap)]


def _gap_threshold() -> timedelta:
    """How wide a silence has to be before it's a genuine data gap.

    Set generously above the configured poll cadence (never below 3 minutes)
    so ordinary jitter -- a slow poll, a couple of skipped duplicate ticks --
    is never mistaken for missing data. Below this, consecutive quotes are
    just consecutive quotes; above it, nothing was actually collected for
    that stretch (the ingestion loop was down, the provider was unreachable,
    etc.) and the chart must say so rather than draw through it.
    """
    interval = get_settings().ingest_interval_seconds
    return timedelta(seconds=max(interval * 8, 180))


def _build_path(
    window: list[Quote],
    checkpoint_at: datetime | None,
    window_start: datetime,
    window_end: datetime,
    cap: int,
) -> SymbolPath:
    prices = [q.price for q in window]

    # Gap detection runs on the *full-resolution* window, before downsampling.
    # A long window downsampled to `cap` points can legitimately put many real
    # minutes between two kept points -- that is thinning, not a gap, and the
    # only way to tell the two apart is to look at what was actually collected
    # in between before any of it gets thinned away.
    threshold = _gap_threshold()
    gap_after = [
        window[i + 1].source_timestamp - window[i].source_timestamp > threshold
        for i in range(len(window) - 1)
    ]

    indices = _downsample_indices(window, cap)
    points: list[tuple[datetime, Decimal, bool]] = []
    for pos, idx in enumerate(indices):
        gap_before = pos > 0 and any(
            gap_after[k] for k in range(indices[pos - 1], idx)
        )
        points.append((window[idx].source_timestamp, window[idx].price, gap_before))

    return SymbolPath(
        points=points,
        checkpoint_at=checkpoint_at,
        checkpoint_price=window[0].price,
        window_high=max(prices),
        window_low=min(prices),
        window_start=window_start,
        window_end=window_end,
    )


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
            paths={},
            market_source="none",
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
    paths: dict[str, SymbolPath] = {}

    # The source actually behind the data being shown, taken from the newest
    # snapshot rather than assumed -- across a live->replay failover the same
    # brief can legitimately carry two.
    considered = [*snapshot_rows, *anchor_rows]
    market_source = (
        max(considered, key=lambda r: r.source_timestamp).source
        if considered
        else "none"
    )

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
            # Only attention cards carry a path -- the quiet list is a compact
            # "we checked these" table with nothing to plot.
            paths[item.symbol] = _build_path(
                window, checkpoint_time, window_start, now, CARD_PATH_POINTS
            )
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
        paths=paths,
        market_source=market_source,
    )


def build_symbol_path(
    session: Session,
    watchlist: Watchlist,
    symbol: str,
    now: datetime,
) -> SymbolPathDetail | None:
    """Full-resolution price path for one symbol, for the detail view.

    Uses the same window rules as the brief (checkpoint-anchored, bounded to
    MAX_LOOKBACK, out-of-order rows excluded) so the detail chart and the card
    sparkline always tell the same story. Returns None when nothing is on
    record for the symbol.
    """
    symbol = symbol.upper()

    checkpoint = _latest_checkpoint(session, watchlist.id)
    checkpoint_time = checkpoint.checked_at if checkpoint else None

    floor = now - MAX_LOOKBACK
    window_start = (
        floor
        if checkpoint_time is None or checkpoint_time < floor
        else checkpoint_time
    )

    rows = session.execute(
        select(MarketSnapshot)
        .where(
            MarketSnapshot.symbol == symbol,
            MarketSnapshot.source_timestamp >= window_start,
            MarketSnapshot.source_timestamp <= now,
            MarketSnapshot.out_of_order.is_(False),
        )
        .order_by(MarketSnapshot.source_timestamp)
    ).scalars().all()

    anchor_row = session.execute(
        select(MarketSnapshot)
        .where(
            MarketSnapshot.symbol == symbol,
            MarketSnapshot.source_timestamp <= window_start,
            MarketSnapshot.out_of_order.is_(False),
        )
        .order_by(MarketSnapshot.source_timestamp.desc())
        .limit(1)
    ).scalar_one_or_none()

    series = ([anchor_row] if anchor_row is not None else []) + list(rows)
    if not series:
        return None

    quotes = [_to_quote(r) for r in series]
    latest = series[-1]
    assessment = fresh.assess(latest.source_timestamp, now)

    base = _build_path(
        quotes, checkpoint_time, window_start, now, DETAIL_PATH_POINTS
    )
    return SymbolPathDetail(
        points=base.points,
        checkpoint_at=base.checkpoint_at,
        checkpoint_price=base.checkpoint_price,
        window_high=base.window_high,
        window_low=base.window_low,
        window_start=base.window_start,
        window_end=base.window_end,
        symbol=symbol,
        current_value=quotes[-1].price,
        source=latest.source,
        source_timestamp=latest.source_timestamp,
        received_at=latest.received_at,
        freshness=assessment.state.value,
        last_checked_at=checkpoint_time,
    )
