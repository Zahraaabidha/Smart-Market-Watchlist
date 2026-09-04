"""Watchlist and checkpoint operations.

Every function here takes a `user` and scopes its queries by that user's id.
Nothing in this module accepts a bare watchlist id and trusts it -- the lookup
and the ownership check are the same query, so there is no ordering in which a
caller can accidentally skip authorization.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.errors import Conflict, NotFound
from app.persistence.models import (
    User,
    UserCheckpoint,
    Watchlist,
    WatchlistItem,
)

DEFAULT_WATCHLIST_NAME = "My Watchlist"
DEFAULT_SYMBOLS = ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ZOMATO"]

MAX_ITEMS_PER_WATCHLIST = 100


def get_owned_watchlist(session: Session, user: User, watchlist_id: int) -> Watchlist:
    """Load a watchlist that belongs to this user, or raise NotFound.

    Returns NotFound rather than Forbidden for a watchlist owned by someone
    else. Returning 403 would confirm the id exists, which leaks the shape of
    other users' data to anyone enumerating ids.
    """
    watchlist = session.execute(
        select(Watchlist)
        .where(Watchlist.id == watchlist_id, Watchlist.user_id == user.id)
        .options(selectinload(Watchlist.items))
    ).scalar_one_or_none()

    if watchlist is None:
        raise NotFound("watchlist not found")
    return watchlist


def list_watchlists(session: Session, user: User) -> list[Watchlist]:
    return list(
        session.execute(
            select(Watchlist)
            .where(Watchlist.user_id == user.id)
            .options(selectinload(Watchlist.items))
            .order_by(Watchlist.created_at)
        ).scalars()
    )


def create_watchlist(session: Session, user: User, name: str) -> Watchlist:
    watchlist = Watchlist(user_id=user.id, name=name)
    # A SAVEPOINT, not a bare flush: a plain session.rollback() here would
    # discard everything the caller had already done in this transaction, not
    # just the failed insert.
    try:
        with session.begin_nested():
            session.add(watchlist)
            session.flush()
    except IntegrityError as exc:
        # The unique constraint on (user_id, name) is what actually prevents
        # duplicates under a double-submit; this converts it to a clean 409.
        raise Conflict(f"a watchlist named {name!r} already exists") from exc
    return watchlist


def create_default_watchlist(session: Session, user: User) -> Watchlist:
    """Seed a new account so the product is never a blank page on first login."""
    watchlist = create_watchlist(session, user, DEFAULT_WATCHLIST_NAME)
    for position, symbol in enumerate(DEFAULT_SYMBOLS):
        session.add(
            WatchlistItem(
                watchlist_id=watchlist.id,
                symbol=symbol,
                priority=1 if position == 0 else 2,
                position=position,
            )
        )
    session.flush()
    session.refresh(watchlist)
    return watchlist


def delete_watchlist(session: Session, user: User, watchlist_id: int) -> None:
    watchlist = get_owned_watchlist(session, user, watchlist_id)
    session.delete(watchlist)


def add_item(
    session: Session,
    user: User,
    watchlist_id: int,
    symbol: str,
    priority: int = 2,
    threshold_above: float | None = None,
    threshold_below: float | None = None,
) -> WatchlistItem:
    """Add a symbol. Idempotent: re-adding an existing symbol returns it.

    A duplicate add is far more likely to be a double-tap than a real intent to
    error, so it succeeds quietly rather than surfacing a failure the user
    cannot act on.
    """
    watchlist = get_owned_watchlist(session, user, watchlist_id)
    symbol = symbol.strip().upper()

    existing = session.execute(
        select(WatchlistItem).where(
            WatchlistItem.watchlist_id == watchlist.id,
            WatchlistItem.symbol == symbol,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    count = session.execute(
        select(func.count())
        .select_from(WatchlistItem)
        .where(WatchlistItem.watchlist_id == watchlist.id)
    ).scalar_one()
    if count >= MAX_ITEMS_PER_WATCHLIST:
        raise Conflict(
            f"a watchlist may hold at most {MAX_ITEMS_PER_WATCHLIST} symbols"
        )

    next_position = session.execute(
        select(func.coalesce(func.max(WatchlistItem.position), -1) + 1).where(
            WatchlistItem.watchlist_id == watchlist.id
        )
    ).scalar_one()

    item = WatchlistItem(
        watchlist_id=watchlist.id,
        symbol=symbol,
        priority=priority,
        position=next_position,
        threshold_above=threshold_above,
        threshold_below=threshold_below,
    )
    try:
        with session.begin_nested():
            session.add(item)
            session.flush()
    except IntegrityError:
        # Lost a race with a concurrent add of the same symbol. The other
        # writer's row is equally valid, so adopt it instead of failing. Only
        # the failed INSERT is undone; the surrounding transaction survives.
        return session.execute(
            select(WatchlistItem).where(
                WatchlistItem.watchlist_id == watchlist_id,
                WatchlistItem.symbol == symbol,
            )
        ).scalar_one()

    # The watchlist is already in the identity map with its items collection
    # loaded, and SQLAlchemy will not re-run the eager load for an instance it
    # already holds. Without this, a caller that re-reads the watchlist in the
    # same session sees the pre-insert list.
    session.expire(watchlist, ["items"])
    return item


def get_owned_item(
    session: Session, user: User, watchlist_id: int, item_id: int
) -> WatchlistItem:
    """Load an item, verifying ownership through its watchlist in one query."""
    item = session.execute(
        select(WatchlistItem)
        .join(Watchlist, WatchlistItem.watchlist_id == Watchlist.id)
        .where(
            WatchlistItem.id == item_id,
            WatchlistItem.watchlist_id == watchlist_id,
            Watchlist.user_id == user.id,
        )
    ).scalar_one_or_none()

    if item is None:
        raise NotFound("watchlist item not found")
    return item


def update_item(
    session: Session,
    user: User,
    watchlist_id: int,
    item_id: int,
    **fields,
) -> WatchlistItem:
    item = get_owned_item(session, user, watchlist_id, item_id)
    for key, value in fields.items():
        if value is not None:
            setattr(item, key, value)
    session.flush()
    return item


def remove_item(
    session: Session, user: User, watchlist_id: int, item_id: int
) -> None:
    item = get_owned_item(session, user, watchlist_id, item_id)
    session.delete(item)
    session.flush()

    watchlist = session.get(Watchlist, watchlist_id)
    if watchlist is not None:
        session.expire(watchlist, ["items"])


def reorder_items(
    session: Session, user: User, watchlist_id: int, ordered_item_ids: list[int]
) -> list[WatchlistItem]:
    """Apply a new ordering.

    Rejects any request that is not a permutation of the watchlist's current
    items. A partial reorder would leave positions ambiguous, and silently
    ignoring unknown ids would make the client and server disagree about the
    list the user is looking at.
    """
    watchlist = get_owned_watchlist(session, user, watchlist_id)
    current = {item.id: item for item in watchlist.items}

    if set(ordered_item_ids) != set(current) or len(ordered_item_ids) != len(current):
        raise Conflict("reorder must list every item in the watchlist exactly once")

    for position, item_id in enumerate(ordered_item_ids):
        current[item_id].position = position
    session.flush()
    return sorted(current.values(), key=lambda i: i.position)


def record_checkpoint(
    session: Session,
    user: User,
    watchlist_id: int,
    checked_at: datetime,
    idempotency_key: str | None = None,
) -> UserCheckpoint:
    """Mark the market as seen.

    Idempotent on `idempotency_key`. This matters more than it looks: a
    double-submitted checkpoint would create a second, near-instant window and
    destroy the "since you last checked" comparison the whole product is built
    on. The user would return to find nothing had changed, because they had
    unknowingly checked twice.
    """
    watchlist = get_owned_watchlist(session, user, watchlist_id)

    if idempotency_key:
        existing = session.execute(
            select(UserCheckpoint).where(
                UserCheckpoint.watchlist_id == watchlist.id,
                UserCheckpoint.idempotency_key == idempotency_key,
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

    checkpoint = UserCheckpoint(
        user_id=user.id,
        watchlist_id=watchlist.id,
        checked_at=checked_at,
        idempotency_key=idempotency_key,
    )
    try:
        with session.begin_nested():
            session.add(checkpoint)
            session.flush()
    except IntegrityError:
        # Concurrent replay of the same key; the winner's row is the answer.
        return session.execute(
            select(UserCheckpoint).where(
                UserCheckpoint.watchlist_id == watchlist_id,
                UserCheckpoint.idempotency_key == idempotency_key,
            )
        ).scalar_one()
    return checkpoint


def all_watched_symbols(session: Session) -> list[str]:
    """Every distinct symbol anyone is watching.

    The ingestion loop polls this union once per interval, so provider cost
    scales with the number of distinct symbols rather than with the number of
    users or page loads.
    """
    return list(
        session.execute(
            select(WatchlistItem.symbol).distinct().order_by(WatchlistItem.symbol)
        ).scalars()
    )
