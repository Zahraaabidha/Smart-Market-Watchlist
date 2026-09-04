"""Request and response contracts.

Validation lives here so that malformed input is rejected at the edge, before
it reaches business logic or the database. Constraints mirror the database
CHECK constraints deliberately: the API gives a helpful message, the database
guarantees the invariant even if a future caller bypasses this layer.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

# bcrypt ignores input past 72 bytes, so the cap is a correctness bound rather
# than an arbitrary limit.
PASSWORD_MIN = 8
PASSWORD_MAX = 72


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=PASSWORD_MAX)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class PreferencesUpdate(BaseModel):
    min_move_pct: float | None = Field(default=None, gt=0, le=100)
    volume_sensitivity: float | None = Field(default=None, gt=0, le=50)
    swing_sensitivity: float | None = Field(default=None, gt=0, le=10)


class PreferencesResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    min_move_pct: float
    volume_sensitivity: float
    swing_sensitivity: float


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    created_at: datetime


class WatchlistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ItemCreate(BaseModel):
    symbol: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z0-9.\-&]+$")
    priority: int = Field(default=2, ge=1, le=3)
    threshold_above: Decimal | None = Field(default=None, gt=0)
    threshold_below: Decimal | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _bands_must_be_ordered(self) -> "ItemCreate":
        if (
            self.threshold_above is not None
            and self.threshold_below is not None
            and self.threshold_above <= self.threshold_below
        ):
            raise ValueError("threshold_above must be greater than threshold_below")
        return self


class ItemUpdate(BaseModel):
    priority: int | None = Field(default=None, ge=1, le=3)
    threshold_above: Decimal | None = Field(default=None, gt=0)
    threshold_below: Decimal | None = Field(default=None, gt=0)


class ItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    symbol: str
    priority: int
    position: int
    threshold_above: Decimal | None
    threshold_below: Decimal | None


class WatchlistResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    created_at: datetime
    updated_at: datetime
    items: list[ItemResponse]


class ReorderRequest(BaseModel):
    item_ids: list[int] = Field(min_length=1)


class CheckpointRequest(BaseModel):
    # Supplied by the client so a retried or double-tapped request cannot
    # create two checkpoints and collapse the comparison window to nothing.
    idempotency_key: str | None = Field(default=None, max_length=64)


class CheckpointResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    checked_at: datetime


class ReasonResponse(BaseModel):
    code: str
    text: str
    contribution: float


class PathPoint(BaseModel):
    t: datetime
    price: Decimal


class PricePath(BaseModel):
    """The route a price took across the user's absence window.

    `window_high` / `window_low` are the intra-window extremes the engine
    scores against; surfacing them lets the UI mark the peak of a swing that an
    endpoint comparison would hide.
    """

    points: list[PathPoint]
    checkpoint_at: datetime | None
    checkpoint_price: Decimal
    window_high: Decimal
    window_low: Decimal
    window_start: datetime
    window_end: datetime


class ChangeResponse(BaseModel):
    symbol: str
    change_type: str
    severity: str
    score: float
    previous_value: Decimal
    current_value: Decimal
    change_pct: float
    occurred_at: datetime
    source_timestamp: datetime
    freshness: str
    priority: int
    reasons: list[ReasonResponse]
    # Present for attention items only; the quiet list has nothing to plot.
    source: str | None = None
    path: PricePath | None = None


class BriefResponse(BaseModel):
    watchlist_id: int
    watchlist_name: str
    last_checked_at: datetime | None
    generated_at: datetime
    monitored_count: int
    meaningful_count: int
    attention: list[ChangeResponse]
    quiet: list[ChangeResponse]
    unavailable_symbols: list[str]
    overall_freshness: str
    window_truncated: bool
    # The source actually behind the data shown ("replay", "twelvedata", ...).
    market_source: str
    degraded: bool = False


class SymbolPathResponse(PricePath):
    """Full-resolution path plus the data-trust fields for the detail view."""

    symbol: str
    current_value: Decimal
    source: str
    source_timestamp: datetime
    received_at: datetime | None
    freshness: str
    last_checked_at: datetime | None


class MarketSourceResponse(BaseModel):
    provider: str
    mode: str
    degraded: bool
    degraded_reason: str | None
    last_poll_at: datetime | None
    last_success_at: datetime | None
    demo_mode: bool


class DemoProviderRequest(BaseModel):
    mode: str = Field(pattern=r"^(replay|failing|live)$")


class TimelineEntry(BaseModel):
    """A change that was surfaced to the user at some past checkpoint."""

    id: int
    symbol: str
    change_type: str
    severity: str
    score: float
    previous_value: Decimal
    current_value: Decimal
    change_pct: float
    detected_at: datetime
    source_timestamp: datetime
    freshness: str
    reasons: list[ReasonResponse]
