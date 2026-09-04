"""The Meaningful Change Engine.

Design contract, in order of importance:

1. DETERMINISTIC. Output is a pure function of the arguments. No clock reads,
   no randomness, no I/O, no database. `now` is always injected.
2. EXPLAINABLE. Every point of score comes from exactly one named signal that
   carries its own sentence. The score is the sum of its explanations, so the
   UI can never show a number it cannot justify.
3. CONSERVATIVE. When data is missing or a baseline is unreliable, the engine
   withholds the signal rather than guessing. Silence beats a false alert in a
   product whose entire value proposition is "we only tell you what matters".

Scoring is an additive model over normalised signals, scaled by user priority
and by how much we trust the data's freshness. Additive (rather than
multiplicative or learned) is a deliberate choice: it is the only form where
"this alert scored 62" decomposes into a list a human can read back.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime
from decimal import Decimal

from app.domain import freshness as fresh
from app.domain.models import (
    AttentionPreferences,
    Baseline,
    ChangeType,
    DetectedChange,
    Quote,
    Reason,
    Severity,
    WatchedSymbol,
)

# --- Scoring constants -------------------------------------------------
# These are the tuning surface of the whole product. They live together, as
# named constants, so the model can be explained and adjusted in one place
# rather than being scattered as magic numbers through the logic.

# The user's own threshold is by definition the line where they said a move
# starts mattering, so exactly meeting it must land at the bottom of the
# attention list rather than below it. W_MOVE_MIN therefore sits just above the
# NOTABLE band, and the contribution grows to W_MOVE_MAX at CAP_MOVE times the
# threshold. A flat weight scaled from zero -- the obvious formulation -- gives
# a threshold-meeting move only a third of its weight, so a user who asks about
# 2% moves is told nothing happened when a stock moves 2.9%.
W_MOVE_MIN = 26.0
W_MOVE_MAX = 48.0
W_UNUSUAL = 28.0     # move relative to this symbol's normal volatility
W_VOLUME = 18.0      # conviction behind the move
W_THRESHOLD = 34.0   # an explicit line the user drew was crossed
# Weighted to clear the NOTABLE band on its own. A swing fires precisely when
# the endpoint move is small, so the move signal is silent by construction and
# there is nothing else to add to it -- any lower and this signal could never
# surface the very case it exists to catch.
W_SWING = 34.0

# Ceilings stop one extreme signal from saturating the whole score and hiding
# the others. A 40-sigma print should not erase the fact that volume was also
# unusual.
CAP_MOVE = 3.0
CAP_UNUSUAL = 4.0
CAP_VOLUME = 3.0
CAP_SWING = 3.0

# Minimum bars at which each relative signal is considered to have fired.
SIGMA_TRIGGER = 2.0

# Priority multipliers. Priority 1 means "wake me for this one".
PRIORITY_MULTIPLIER = {1: 1.25, 2: 1.0, 3: 0.8}

# Severity bands over the final 0-100 score.
SEVERITY_CRITICAL = 70.0
SEVERITY_HIGH = 45.0
SEVERITY_NOTABLE = 25.0


def _pct_change(previous: Decimal, current: Decimal) -> float:
    if previous == 0:
        return 0.0
    return float((current - previous) / previous) * 100.0


def _severity_for(score: float) -> Severity:
    if score >= SEVERITY_CRITICAL:
        return Severity.CRITICAL
    if score >= SEVERITY_HIGH:
        return Severity.HIGH
    if score >= SEVERITY_NOTABLE:
        return Severity.NOTABLE
    return Severity.QUIET


def _fmt(value: float, places: int = 1) -> str:
    return f"{value:.{places}f}"


def evaluate_symbol(
    watched: WatchedSymbol,
    checkpoint_quote: Quote,
    window: Sequence[Quote],
    baseline: Baseline,
    prefs: AttentionPreferences,
    now: datetime,
) -> DetectedChange | None:
    """Score everything that happened to one symbol since the user's checkpoint.

    `window` is every quote observed since the checkpoint, ascending by
    source_timestamp; its last element is the current state. Returns None only
    when there is no data at all to reason about. A symbol that simply did not
    move still returns a QUIET change, so the UI can show it as explicitly
    checked-and-calm rather than as missing.
    """
    if not window:
        return None

    current = window[-1]
    assessment = fresh.assess(current.source_timestamp, now)
    trust = fresh.confidence_weight(assessment.state)

    previous_price = checkpoint_quote.price
    change_pct = _pct_change(previous_price, current.price)
    abs_move = abs(change_pct)

    reasons: list[Reason] = []
    raw_score = 0.0
    # Tracks which signal is most responsible, so the change is labelled with
    # what actually happened rather than always saying "price move".
    dominant_points = 0.0
    dominant_type = ChangeType.PRICE_MOVE

    def add(code: str, text: str, points: float, kind: ChangeType) -> None:
        nonlocal raw_score, dominant_points, dominant_type
        if points <= 0:
            return
        raw_score += points
        reasons.append(Reason(code=code, text=text, contribution=round(points, 1)))
        if points > dominant_points:
            dominant_points = points
            dominant_type = kind

    # --- Signal 1: move against the user's own stated threshold ----------
    if prefs.min_move_pct > 0 and abs_move > 0:
        ratio = min(abs_move / prefs.min_move_pct, CAP_MOVE)
        if ratio >= 1.0:
            direction = "up" if change_pct > 0 else "down"
            excess = (ratio - 1.0) / (CAP_MOVE - 1.0)
            add(
                "move_vs_threshold",
                f"Moved {_fmt(abs_move)}% {direction} since your last check, "
                f"past your {_fmt(prefs.min_move_pct)}% attention threshold.",
                W_MOVE_MIN + (W_MOVE_MAX - W_MOVE_MIN) * excess,
                ChangeType.PRICE_MOVE,
            )

    # --- Signal 2: move against this symbol's own normal volatility ------
    # Withheld entirely when the baseline is thin. Calling a move "unusual" on
    # the strength of three observations would be exactly the false confidence
    # this product exists to avoid.
    if baseline.is_reliable and abs_move > 0:
        # The baseline is a per-observation standard deviation, but `abs_move`
        # spans the whole window. Comparing them directly is a horizon
        # mismatch: a three-hour move measured against 15-second volatility
        # reads as 20-plus sigma, and the signal fires for everything.
        #
        # Under a random walk, volatility scales with the square root of time,
        # so the fair comparison is against sqrt(periods) times the
        # per-observation deviation. This assumes window and baseline
        # observations share a sampling interval, which holds because both come
        # from the same ingestion cadence.
        periods = max(len(window) - 1, 1)
        expected_move = baseline.stdev_return_pct * math.sqrt(periods)
        sigma = abs_move / expected_move
        if sigma >= SIGMA_TRIGGER:
            capped = min(sigma, CAP_UNUSUAL)
            add(
                "unusual_vs_baseline",
                f"That is {_fmt(sigma)}x this stock's normal move over a window "
                f"this long (typically about {_fmt(expected_move)}%).",
                W_UNUSUAL * (capped / CAP_UNUSUAL),
                ChangeType.UNUSUAL_MOVE,
            )

    # --- Signal 3: volume anomaly ----------------------------------------
    if baseline.mean_volume > 0 and current.volume > 0:
        vol_ratio = current.volume / baseline.mean_volume
        if vol_ratio >= prefs.volume_sensitivity:
            capped = min(vol_ratio, CAP_VOLUME)
            add(
                "volume_anomaly",
                f"Volume is {_fmt(vol_ratio)}x its recent average, so the move "
                f"has real participation behind it.",
                W_VOLUME * (capped / CAP_VOLUME),
                ChangeType.VOLUME_ANOMALY,
            )

    # --- Signal 4: an explicit user threshold was crossed -----------------
    # Checked across the whole window rather than the endpoints: a level that
    # was breached and then retraced was still breached.
    high = max(q.price for q in window)
    low = min(q.price for q in window)

    if watched.threshold_above is not None and high >= watched.threshold_above:
        add(
            "threshold_above",
            f"Crossed above your price alert of {watched.threshold_above} "
            f"(reached {high}).",
            W_THRESHOLD,
            ChangeType.THRESHOLD_CROSS,
        )
    if watched.threshold_below is not None and low <= watched.threshold_below:
        add(
            "threshold_below",
            f"Fell below your price alert of {watched.threshold_below} "
            f"(reached {low}).",
            W_THRESHOLD,
            ChangeType.THRESHOLD_CROSS,
        )

    # --- Signal 5: intra-window swing -------------------------------------
    # The reason this system stores a series instead of a last price. A stock
    # that spiked 6% and gave it all back reads as "unchanged" to any endpoint
    # comparison, yet it is often the single most important thing that
    # happened while the user was away.
    swing_high = _pct_change(previous_price, high)
    swing_low = _pct_change(previous_price, low)
    peak_excursion = max(abs(swing_high), abs(swing_low))
    swing_floor = prefs.min_move_pct * prefs.swing_sensitivity

    # Only interesting when the excursion meaningfully exceeded where the price
    # actually ended up. Otherwise it is just the move already scored above.
    if peak_excursion >= swing_floor and peak_excursion >= abs_move * 1.5:
        ratio = min(peak_excursion / swing_floor, CAP_SWING)
        at_high = abs(swing_high) >= abs(swing_low)
        extreme = "high" if at_high else "low"
        excursion_signed = swing_high if at_high else swing_low
        add(
            "intrawindow_swing",
            f"Swung to {_fmt(excursion_signed)}% at its {extreme} while you "
            f"were away, then settled at {_fmt(change_pct)}%. Comparing prices "
            f"alone would have missed this.",
            W_SWING * (ratio / CAP_SWING),
            ChangeType.INTRAWINDOW_SWING,
        )

    # --- Combine -----------------------------------------------------------
    multiplier = PRIORITY_MULTIPLIER.get(watched.priority, 1.0)
    base_score = min(raw_score * trust, 100.0)
    score = min(raw_score * multiplier * trust, 100.0)

    # Priority and freshness are recorded as reasons too, so the displayed
    # score always reconciles against the list the user can see.
    if reasons and multiplier != 1.0:
        effect = "ranks higher" if multiplier > 1.0 else "ranks lower"
        reasons.append(
            Reason(
                "priority",
                f"You set this to priority {watched.priority}, so it {effect}.",
                round(score - base_score, 1),
            )
        )

    if reasons and assessment.state is not fresh.Freshness.FRESH:
        label = "delayed" if assessment.state is fresh.Freshness.DELAYED else "stale"
        reasons.append(
            Reason(
                "freshness_penalty",
                f"Data is {label} ({int(assessment.age_seconds)}s old), so this "
                f"is ranked with reduced confidence.",
                0.0,
            )
        )

    return DetectedChange(
        symbol=watched.symbol,
        change_type=dominant_type,
        severity=_severity_for(score),
        score=round(score, 1),
        previous_value=previous_price,
        current_value=current.price,
        change_pct=round(change_pct, 2),
        occurred_at=current.source_timestamp,
        reasons=reasons,
        source_timestamp=current.source_timestamp,
        freshness=assessment.state.value,
        priority=watched.priority,
    )


def rank(changes: Sequence[DetectedChange]) -> list[DetectedChange]:
    """Order changes by attention priority.

    Score descending, then symbol ascending. The symbol tiebreak exists so two
    equally-scored changes always render in the same order: a stable UI is part
    of being trustworthy, and it keeps tests deterministic.
    """
    return sorted(changes, key=lambda c: (-c.score, c.symbol))


def is_meaningful(change: DetectedChange) -> bool:
    """Whether a change belongs in the attention list rather than the quiet list."""
    return change.severity is not Severity.QUIET
