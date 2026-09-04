"""The path downsampler must never drop the point the path exists to show."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.domain.models import Quote
from app.services.brief import _downsample

BASE = datetime(2026, 9, 4, 10, 0, 0, tzinfo=timezone.utc)


def _series(prices: list[str]) -> list[Quote]:
    return [
        Quote(
            symbol="TEST",
            price=Decimal(p),
            volume=1_000,
            source_timestamp=BASE + timedelta(seconds=15 * i),
        )
        for i, p in enumerate(prices)
    ]


def test_short_series_is_returned_unchanged() -> None:
    series = _series(["100", "101", "102"])
    assert _downsample(series, cap=10) == series


def test_respects_the_cap_with_a_margin_for_pinned_points() -> None:
    series = _series([str(100 + (i % 7)) for i in range(500)])
    out = _downsample(series, cap=56)
    # cap sampled points plus at most 4 pinned (first, last, high, low).
    assert len(out) <= 56 + 4


def test_keeps_the_true_high_and_low() -> None:
    prices = [str(100 + (i % 5)) for i in range(400)]
    prices[137] = "175.00"  # lone spike
    prices[298] = "42.00"   # lone trough
    series = _series(prices)

    out = _downsample(series, cap=20)
    out_prices = {q.price for q in out}

    assert Decimal("175.00") in out_prices
    assert Decimal("42.00") in out_prices
    # endpoints too
    assert out[0] == series[0]
    assert out[-1] == series[-1]


def test_output_stays_in_chronological_order() -> None:
    series = _series([str(100 + (i * 7 % 40)) for i in range(300)])
    out = _downsample(series, cap=30)
    times = [q.source_timestamp for q in out]
    assert times == sorted(times)
    assert len(times) == len(set(times))
