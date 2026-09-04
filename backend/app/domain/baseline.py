"""Baseline statistics: what is *normal* for a given symbol.

A 3% move means something very different for a utility than for a small-cap
that routinely swings 8%. Judging every symbol against one global threshold
is the main reason naive watchlists cry wolf, so the engine compares each
move against that symbol's own recent behaviour.
"""

from __future__ import annotations

import statistics
from collections.abc import Sequence

from app.domain.models import Baseline, Quote


def compute_baseline(symbol: str, history: Sequence[Quote]) -> Baseline:
    """Derive normal-behaviour statistics from a warm-up window of quotes.

    History is expected in ascending source_timestamp order. Returns a
    baseline with sample_size 0 when there is not enough data to say anything,
    which callers must check via `is_reliable` before drawing conclusions.
    """
    if len(history) < 2:
        return Baseline(symbol, 0.0, 0.0, 0.0, 0)

    returns_pct: list[float] = []
    for previous, current in zip(history, history[1:]):
        if previous.price == 0:
            continue
        pct = float((current.price - previous.price) / previous.price) * 100.0
        returns_pct.append(pct)

    if not returns_pct:
        return Baseline(symbol, 0.0, 0.0, 0.0, 0)

    volumes = [q.volume for q in history if q.volume > 0]
    mean_volume = statistics.fmean(volumes) if volumes else 0.0

    mean_abs = statistics.fmean(abs(r) for r in returns_pct)
    # Population stdev: this is the full observed warm-up window, not a sample
    # drawn from it, and it stays defined for a two-point history.
    stdev = statistics.pstdev(returns_pct) if len(returns_pct) >= 2 else 0.0

    return Baseline(
        symbol=symbol,
        mean_abs_return_pct=mean_abs,
        stdev_return_pct=stdev,
        mean_volume=mean_volume,
        sample_size=len(returns_pct),
    )
