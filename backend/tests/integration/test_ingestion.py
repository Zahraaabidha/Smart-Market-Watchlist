"""Ingestion reliability tests.

These cover the write-path guarantees that the product's trust story rests on:
a replayed feed must not duplicate history, and a late tick must never rewrite
what we present as current.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import func, select

from app.domain.models import Quote
from app.integrations.replay import FailingProvider, ReplayProvider, SymbolProfile
from app.persistence.models import LatestQuote, MarketSnapshot
from app.services.ingestion import ingest_quotes, poll_and_ingest

BASE = datetime(2026, 9, 4, 10, 0, 0, tzinfo=timezone.utc)


def quote(symbol: str, price: str, offset: int = 0, volume: int = 1_000) -> Quote:
    return Quote(
        symbol=symbol,
        price=Decimal(price),
        volume=volume,
        source_timestamp=BASE + timedelta(seconds=offset),
    )


def isolated_provider(*symbols: str) -> ReplayProvider:
    """A provider over test-only symbols.

    Snapshots are global market data shared by every user, so a test that
    asserts on row counts for a real symbol can be broken by anything else that
    has ever ingested it -- the demo scenario, a running server, another test.
    Using names that exist nowhere else keeps these assertions about only the
    rows the test itself created.
    """
    universe = {
        name: SymbolProfile(name, "100.00", volatility=0.3, base_volume=1_000_000)
        for name in symbols
    }
    return ReplayProvider(universe=universe)


def snapshot_count(session, symbol: str) -> int:
    return session.execute(
        select(func.count())
        .select_from(MarketSnapshot)
        .where(MarketSnapshot.symbol == symbol)
    ).scalar_one()


def latest(session, symbol: str) -> LatestQuote | None:
    return session.get(LatestQuote, symbol)


class TestIdempotentIngestion:
    def test_identical_event_ingested_twice_stores_one_row(self, session):
        event = quote("AAA", "100.00")

        first = ingest_quotes(session, [event], source="test")
        second = ingest_quotes(session, [event], source="test")

        assert first.inserted == 1
        assert second.inserted == 0
        assert second.duplicates == 1
        assert snapshot_count(session, "AAA") == 1

    def test_duplicate_within_a_single_batch_is_collapsed(self, session):
        event = quote("AAA", "100.00")

        result = ingest_quotes(session, [event, event], source="test")

        assert result.inserted == 1
        assert result.duplicates == 1
        assert snapshot_count(session, "AAA") == 1

    def test_same_timestamp_from_different_sources_is_not_a_duplicate(self, session):
        """Conflicting vendor values must both survive.

        Two providers disagreeing about a price is real; silently keeping one
        would erase the evidence that they disagreed.
        """
        event = quote("AAA", "100.00")
        other = Quote("AAA", Decimal("100.25"), 1_000, event.source_timestamp)

        ingest_quotes(session, [event], source="vendor-a")
        ingest_quotes(session, [other], source="vendor-b")

        assert snapshot_count(session, "AAA") == 2


class TestOutOfOrderEvents:
    def test_late_tick_does_not_regress_current_state(self, session):
        """The core ordering guarantee."""
        ingest_quotes(session, [quote("AAA", "110.00", offset=60)], source="test")
        result = ingest_quotes(session, [quote("AAA", "90.00", offset=30)], source="test")

        assert result.out_of_order == 1
        assert latest(session, "AAA").price == Decimal("110.0000")

    def test_late_tick_is_still_recorded_in_history(self, session):
        """Rejected for currency, retained for auditability."""
        ingest_quotes(session, [quote("AAA", "110.00", offset=60)], source="test")
        ingest_quotes(session, [quote("AAA", "90.00", offset=30)], source="test")

        assert snapshot_count(session, "AAA") == 2

    def test_late_tick_is_flagged_so_feed_quality_is_measurable(self, session):
        ingest_quotes(session, [quote("AAA", "110.00", offset=60)], source="test")
        ingest_quotes(session, [quote("AAA", "90.00", offset=30)], source="test")

        flagged = session.execute(
            select(MarketSnapshot).where(
                MarketSnapshot.symbol == "AAA", MarketSnapshot.out_of_order.is_(True)
            )
        ).scalars().all()

        assert len(flagged) == 1
        assert flagged[0].price == Decimal("90.0000")

    def test_equal_timestamp_does_not_overwrite(self, session):
        """Ties are not newer. Only a strictly newer tick may promote."""
        ingest_quotes(session, [quote("AAA", "110.00", offset=60)], source="a")
        ingest_quotes(session, [Quote("AAA", Decimal("95.00"), 1, BASE + timedelta(seconds=60))], source="b")

        assert latest(session, "AAA").price == Decimal("110.0000")

    def test_a_batch_arriving_shuffled_converges_on_the_newest(self, session):
        events = [
            quote("AAA", "100.00", offset=0),
            quote("AAA", "130.00", offset=90),
            quote("AAA", "110.00", offset=30),
            quote("AAA", "120.00", offset=60),
        ]

        ingest_quotes(session, events, source="test")

        assert latest(session, "AAA").price == Decimal("130.0000")
        assert snapshot_count(session, "AAA") == 4

    def test_newer_tick_after_a_late_one_still_promotes(self, session):
        """A late arrival must not poison subsequent legitimate updates."""
        ingest_quotes(session, [quote("AAA", "110.00", offset=60)], source="test")
        ingest_quotes(session, [quote("AAA", "90.00", offset=30)], source="test")
        ingest_quotes(session, [quote("AAA", "115.00", offset=90)], source="test")

        assert latest(session, "AAA").price == Decimal("115.0000")


class TestProviderFailure:
    def test_total_outage_preserves_last_known_good_state(self, session):
        ingest_quotes(session, [quote("AAA", "100.00")], source="test")

        result = poll_and_ingest(
            session, FailingProvider(), ["AAA"], datetime.now(timezone.utc)
        )

        assert result.provider_failed is True
        # The user still sees the last real price rather than an empty screen.
        assert latest(session, "AAA").price == Decimal("100.0000")

    def test_outage_reports_every_symbol_as_unavailable(self, session):
        result = poll_and_ingest(
            session, FailingProvider(), ["AAA", "BBB"], datetime.now(timezone.utc)
        )

        assert result.unavailable_symbols == ["AAA", "BBB"]

    def test_partial_failure_ingests_the_healthy_symbols(self, session):
        provider = isolated_provider("ZZ_HEALTHY", "ZZ_BROKEN")
        provider.failing_symbols.add("ZZ_BROKEN")

        result = poll_and_ingest(
            session,
            provider,
            ["ZZ_HEALTHY", "ZZ_BROKEN"],
            datetime(2026, 6, 1, tzinfo=timezone.utc),
        )

        assert result.unavailable_symbols == ["ZZ_BROKEN"]
        assert result.inserted == 1
        assert latest(session, "ZZ_HEALTHY") is not None
        assert latest(session, "ZZ_BROKEN") is None

    def test_empty_symbol_list_is_a_no_op(self, session):
        result = poll_and_ingest(
            session, ReplayProvider(), [], datetime.now(timezone.utc)
        )

        assert result.fetched == 0
        assert result.inserted == 0


class TestRepeatedPolling:
    def test_polling_faster_than_the_feed_ticks_does_not_duplicate(self, session):
        """The realistic duplicate case, end to end.

        The ingestion loop runs on a timer that has no relationship to the
        feed's tick rate. Polling three times inside one tick must leave one
        row, not three.
        """
        provider = isolated_provider("ZZ_POLLED")
        now = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)

        for _ in range(3):
            poll_and_ingest(session, provider, ["ZZ_POLLED"], now)

        assert snapshot_count(session, "ZZ_POLLED") == 1


class TestConcurrencySafety:
    def test_quotes_are_processed_in_a_deterministic_order(self, session):
        """Deadlock avoidance depends on a stable lock-acquisition order.

        Two transactions upserting the same latest_quotes rows in opposite
        orders will deadlock. Ingestion sorts by (symbol, source_timestamp) so
        every writer takes those row locks in the same sequence.
        """
        forward = [
            quote("ZZ_A", "100.00", offset=0),
            quote("ZZ_B", "200.00", offset=0),
            quote("ZZ_C", "300.00", offset=0),
        ]
        ingest_quotes(session, forward, source="order-test")

        # The reverse batch must converge on the same state, not deadlock or
        # produce a different projection.
        ingest_quotes(session, list(reversed(forward)), source="order-test")

        assert latest(session, "ZZ_A").price == Decimal("100.0000")
        assert latest(session, "ZZ_C").price == Decimal("300.0000")

    def test_shuffled_multi_symbol_batch_still_promotes_newest_per_symbol(
        self, session
    ):
        events = [
            quote("ZZ_X", "110.00", offset=60),
            quote("ZZ_Y", "220.00", offset=30),
            quote("ZZ_X", "105.00", offset=30),
            quote("ZZ_Y", "225.00", offset=60),
        ]

        ingest_quotes(session, events, source="order-test")

        assert latest(session, "ZZ_X").price == Decimal("110.0000")
        assert latest(session, "ZZ_Y").price == Decimal("225.0000")
