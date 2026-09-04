"""Market data provider boundary.

The application depends on this interface, never on a concrete vendor. Two
things sit behind it today: a deterministic replay provider used for demos and
tests, and a failing provider used to exercise degradation paths. A live vendor
implementation slots in here without any change above this layer.

`MarketDataError` is the only failure type callers must handle. Vendor-specific
exceptions are translated at the boundary so that a provider swap cannot leak
new error types into the service layer.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from datetime import datetime

from app.domain.models import Quote


class MarketDataError(RuntimeError):
    """The provider could not supply data. Callers must degrade, not crash."""


class MarketDataProvider(ABC):
    """Read-only access to market observations for a set of symbols."""

    #: Recorded on every snapshot so conflicting values from different vendors
    #: remain distinguishable in history.
    name: str = "abstract"

    @abstractmethod
    def fetch_current(self, symbols: Sequence[str], now: datetime) -> list[Quote]:
        """Latest known quote per symbol.

        Implementations must return partial results rather than failing wholly
        when only some symbols are unavailable: one bad symbol should not blank
        out an entire watchlist. Raise MarketDataError only when nothing at all
        could be fetched.
        """

    @abstractmethod
    def fetch_history(
        self, symbol: str, since: datetime, now: datetime
    ) -> list[Quote]:
        """Quotes for one symbol since a point in time, ascending by timestamp.

        Used to warm baselines and to reconstruct what happened while a user
        was away.
        """
