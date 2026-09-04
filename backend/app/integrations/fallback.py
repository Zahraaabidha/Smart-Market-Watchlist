"""A provider wrapper that guarantees the product never goes dark.

`FallbackProvider` tries a primary provider (typically the live vendor) and,
on any `MarketDataError`, transparently serves from a fallback (the
deterministic replay provider). The wrapper records that a degradation
happened so the UI can say so honestly rather than presenting stale-or-simulated
data as if the live feed were healthy.

`.name` proxies to whichever provider actually served the last call, so the
`source` column on every persisted snapshot stays truthful even across a
mid-stream failover.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

from app.domain.models import Quote
from app.integrations.provider import MarketDataError, MarketDataProvider


class FallbackProvider(MarketDataProvider):
    def __init__(
        self, primary: MarketDataProvider, fallback: MarketDataProvider
    ) -> None:
        self.primary = primary
        self.fallback = fallback
        #: Which provider served the most recent successful call.
        self.active: MarketDataProvider = primary
        #: True when the last call fell through to the fallback.
        self.degraded = False
        self.degraded_reason: str | None = None

    @property
    def name(self) -> str:
        return self.active.name

    def fetch_current(self, symbols: Sequence[str], now: datetime) -> list[Quote]:
        try:
            quotes = self.primary.fetch_current(symbols, now)
            self._mark_healthy()
            return quotes
        except MarketDataError as exc:
            self._mark_degraded(exc)
            return self.fallback.fetch_current(symbols, now)

    def fetch_history(
        self, symbol: str, since: datetime, now: datetime
    ) -> list[Quote]:
        try:
            history = self.primary.fetch_history(symbol, since, now)
            self._mark_healthy()
            return history
        except MarketDataError as exc:
            self._mark_degraded(exc)
            return self.fallback.fetch_history(symbol, since, now)

    # --- status -------------------------------------------------------

    def _mark_healthy(self) -> None:
        self.active = self.primary
        self.degraded = False
        self.degraded_reason = None

    def _mark_degraded(self, exc: MarketDataError) -> None:
        self.active = self.fallback
        self.degraded = True
        self.degraded_reason = str(exc)
