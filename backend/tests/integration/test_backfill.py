"""Backfill and restart-resume behavior.

`symbols_without_history` is what makes a backend restart safe: it must tell
"never seen this symbol" (needs a backfill) apart from "already has history"
(skip -- redoing a backfill on every restart would waste a provider call and
is exactly the kind of thing that turns a brief outage into duplicated or
corrupted history if it weren't idempotent).

These exercise the same sequence `app.main._run_one_pass` runs on every
tick -- `symbols_without_history` -> `backfill` -> `poll_and_ingest` -- twice
in a row to simulate the process dying and restarting between passes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func, select

from app.domain.models import Quote
from app.integrations.replay import ReplayProvider, SymbolProfile
from app.persistence.models import LatestQuote, MarketSnapshot
from app.services.backfill import backfill, symbols_without_history
from app.services.ingestion import ingest_quotes, poll_and_ingest

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)


def _provider(*symbols: str) -> ReplayProvider:
    # Test-only symbols, per the same reasoning as test_ingestion.py's
    # isolated_provider: shared market_snapshots rows must not be assertable
    # against by anything a previous test (or a running server) may have
    # already written for a real symbol.
    universe = {
        name: SymbolProfile(name, "100.00", volatility=0.2, base_volume=1_000_000)
        for name in symbols
    }
    return ReplayProvider(universe=universe)


def _count(session, symbol: str) -> int:
    return session.execute(
        select(func.count())
        .select_from(MarketSnapshot)
        .where(MarketSnapshot.symbol == symbol)
    ).scalar_one()


class TestBackfillTargeting:
    def test_a_symbol_with_no_history_needs_backfill(self, session):
        assert symbols_without_history(session, ["ZZ_NEW"]) == ["ZZ_NEW"]

    def test_a_symbol_with_existing_history_is_skipped(self, session):
        ingest_quotes(
            session,
            [Quote("ZZ_SEEN", Decimal("50"), 1, NOW)],
            source="replay",
            historical=True,
        )

        assert symbols_without_history(session, ["ZZ_SEEN"]) == []

    def test_mixed_batch_returns_only_the_uncovered_symbols(self, session):
        ingest_quotes(
            session,
            [Quote("ZZ_COVERED", Decimal("50"), 1, NOW)],
            source="replay",
            historical=True,
        )

        assert symbols_without_history(
            session, ["ZZ_COVERED", "ZZ_UNCOVERED"]
        ) == ["ZZ_UNCOVERED"]


class TestRestartResumesCorrectly:
    def test_restart_sequence_does_not_duplicate_or_corrupt_history(self, session):
        """Pass 1: first-ever run for this symbol -- gets backfilled, then
        polled. Pass 2: the identical sequence, simulating a restart. Must be
        idempotent end to end: no duplicate rows, no regressed current price,
        and pass 2 must not re-backfill what pass 1 already covered.
        """
        provider = _provider("ZZ_RESTART")
        symbols = ["ZZ_RESTART"]

        fresh = symbols_without_history(session, symbols)
        assert fresh == symbols
        backfill(session, provider, fresh, NOW)
        poll_and_ingest(session, provider, symbols, NOW)

        count_after_pass_1 = _count(session, "ZZ_RESTART")
        assert count_after_pass_1 > 0
        price_after_pass_1 = session.get(LatestQuote, "ZZ_RESTART").price

        # --- simulated restart: identical sequence runs again ---
        fresh_again = symbols_without_history(session, symbols)
        assert fresh_again == [], (
            "a symbol with history must not be re-backfilled after a restart"
        )
        backfill(session, provider, fresh_again, NOW)  # no-op: nothing to do
        poll_and_ingest(session, provider, symbols, NOW)  # same `now` again

        assert _count(session, "ZZ_RESTART") == count_after_pass_1, (
            "re-running the pass at the same `now` must not add duplicate rows"
        )
        assert session.get(LatestQuote, "ZZ_RESTART").price == price_after_pass_1

    def test_collection_resumes_cleanly_after_a_gap(self, session):
        """After a real gap (the collector was down), the next successful
        pass must pick up from wherever `now` actually is when it resumes --
        not attempt to backfill the missed interval (there is nothing to
        legitimately fetch for "what the price was" during a stretch the
        provider was never polled) and not reject the newer tick as stale
        or out-of-order.
        """
        provider = _provider("ZZ_GAP")
        before_gap = NOW
        after_gap = NOW.replace(hour=15)  # a large jump = a stopped collector

        poll_and_ingest(session, provider, ["ZZ_GAP"], before_gap)
        result = poll_and_ingest(session, provider, ["ZZ_GAP"], after_gap)

        assert result.provider_failed is False
        assert result.inserted == 1
        assert result.out_of_order == 0
        latest = session.get(LatestQuote, "ZZ_GAP")
        assert latest.source_timestamp == after_gap
        # Both real, distinct ticks are on record; the gap between them is
        # implicit in their timestamps, not papered over or fabricated.
        assert _count(session, "ZZ_GAP") == 2
