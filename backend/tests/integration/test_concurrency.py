"""Real concurrency tests.

Every other integration test runs inside one connection wrapped in a
transaction that gets rolled back at the end (see `session` in conftest.py).
That is fast and keeps tests isolated, but it can never exercise an actual
race: two callers on separate connections committing at (as close to)
the same moment as we can arrange from Python. These tests open independent
sessions against the same engine, hold both threads at a barrier so they
enter the contested operation together, and only then let them proceed.

Cleanup is manual since nothing here is wrapped in a rolled-back transaction.
"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import delete, func, select
from sqlalchemy.orm import sessionmaker

from app.core.security import hash_password
from app.domain.models import Quote
from app.persistence.models import (
    LatestQuote,
    MarketSnapshot,
    User,
    UserCheckpoint,
    WatchlistItem,
)
from app.services import watchlists as wl
from app.services.ingestion import ingest_quotes

from .conftest import requires_db

BASE = datetime(2026, 9, 4, 10, 0, 0, tzinfo=timezone.utc)


def run_concurrently(fn_a, fn_b):
    """Run two zero-arg callables on separate threads, synchronized to start
    together. Returns (result_a, result_b); either slot holds the raised
    exception instead of a result if that side failed.
    """
    barrier = threading.Barrier(2)
    results = [None, None]

    def wrap(fn, slot):
        barrier.wait()
        try:
            results[slot] = fn()
        except Exception as exc:  # noqa: BLE001 - captured for the assertion
            results[slot] = exc

    threads = [
        threading.Thread(target=wrap, args=(fn_a, 0)),
        threading.Thread(target=wrap, args=(fn_b, 1)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    return tuple(results)


@requires_db
class TestConcurrentCheckpoints:
    def test_same_key_from_two_connections_creates_exactly_one_row(self, engine):
        """The sequential idempotency tests in test_authorization.py never
        actually hit the race branch in `record_checkpoint`: a second call on
        the same session always sees the first call's row via the pre-check
        SELECT. Two connections racing for real is the only way to reach the
        `except IntegrityError` fallback.
        """
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        setup = factory()
        user = User(
            email=f"conc-ckpt-{uuid.uuid4().hex[:8]}@example.com",
            password_hash=hash_password("correct-horse-battery"),
        )
        setup.add(user)
        setup.flush()
        watchlist = wl.create_watchlist(setup, user, "Concurrency test")
        setup.commit()
        user_id, watchlist_id = user.id, watchlist.id
        setup.close()

        def checkpoint_as(session_factory):
            session = session_factory()
            try:
                account = session.get(User, user_id)
                result = wl.record_checkpoint(
                    session, account, watchlist_id, BASE, "race-key"
                )
                session.commit()
                return result.id
            finally:
                session.close()

        try:
            a, b = run_concurrently(
                lambda: checkpoint_as(factory), lambda: checkpoint_as(factory)
            )

            assert not isinstance(a, Exception), f"first request raised: {a!r}"
            assert not isinstance(b, Exception), f"second request raised: {b!r}"
            assert a == b, "both requests must resolve to the same checkpoint"

            verify = factory()
            count = verify.execute(
                select(func.count())
                .select_from(UserCheckpoint)
                .where(
                    UserCheckpoint.watchlist_id == watchlist_id,
                    UserCheckpoint.idempotency_key == "race-key",
                )
            ).scalar_one()
            verify.close()
            assert count == 1
        finally:
            cleanup = factory()
            cleanup.execute(delete(User).where(User.id == user_id))
            cleanup.commit()
            cleanup.close()


@requires_db
class TestConcurrentWatchlistUpdates:
    def test_adding_two_different_symbols_at_once_keeps_both(self, engine):
        """Concurrent adds of *different* symbols to the same watchlist. The
        per-symbol unique constraint only guards against the same symbol
        racing itself (see `add_item`'s own IntegrityError handling); this
        covers the case that constraint does not.
        """
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        setup = factory()
        user = User(
            email=f"conc-add-{uuid.uuid4().hex[:8]}@example.com",
            password_hash=hash_password("correct-horse-battery"),
        )
        setup.add(user)
        setup.flush()
        watchlist = wl.create_watchlist(setup, user, "Concurrency test")
        setup.commit()
        user_id, watchlist_id = user.id, watchlist.id
        setup.close()

        def add_as(symbol, session_factory):
            session = session_factory()
            try:
                account = session.get(User, user_id)
                item = wl.add_item(session, account, watchlist_id, symbol)
                session.commit()
                return item.id
            finally:
                session.close()

        try:
            a, b = run_concurrently(
                lambda: add_as("ZZCONCA", factory),
                lambda: add_as("ZZCONCB", factory),
            )

            assert not isinstance(a, Exception), f"first add raised: {a!r}"
            assert not isinstance(b, Exception), f"second add raised: {b!r}"

            verify = factory()
            items = verify.execute(
                select(WatchlistItem).where(
                    WatchlistItem.watchlist_id == watchlist_id
                )
            ).scalars().all()
            verify.close()

            symbols = {i.symbol for i in items}
            assert symbols == {"ZZCONCA", "ZZCONCB"}, (
                "a concurrent add must never silently lose the other writer's "
                f"symbol; got {symbols}"
            )
        finally:
            cleanup = factory()
            cleanup.execute(delete(User).where(User.id == user_id))
            cleanup.commit()
            cleanup.close()

    def test_adding_two_different_symbols_at_once_does_not_duplicate_position(
        self, engine
    ):
        """Regression test for a real race: add_item's next_position was a
        plain SELECT max(position) + 1 with no lock, so two concurrent adds
        of *different* symbols could both read the same max and land on the
        same position (add_item's own IntegrityError handling only covered
        two writers racing to add the *same* symbol). Fixed by locking the
        watchlist row (`SELECT ... FOR UPDATE`) before computing the next
        position, serializing concurrent adds to the same watchlist around
        that read.
        """
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        setup = factory()
        user = User(
            email=f"conc-pos-{uuid.uuid4().hex[:8]}@example.com",
            password_hash=hash_password("correct-horse-battery"),
        )
        setup.add(user)
        setup.flush()
        watchlist = wl.create_watchlist(setup, user, "Concurrency test")
        setup.commit()
        user_id, watchlist_id = user.id, watchlist.id
        setup.close()

        def add_as(symbol, session_factory):
            session = session_factory()
            try:
                account = session.get(User, user_id)
                wl.add_item(session, account, watchlist_id, symbol)
                session.commit()
            finally:
                session.close()

        try:
            run_concurrently(
                lambda: add_as("ZZCONCC", factory),
                lambda: add_as("ZZCONCD", factory),
            )

            verify = factory()
            positions = [
                i.position
                for i in verify.execute(
                    select(WatchlistItem).where(
                        WatchlistItem.watchlist_id == watchlist_id
                    )
                ).scalars()
            ]
            verify.close()
            assert len(positions) == len(set(positions)), (
                f"positions must be unique per watchlist; got {positions}"
            )
        finally:
            cleanup = factory()
            cleanup.execute(delete(User).where(User.id == user_id))
            cleanup.commit()
            cleanup.close()

    def test_concurrent_priority_updates_on_the_same_item_do_not_crash(self, engine):
        """Two requests changing the same item's priority at once. There is
        no idempotency key here (unlike checkpoints/adds) because there is
        nothing to deduplicate: last write wins is the correct, ordinary SQL
        behaviour. What this actually guards against is a crash or a torn
        write, not a specific final value.
        """
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        setup = factory()
        user = User(
            email=f"conc-pri-{uuid.uuid4().hex[:8]}@example.com",
            password_hash=hash_password("correct-horse-battery"),
        )
        setup.add(user)
        setup.flush()
        watchlist = wl.create_watchlist(setup, user, "Concurrency test")
        item = wl.add_item(setup, user, watchlist.id, "ZZCONCP")
        setup.commit()
        user_id, watchlist_id, item_id = user.id, watchlist.id, item.id
        setup.close()

        def set_priority(priority, session_factory):
            session = session_factory()
            try:
                account = session.get(User, user_id)
                wl.update_item(
                    session, account, watchlist_id, item_id, priority=priority
                )
                session.commit()
                return priority
            finally:
                session.close()

        try:
            a, b = run_concurrently(
                lambda: set_priority(1, factory),
                lambda: set_priority(3, factory),
            )

            assert not isinstance(a, Exception), f"first update raised: {a!r}"
            assert not isinstance(b, Exception), f"second update raised: {b!r}"

            verify = factory()
            final = verify.get(WatchlistItem, item_id)
            final_priority = final.priority
            verify.close()
            assert final_priority in (1, 3), (
                "priority must end up as exactly one of the two values written, "
                f"not something corrupted; got {final_priority}"
            )
        finally:
            cleanup = factory()
            cleanup.execute(delete(User).where(User.id == user_id))
            cleanup.commit()
            cleanup.close()


@requires_db
class TestConcurrentIngestion:
    def test_two_connections_racing_to_ingest_the_same_snapshot_collapse_to_one(
        self, engine
    ):
        """The sequential duplicate-ingestion tests in test_ingestion.py
        exercise the same unique constraint, but from a single connection,
        which never proves the `ON CONFLICT DO NOTHING` path is safe when two
        writers genuinely race for the same row.
        """
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        symbol = "ZZCONCDUP"
        same_quote = Quote(
            symbol=symbol,
            price=Decimal("123.45"),
            volume=1_000,
            source_timestamp=BASE,
        )

        def ingest_as(session_factory):
            session = session_factory()
            try:
                result = ingest_quotes(session, [same_quote], source="race-test")
                session.commit()
                return (result.inserted, result.duplicates)
            finally:
                session.close()

        try:
            a, b = run_concurrently(
                lambda: ingest_as(factory), lambda: ingest_as(factory)
            )

            assert not isinstance(a, Exception), f"first ingest raised: {a!r}"
            assert not isinstance(b, Exception), f"second ingest raised: {b!r}"

            verify = factory()
            count = verify.execute(
                select(func.count())
                .select_from(MarketSnapshot)
                .where(MarketSnapshot.symbol == symbol)
            ).scalar_one()
            verify.close()
            assert count == 1, (
                "a snapshot racing itself must still collapse to one row, "
                f"got {count}"
            )
        finally:
            cleanup = factory()
            cleanup.execute(
                delete(MarketSnapshot).where(MarketSnapshot.symbol == symbol)
            )
            cleanup.execute(delete(LatestQuote).where(LatestQuote.symbol == symbol))
            cleanup.commit()
            cleanup.close()

    def test_older_and_newer_ticks_racing_always_converge_on_the_newer(self, engine):
        """The conditional upsert (`WHERE latest.source_timestamp <
        new.source_timestamp`) is what is supposed to make `latest_quotes`
        safe regardless of which writer's transaction actually commits
        first. This fires both a late and a current tick for the same symbol
        at once, in both possible thread-start orders, and checks the newer
        one always wins.
        """
        factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        symbol = "ZZCONCORD"
        older = Quote(
            symbol=symbol, price=Decimal("100.00"), volume=1_000, source_timestamp=BASE
        )
        newer = Quote(
            symbol=symbol,
            price=Decimal("200.00"),
            volume=1_000,
            source_timestamp=BASE + timedelta(seconds=30),
        )

        def ingest_one(q, session_factory):
            session = session_factory()
            try:
                ingest_quotes(session, [q], source="race-test")
                session.commit()
            finally:
                session.close()

        try:
            run_concurrently(
                lambda: ingest_one(older, factory),
                lambda: ingest_one(newer, factory),
            )

            verify = factory()
            latest = verify.get(LatestQuote, symbol)
            final_price = latest.price if latest else None
            verify.close()
            assert final_price == Decimal("200.0000"), (
                "the newer tick must win regardless of which transaction "
                f"committed first; latest_quotes shows {final_price}"
            )
        finally:
            cleanup = factory()
            cleanup.execute(
                delete(MarketSnapshot).where(MarketSnapshot.symbol == symbol)
            )
            cleanup.execute(delete(LatestQuote).where(LatestQuote.symbol == symbol))
            cleanup.commit()
            cleanup.close()
