"""Database schema.

Two structural decisions carry most of the reliability story:

1. `market_snapshots` is APPEND-ONLY and uniquely keyed on
   (source, symbol, source_timestamp). Duplicate feed events collapse on
   insert; nothing is ever mutated in place, so history stays reconstructable.

2. `latest_quotes` is a separate projection of "current state per symbol",
   updated only when the incoming source_timestamp is strictly newer. This is
   what makes out-of-order events safe: a late-arriving old tick is still
   recorded in history but can never regress what we consider current.

Splitting these means the append path and the read path have different
correctness rules, which is exactly right -- history wants completeness,
current state wants recency.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


TS = DateTime(timezone=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())

    # Attention preferences live on the user rather than in a settings table.
    # There are three of them and they are always read together; a separate
    # table would add a join to every brief for no benefit.
    min_move_pct: Mapped[float] = mapped_column(Numeric(6, 2), default=2.0)
    volume_sensitivity: Mapped[float] = mapped_column(Numeric(6, 2), default=2.0)
    swing_sensitivity: Mapped[float] = mapped_column(Numeric(6, 2), default=1.5)

    watchlists: Mapped[list["Watchlist"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("min_move_pct > 0", name="ck_users_min_move_positive"),
        CheckConstraint(
            "volume_sensitivity > 0", name="ck_users_volume_sensitivity_positive"
        ),
        CheckConstraint(
            "swing_sensitivity > 0", name="ck_users_swing_sensitivity_positive"
        ),
    )


class Watchlist(Base):
    __tablename__ = "watchlists"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        TS, server_default=func.now(), onupdate=_utcnow
    )

    user: Mapped[User] = relationship(back_populates="watchlists")
    items: Mapped[list["WatchlistItem"]] = relationship(
        back_populates="watchlist",
        cascade="all, delete-orphan",
        order_by="WatchlistItem.position",
    )

    __table_args__ = (
        # A user cannot have two watchlists with the same name. Prevents the
        # duplicate-submit case from silently creating twins.
        UniqueConstraint("user_id", "name", name="uq_watchlists_user_name"),
    )


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    watchlist_id: Mapped[int] = mapped_column(
        ForeignKey("watchlists.id", ondelete="CASCADE"), nullable=False, index=True
    )
    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    threshold_above: Mapped[float | None] = mapped_column(Numeric(18, 4))
    threshold_below: Mapped[float | None] = mapped_column(Numeric(18, 4))
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())

    watchlist: Mapped[Watchlist] = relationship(back_populates="items")

    __table_args__ = (
        # Adding the same symbol twice is a no-op at the database level, which
        # makes the add-symbol endpoint naturally idempotent.
        UniqueConstraint("watchlist_id", "symbol", name="uq_items_watchlist_symbol"),
        CheckConstraint("priority BETWEEN 1 AND 3", name="ck_items_priority_range"),
        CheckConstraint(
            "threshold_above IS NULL OR threshold_above > 0",
            name="ck_items_threshold_above_positive",
        ),
        CheckConstraint(
            "threshold_below IS NULL OR threshold_below > 0",
            name="ck_items_threshold_below_positive",
        ),
        # An impossible alert band is rejected by the database, not just by
        # request validation.
        CheckConstraint(
            "threshold_above IS NULL OR threshold_below IS NULL "
            "OR threshold_above > threshold_below",
            name="ck_items_threshold_band_ordered",
        ),
    )


class MarketSnapshot(Base):
    """Append-only record of every market observation we have received."""

    __tablename__ = "market_snapshots"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    price: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    volume: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    source: Mapped[str] = mapped_column(String(40), nullable=False)
    source_timestamp: Mapped[datetime] = mapped_column(TS, nullable=False)
    received_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    # True when this arrived after a newer tick for the same symbol. Kept for
    # observability rather than discarded, so feed quality is measurable.
    out_of_order: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    __table_args__ = (
        # The idempotency guarantee for ingestion: replaying the same feed
        # event any number of times inserts exactly one row.
        UniqueConstraint(
            "source", "symbol", "source_timestamp", name="uq_snapshot_identity"
        ),
        CheckConstraint("price > 0", name="ck_snapshot_price_positive"),
        CheckConstraint("volume >= 0", name="ck_snapshot_volume_non_negative"),
        # The window query behind every brief is "this symbol, since time T,
        # newest last". This index serves it directly.
        Index("ix_snapshots_symbol_time", "symbol", "source_timestamp"),
    )


class LatestQuote(Base):
    """Current known state per symbol.

    A projection, not a source of truth -- it can always be rebuilt from
    market_snapshots. Exists so the brief does not need a correlated
    "max(source_timestamp) per symbol" subquery on every read.
    """

    __tablename__ = "latest_quotes"

    symbol: Mapped[str] = mapped_column(String(20), primary_key=True)
    price: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    volume: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    source: Mapped[str] = mapped_column(String(40), nullable=False)
    source_timestamp: Mapped[datetime] = mapped_column(TS, nullable=False)
    received_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())

    __table_args__ = (
        CheckConstraint("price > 0", name="ck_latest_price_positive"),
    )


class UserCheckpoint(Base):
    """A moment the user last saw their market.

    Append-only. The brief compares against the most recent checkpoint, and
    keeping the history means "what changed between Tuesday and Thursday"
    stays answerable.
    """

    __tablename__ = "user_checkpoints"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    watchlist_id: Mapped[int] = mapped_column(
        ForeignKey("watchlists.id", ondelete="CASCADE"), nullable=False
    )
    checked_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    # Supplied by the client so a double-submitted "mark as read" cannot
    # destroy the since-last-check window by creating two checkpoints.
    idempotency_key: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        UniqueConstraint(
            "watchlist_id", "idempotency_key", name="uq_checkpoint_idempotency"
        ),
        Index("ix_checkpoints_watchlist_time", "watchlist_id", "checked_at"),
    )


class MeaningfulChange(Base):
    """A persisted detection, so the timeline survives beyond one request.

    The engine is deterministic and could recompute this on demand, but
    storing detections gives the user a stable history that does not shift
    under them as older snapshots age out of the baseline window.
    """

    __tablename__ = "meaningful_changes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    watchlist_item_id: Mapped[int] = mapped_column(
        ForeignKey("watchlist_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    checkpoint_id: Mapped[int | None] = mapped_column(
        ForeignKey("user_checkpoints.id", ondelete="SET NULL")
    )
    detected_at: Mapped[datetime] = mapped_column(TS, nullable=False)
    change_type: Mapped[str] = mapped_column(String(40), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    score: Mapped[float] = mapped_column(Numeric(6, 2), nullable=False)
    previous_value: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    current_value: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    change_pct: Mapped[float] = mapped_column(Numeric(10, 4), nullable=False)
    # The reason list, stored as JSON text. Read as an opaque blob and never
    # queried by field, so a JSON column would buy nothing over text here.
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    source_timestamp: Mapped[datetime] = mapped_column(TS, nullable=False)
    freshness: Mapped[str] = mapped_column(String(20), nullable=False)

    __table_args__ = (
        CheckConstraint("score >= 0 AND score <= 100", name="ck_change_score_range"),
        CheckConstraint(
            "severity IN ('critical','high','notable','quiet')",
            name="ck_change_severity_valid",
        ),
        Index("ix_changes_item_detected", "watchlist_item_id", "detected_at"),
    )
