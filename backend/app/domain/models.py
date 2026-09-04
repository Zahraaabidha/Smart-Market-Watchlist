"""Pure domain value objects.

These deliberately mirror -- but do not import -- the persistence models.
The change engine operates on these alone, so it can be exercised in tests
with no database, no ORM session and no I/O.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import Enum


class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    NOTABLE = "notable"
    QUIET = "quiet"


# Below this many observations a baseline is treated as unreliable and the
# "unusual for this stock" signal is withheld rather than guessed at.
MIN_BASELINE_SAMPLES = 5


class ChangeType(str, Enum):
    PRICE_MOVE = "price_move"
    UNUSUAL_MOVE = "unusual_move"
    VOLUME_ANOMALY = "volume_anomaly"
    THRESHOLD_CROSS = "threshold_cross"
    INTRAWINDOW_SWING = "intrawindow_swing"


@dataclass(frozen=True)
class Quote:
    """A single observed market state for a symbol at a point in time."""

    symbol: str
    price: Decimal
    volume: int
    source_timestamp: datetime


@dataclass(frozen=True)
class Baseline:
    """Historical statistics used to judge whether a move is *unusual*.

    Computed from a warm-up window of prior sessions. `sample_size` is carried
    so the engine can refuse to draw conclusions from too little history
    rather than silently treating noise as signal.
    """

    symbol: str
    mean_abs_return_pct: float
    stdev_return_pct: float
    mean_volume: float
    sample_size: int

    @property
    def is_reliable(self) -> bool:
        return self.sample_size >= MIN_BASELINE_SAMPLES and self.stdev_return_pct > 0


@dataclass(frozen=True)
class AttentionPreferences:
    """What this user has said they care about.

    Kept deliberately small. Every field here must change ranking in a way the
    user can predict, otherwise it is a setting that exists to look
    configurable rather than to be used.
    """

    min_move_pct: float = 2.0
    volume_sensitivity: float = 2.0  # multiples of baseline volume
    swing_sensitivity: float = 1.5   # multiplier on min_move_pct for round trips

    @staticmethod
    def default() -> "AttentionPreferences":
        return AttentionPreferences()


@dataclass(frozen=True)
class WatchedSymbol:
    """A symbol on a watchlist, with the user's per-symbol configuration."""

    symbol: str
    priority: int = 2  # 1 = highest attention, 3 = lowest
    threshold_above: Decimal | None = None
    threshold_below: Decimal | None = None


@dataclass(frozen=True)
class Reason:
    """One human-readable justification for surfacing a change.

    `contribution` is the number of points this signal added to the final
    score, so the UI can show not just *why* something surfaced but how much
    each factor mattered. This is what replaces an opaque confidence number.
    """

    code: str
    text: str
    contribution: float


@dataclass(frozen=True)
class DetectedChange:
    symbol: str
    change_type: ChangeType
    severity: Severity
    score: float
    previous_value: Decimal
    current_value: Decimal
    change_pct: float
    occurred_at: datetime
    reasons: list[Reason]
    source_timestamp: datetime
    freshness: str
    priority: int
