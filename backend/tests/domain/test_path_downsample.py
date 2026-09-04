"""The path downsampler must never drop the point the path exists to show."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.domain.models import Quote
from app.services.brief import _build_path, _downsample, _gap_threshold

BASE = datetime(2026, 9, 4, 10, 0, 0, tzinfo=timezone.utc)


def _series(prices: list[str], step_seconds: int = 15) -> list[Quote]:
    return [
        Quote(
            symbol="TEST",
            price=Decimal(p),
            volume=1_000,
            source_timestamp=BASE + timedelta(seconds=step_seconds * i),
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


# ── gap detection ─────────────────────────────────────────────────────────
#
# Regression coverage for the "artificial straight-line segment" bug: a real
# break in data collection (the ingestion loop was down, a provider outage)
# must be visible to the client as `gap_before=True` on the point right after
# it, so the chart can refuse to draw a connecting line across it -- and,
# just as importantly, downsampling a long-but-genuinely-continuous series
# must never be mistaken for one, no matter how far apart the *kept* points
# end up.


def _points(quotes: list[Quote], cap: int):
    """`_build_path` output points, independent of the checkpoint/window args
    this test file has no opinion on."""
    return _build_path(
        quotes,
        checkpoint_at=quotes[0].source_timestamp,
        window_start=quotes[0].source_timestamp,
        window_end=quotes[-1].source_timestamp,
        cap=cap,
    ).points


def test_dense_intraday_series_has_no_gaps() -> None:
    """The exact regression this bug report is about: a multi-hour intraday
    series with real ticks throughout must not acquire an artificial
    straight segment -- i.e. no point may be flagged as following a gap --
    even after being downsampled down to a small cap.
    """
    # 24 hours at the configured 15s cadence: ~5,760 raw points, downsampled
    # to the same cap the detail endpoint actually uses. The average stride
    # between *kept* points (~360s) comfortably exceeds the gap threshold
    # (180s) on its own -- proving that downsampling-induced spacing is not
    # what triggers a gap flag; only a real hole in the underlying data is.
    n = int(timedelta(hours=24) / timedelta(seconds=15))
    series = _series([str(100 + (i % 11) * 0.1) for i in range(n)], step_seconds=15)
    assert (series[-1].source_timestamp - series[0].source_timestamp) >= timedelta(
        hours=23
    )

    points = _points(series, cap=240)

    assert len(points) > 50  # actually exercised the downsampler
    assert all(gap_before is False for _, _, gap_before in points)


def test_a_real_gap_is_flagged_on_the_point_after_it() -> None:
    """A genuine break in collection -- e.g. the ingestion loop was down for
    90 minutes -- must be marked on exactly the point that follows it, and
    on no other point, so the frontend can break the line there instead of
    drawing straight through the silence.
    """
    threshold = _gap_threshold()
    before = _series([str(100 + i) for i in range(20)], step_seconds=15)
    gap_start = before[-1].source_timestamp
    resume = gap_start + threshold + timedelta(minutes=1)
    after = [
        Quote("TEST", Decimal(str(150 + i)), 1_000, resume + timedelta(seconds=15 * i))
        for i in range(20)
    ]
    series = before + after

    points = _points(series, cap=240)  # well above len(series); no downsampling

    flagged = [i for i, (_, _, gap_before) in enumerate(points) if gap_before]
    assert flagged == [len(before)]  # exactly the first point after the gap
    # the two real points straddling the gap are exactly what the input had --
    # nothing was invented to bridge them.
    assert points[len(before) - 1][1] == before[-1].price
    assert points[len(before)][1] == after[0].price
    assert points[len(before)][0] == resume


def test_a_real_gap_survives_downsampling() -> None:
    """The same gap, but inside a series long enough that the cap actually
    thins it -- the flag must still land exactly once, on the real point
    that follows the real gap, not smeared across whatever downsampling
    happens to keep nearby.
    """
    threshold = _gap_threshold()
    before = _series([str(100 + (i % 9) * 0.1) for i in range(3000)], step_seconds=15)
    gap_start = before[-1].source_timestamp
    resume = gap_start + threshold + timedelta(minutes=5)
    after = _series(
        [str(150 + (i % 9) * 0.1) for i in range(3000)], step_seconds=15
    )
    after = [
        Quote("TEST", q.price, 1_000, resume + timedelta(seconds=15 * i))
        for i, q in enumerate(after)
    ]
    series = before + after

    points = _points(series, cap=240)

    flagged_times = [t for t, _, gap_before in points if gap_before]
    # Exactly one break in a series that has exactly one real gap in it --
    # downsampling must neither erase the real gap nor fabricate extra ones
    # out of the wide spacing it introduces elsewhere in the series.
    assert len(flagged_times) == 1
    assert flagged_times[0] >= resume
    # and it lands on the post-gap side, not deep into the (also downsampled,
    # also widely-spaced) stable data that follows it.
    assert flagged_times[0] < resume + timedelta(hours=1)
