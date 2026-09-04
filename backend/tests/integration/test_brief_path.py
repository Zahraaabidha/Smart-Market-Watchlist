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

    def test_a_real_ingestion_gap_is_flagged_not_bridged(self, session, user):
        """End-to-end regression for the "artificial straight-line segment"
        bug: seed a normal dense intraday run, then a genuine break in data
        collection (as if the ingestion loop was down), then a single fresh
        quote -- the exact shape RELIANCE/ZOMATO showed in production. The
        path must carry the gap honestly (flagged on the point after it, nothing
        invented to bridge it) rather than silently connecting through it.
        """
        symbol = "GAPSYM"

        # Dense run: two hours of real ticks at the actual ingestion cadence,
        # starting strictly after the checkpoint so there is no ambiguity
        # with the separate "anchor row at the window boundary" behaviour --
        # this test is about the gap, not that boundary case.
        dense = [
            Quote(
                symbol,
                Decimal("100") + Decimal(i % 7),
                1_000_000,
                T0 + timedelta(seconds=15 * (i + 1)),
            )
            for i in range(480)  # 480 * 15s = 2h
        ]
        dense_end = dense[-1].source_timestamp

        # A genuine gap: the ingestion loop was effectively down for 90
        # minutes -- no rows at all in this stretch, exactly like a real
        # process restart or provider outage.
        resume = dense_end + timedelta(minutes=90)
        current = Quote(symbol, Decimal("129.50"), 1_000_000, resume)

        ingest_quotes(session, [*dense, current], source="replay", historical=True)

        watchlist = _watchlist_with(session, user, symbol)
        wl.record_checkpoint(session, user, watchlist.id, T0, "cp")
        now = resume

        detail = build_symbol_path(session, watchlist, symbol, now)

        assert detail is not None
        assert len(detail.points) > 2  # the dense run actually came through

        flagged = [(t, p) for t, p, gap_before in detail.points if gap_before]
        assert len(flagged) == 1, (
            "exactly one break in the series must be flagged -- neither "
            "silently bridged nor split into more gaps than actually exist"
        )
        gap_t, gap_p = flagged[0]
        assert gap_t == resume
        # the flagged point's price is the real, received quote -- not an
        # interpolation between the pre-gap price and it.
        assert gap_p == Decimal("129.50")

        # Nothing before the gap is itself (mis)flagged.
        assert all(
            not gap_before for t, _, gap_before in detail.points if t < resume
        )

        # True values are untouched by the gap.
        assert detail.current_value == Decimal("129.50")
        assert detail.window_high == max(q.price for q in dense + [current])
        assert detail.window_low == min(q.price for q in dense + [current])
        assert detail.source == "replay"
