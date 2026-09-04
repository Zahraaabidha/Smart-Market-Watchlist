"""Tests for the deterministic replay provider.

Determinism is the property everything else depends on. If these fail, the
demo is not reproducible and the integration tests are not trustworthy.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.integrations.provider import MarketDataError
from app.integrations.replay import EPOCH, TICK, FailingProvider, ReplayProvider

NOW = EPOCH + timedelta(hours=6)


class TestDeterminism:
    def test_same_seed_and_time_yields_identical_quotes(self):
        a = ReplayProvider(seed=42).fetch_current(["RELIANCE", "TCS"], NOW)
        b = ReplayProvider(seed=42).fetch_current(["RELIANCE", "TCS"], NOW)

        assert a == b

    def test_different_seeds_diverge(self):
        a = ReplayProvider(seed=1).fetch_current(["RELIANCE"], NOW)[0]
        b = ReplayProvider(seed=2).fetch_current(["RELIANCE"], NOW)[0]

        assert a.price != b.price

    def test_history_is_computable_without_replaying_from_the_start(self):
        """A late tick must not depend on having generated earlier ones."""
        provider = ReplayProvider(seed=7)
        far = EPOCH + timedelta(days=30)

        direct = provider.fetch_current(["INFY"], far)[0]
        after_warmup = provider.fetch_current(["INFY"], far)[0]

        assert direct == after_warmup

    def test_repeated_polls_within_one_tick_share_a_timestamp(self):
        """The property that makes ingestion naturally idempotent.

        Two polls five seconds apart inside the same 15s tick must produce the
        same source_timestamp, so the unique constraint collapses them instead
        of writing a duplicate observation.
        """
        provider = ReplayProvider(seed=3)
        first = provider.fetch_current(["ITC"], NOW)[0]
        second = provider.fetch_current(["ITC"], NOW + timedelta(seconds=5))[0]

        assert first.source_timestamp == second.source_timestamp
        assert first == second


class TestQuoteValidity:
    def test_prices_stay_positive_over_a_long_horizon(self):
        """The schema forbids non-positive prices; the generator must comply."""
        provider = ReplayProvider(seed=11)
        for days in (1, 30, 200, 400):
            quotes = provider.fetch_current(list(provider.universe), EPOCH + timedelta(days=days))
            assert quotes, f"no quotes at day {days}"
            assert all(q.price > 0 for q in quotes)

    def test_volume_is_non_negative(self):
        provider = ReplayProvider(seed=11)
        quotes = provider.fetch_current(list(provider.universe), NOW)

        assert all(q.volume >= 0 for q in quotes)

    def test_history_is_ascending_by_timestamp(self):
        provider = ReplayProvider(seed=5)
        history = provider.fetch_history("SBIN", NOW - timedelta(hours=2), NOW)

        stamps = [q.source_timestamp for q in history]
        assert stamps == sorted(stamps)
        assert len(stamps) == len(set(stamps))

    def test_volatile_symbol_moves_more_than_a_calm_one(self):
        """Per-symbol baselines only mean something if symbols actually differ."""
        provider = ReplayProvider(seed=9)
        window_start = NOW - timedelta(hours=3)

        def spread(symbol: str) -> float:
            history = provider.fetch_history(symbol, window_start, NOW)
            prices = [float(q.price) for q in history]
            return (max(prices) - min(prices)) / min(prices)

        assert spread("ZOMATO") > spread("ITC")


class TestPartialAndTotalFailure:
    def test_unknown_symbol_is_omitted_not_fatal(self):
        provider = ReplayProvider()
        quotes = provider.fetch_current(["RELIANCE", "NOT_A_REAL_SYMBOL"], NOW)

        assert [q.symbol for q in quotes] == ["RELIANCE"]

    def test_failing_symbol_does_not_blank_the_rest_of_the_watchlist(self):
        provider = ReplayProvider()
        provider.failing_symbols.add("TCS")

        quotes = provider.fetch_current(["RELIANCE", "TCS", "INFY"], NOW)

        assert {q.symbol for q in quotes} == {"RELIANCE", "INFY"}

    def test_total_outage_raises_the_boundary_error_type(self):
        provider = ReplayProvider()
        provider.available = False

        with pytest.raises(MarketDataError):
            provider.fetch_current(["RELIANCE"], NOW)

    def test_failing_provider_raises_on_both_methods(self):
        provider = FailingProvider()

        with pytest.raises(MarketDataError):
            provider.fetch_current(["RELIANCE"], NOW)
        with pytest.raises(MarketDataError):
            provider.fetch_history("RELIANCE", NOW - timedelta(hours=1), NOW)


class TestHistoryEdgeCases:
    def test_inverted_range_returns_empty_rather_than_raising(self):
        provider = ReplayProvider()
        history = provider.fetch_history("INFY", NOW, NOW - timedelta(hours=1))

        assert history == []

    def test_absurd_range_is_bounded(self):
        """A pathological request must not exhaust memory."""
        provider = ReplayProvider()
        history = provider.fetch_history("INFY", EPOCH, EPOCH + timedelta(days=3650))

        assert len(history) <= 5001

    def test_empty_symbol_list_yields_no_quotes(self):
        assert ReplayProvider().fetch_current([], NOW) == []
