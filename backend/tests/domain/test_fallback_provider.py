"""FallbackProvider keeps the product alive when the primary provider dies."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone

from app.domain.models import Quote
from app.integrations.fallback import FallbackProvider
from app.integrations.provider import MarketDataError, MarketDataProvider
from app.integrations.replay import ReplayProvider

NOW = datetime(2026, 1, 8, 12, 0, 0, tzinfo=timezone.utc)


class _Primary(MarketDataProvider):
    name = "primary"

    def __init__(self) -> None:
        self.up = True

    def fetch_current(self, symbols: Sequence[str], now: datetime) -> list[Quote]:
        if not self.up:
            raise MarketDataError("primary down")
        return [Quote("X", price=_d(1), volume=1, source_timestamp=now)]

    def fetch_history(self, symbol: str, since: datetime, now: datetime) -> list[Quote]:
        if not self.up:
            raise MarketDataError("primary down")
        return []


def _d(v):
    from decimal import Decimal

    return Decimal(v)


def test_serves_primary_while_healthy() -> None:
    fp = FallbackProvider(_Primary(), ReplayProvider())
    quotes = fp.fetch_current(["X"], NOW)

    assert [q.symbol for q in quotes] == ["X"]
    assert fp.degraded is False
    assert fp.name == "primary"


def test_falls_through_and_reports_degraded() -> None:
    primary = _Primary()
    fp = FallbackProvider(primary, ReplayProvider())

    primary.up = False
    quotes = fp.fetch_current(["RELIANCE"], NOW)

    assert quotes, "fallback should have supplied replay quotes"
    assert fp.degraded is True
    assert fp.degraded_reason and "primary down" in fp.degraded_reason
    assert fp.name == "replay"


def test_recovers_when_primary_comes_back() -> None:
    primary = _Primary()
    fp = FallbackProvider(primary, ReplayProvider())

    primary.up = False
    fp.fetch_current(["RELIANCE"], NOW)
    primary.up = True
    fp.fetch_current(["X"], NOW)

    assert fp.degraded is False
    assert fp.name == "primary"
