"""The price path attached to attention cards, and the detail endpoint.

These assert the product's signature: an endpoint comparison shows where a
price ended, the path shows the route it took -- including an intra-window
extreme that a last-price comparison would hide.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.domain.models import Quote
from app.services import watchlists as wl
from app.services.brief import build_brief, build_symbol_path
from app.services.ingestion import ingest_quotes

T0 = datetime(2026, 9, 4, 9, 0, 0, tzinfo=timezone.utc)


def _seed_swing(session, symbol: str) -> datetime:
    """A round trip: 100 -> 108 peak -> settle at 101. Returns `now`.

    Endpoint move is +1% (quiet), peak excursion is +8% (a swing worth
    surfacing).
    """
    prices = ["100", "103", "106", "108", "105", "102", "101"]
    quotes = [
        Quote(
            symbol=symbol,
            price=Decimal(p),
            volume=1_000_000,
            source_timestamp=T0 + timedelta(minutes=10 * i),
        )
        for i, p in enumerate(prices)
    ]
    # An anchor strictly before the checkpoint so the window starts at 100.
    anchor = Quote(symbol, Decimal("100"), 1_000_000, T0 - timedelta(minutes=5))
    ingest_quotes(session, [anchor, *quotes], source="replay", historical=True)
    return quotes[-1].source_timestamp


def _watchlist_with(session, user, symbol: str):
    watchlist = wl.create_watchlist(session, user, "T")
    wl.add_item(session, user, watchlist.id, symbol)
    return wl.get_owned_watchlist(session, user, watchlist.id)


class TestBriefPath:
    def test_attention_card_carries_a_path_with_the_true_extreme(self, session, user):
        now = _seed_swing(session, "SWNG")
        watchlist = _watchlist_with(session, user, "SWNG")
        wl.record_checkpoint(session, user, watchlist.id, T0, "cp")

        result = build_brief(session, user, watchlist, now)

        assert [c.symbol for c in result.attention] == ["SWNG"]
        path = result.paths["SWNG"]
        assert path.window_high == Decimal("108")
        assert path.checkpoint_price == Decimal("100")
        # endpoint settled well below the peak -- the thing the path exists to show
        assert result.attention[0].current_value == Decimal("101")
        assert path.checkpoint_at == T0
        assert len(path.points) >= 2
        assert path.points[0][0] <= T0

    def test_quiet_items_have_no_path(self, session, user):
        # A genuinely flat series: nothing to surface, nothing to plot.
        flat = [
            Quote("FLATSYM", Decimal("100"), 1_000_000, T0 - timedelta(minutes=5)),
            *[
                Quote(
                    "FLATSYM",
                    Decimal("100"),
                    1_000_000,
                    T0 + timedelta(minutes=10 * i),
                )
                for i in range(1, 7)
            ],
        ]
        ingest_quotes(session, flat, source="replay", historical=True)
        watchlist = _watchlist_with(session, user, "FLATSYM")
        wl.record_checkpoint(session, user, watchlist.id, T0, "cp")
        now = T0 + timedelta(minutes=60)

        result = build_brief(session, user, watchlist, now)

        assert result.attention == []
        assert "FLATSYM" not in result.paths

    def test_market_source_reflects_the_stored_snapshot_source(self, session, user):
        now = _seed_swing(session, "SRC")
        watchlist = _watchlist_with(session, user, "SRC")
        wl.record_checkpoint(session, user, watchlist.id, T0, "cp")

        result = build_brief(session, user, watchlist, now)

        assert result.market_source == "replay"


class TestSymbolPathDetail:
    def test_detail_path_has_markers_and_trust_fields(self, session, user):
        now = _seed_swing(session, "DTL")
        watchlist = _watchlist_with(session, user, "DTL")
        wl.record_checkpoint(session, user, watchlist.id, T0, "cp")

        detail = build_symbol_path(session, watchlist, "DTL", now)

        assert detail is not None
        assert detail.symbol == "DTL"
        assert detail.window_high == Decimal("108")
        assert detail.window_low == Decimal("100")
        assert detail.current_value == Decimal("101")
        assert detail.source == "replay"
        assert detail.received_at is not None
        assert detail.freshness == "fresh"
        assert detail.last_checked_at == T0

    def test_detail_path_is_none_when_nothing_on_record(self, session, user):
        watchlist = _watchlist_with(session, user, "EMPTY")
        wl.record_checkpoint(session, user, watchlist.id, T0, "cp")

        assert build_symbol_path(session, watchlist, "EMPTY", datetime.now(timezone.utc)) is None
