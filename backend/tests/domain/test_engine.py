"""Tests for the Meaningful Change Engine.

These target the decisions the product would be wrong to get wrong: when the
engine stays silent, when it speaks up, and whether its explanation actually
reconciles with the score it printed.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.domain import engine
from app.domain.baseline import compute_baseline
from app.domain.models import (
    AttentionPreferences,
    Baseline,
    ChangeType,
    Quote,
    Severity,
    WatchedSymbol,
)

NOW = datetime(2026, 9, 4, 15, 30, 0)


def quote(price: str, volume: int = 1_000_000, offset_seconds: int = 0) -> Quote:
    return Quote(
        symbol="TEST",
        price=Decimal(price),
        volume=volume,
        source_timestamp=NOW - timedelta(seconds=offset_seconds),
    )


def steady_baseline(stdev: float = 1.0, mean_volume: float = 1_000_000) -> Baseline:
    return Baseline(
        symbol="TEST",
        mean_abs_return_pct=0.8,
        stdev_return_pct=stdev,
        mean_volume=mean_volume,
        sample_size=30,
    )


def evaluate(window, *, watched=None, baseline=None, prefs=None, checkpoint=None):
    return engine.evaluate_symbol(
        watched=watched or WatchedSymbol("TEST"),
        checkpoint_quote=checkpoint or quote("100.00"),
        window=window,
        baseline=baseline or steady_baseline(),
        prefs=prefs or AttentionPreferences.default(),
        now=NOW,
    )


# --- Silence: the engine must not cry wolf ----------------------------------


class TestStaysQuiet:
    def test_tiny_move_is_quiet_and_has_no_reasons(self):
        result = evaluate([quote("100.30")])

        assert result is not None
        assert result.severity is Severity.QUIET
        assert result.score == 0.0
        assert result.reasons == []

    def test_flat_price_still_returns_a_change_record(self):
        """A calm symbol must be reported as checked, not omitted.

        The Market Brief shows an explicit "no meaningful change" list, which
        is only honest if the engine actually evaluated those symbols.
        """
        result = evaluate([quote("100.00")])

        assert result is not None
        assert result.severity is Severity.QUIET
        assert result.change_pct == 0.0

    def test_move_below_user_threshold_does_not_fire(self):
        prefs = AttentionPreferences(min_move_pct=5.0)
        result = evaluate([quote("103.00")], prefs=prefs)

        codes = {r.code for r in result.reasons}
        assert "move_vs_threshold" not in codes

    def test_empty_window_returns_none(self):
        assert evaluate([]) is None


# --- Withholding judgement on thin data -------------------------------------


class TestUnreliableBaseline:
    def test_unusual_signal_withheld_when_baseline_is_thin(self):
        thin = Baseline("TEST", 0.5, 0.4, 1_000_000, sample_size=2)
        result = evaluate([quote("108.00")], baseline=thin)

        codes = {r.code for r in result.reasons}
        assert "unusual_vs_baseline" not in codes
        # The plain move signal still fires -- we lose the comparison, not the
        # observation.
        assert "move_vs_threshold" in codes

    def test_zero_stdev_baseline_is_not_reliable(self):
        flat = Baseline("TEST", 0.0, 0.0, 1_000_000, sample_size=50)
        assert flat.is_reliable is False

    def test_zero_volume_baseline_suppresses_volume_signal(self):
        no_vol = Baseline("TEST", 0.8, 1.0, 0.0, sample_size=30)
        result = evaluate([quote("108.00", volume=99_000_000)], baseline=no_vol)

        assert "volume_anomaly" not in {r.code for r in result.reasons}


# --- Firing correctly --------------------------------------------------------


class TestSignalsFire:
    def test_large_move_surfaces_with_direction_in_explanation(self):
        result = evaluate([quote("104.80")])

        assert engine.is_meaningful(result)
        move = next(r for r in result.reasons if r.code == "move_vs_threshold")
        assert "4.8% up" in move.text

    def test_unusual_move_cites_the_baseline(self):
        result = evaluate([quote("106.00")], baseline=steady_baseline(stdev=1.0))

        unusual = next(r for r in result.reasons if r.code == "unusual_vs_baseline")
        assert "6.0x" in unusual.text

    def test_volume_anomaly_fires_above_sensitivity(self):
        result = evaluate([quote("104.00", volume=3_000_000)])

        vol = next(r for r in result.reasons if r.code == "volume_anomaly")
        assert "3.0x" in vol.text

    def test_threshold_cross_fires_even_if_price_retraced(self):
        """A breached alert level stays breached.

        The user asked to be told when it crossed 110. It crossed 110. That it
        came back down does not undo the event.
        """
        watched = WatchedSymbol("TEST", threshold_above=Decimal("110.00"))
        window = [quote("112.00", offset_seconds=120), quote("100.50")]

        result = evaluate(window, watched=watched)

        codes = {r.code for r in result.reasons}
        assert "threshold_above" in codes

    def test_threshold_below_fires_on_window_low(self):
        watched = WatchedSymbol("TEST", threshold_below=Decimal("95.00"))
        window = [quote("94.00", offset_seconds=60), quote("99.00")]

        result = evaluate(window, watched=watched)

        assert "threshold_below" in {r.code for r in result.reasons}


# --- The signature signal ----------------------------------------------------


class TestIntraWindowSwing:
    def test_spike_and_reversal_is_surfaced(self):
        """The differentiating case.

        Price ran to +7% and settled at +0.4%. Endpoint comparison calls this
        nothing happening; it is in fact the most important thing that happened.
        """
        window = [
            quote("100.00", offset_seconds=300),
            quote("107.00", offset_seconds=200),
            quote("103.00", offset_seconds=100),
            quote("100.40", offset_seconds=10),
        ]

        result = evaluate(window)

        assert engine.is_meaningful(result)
        assert result.change_type is ChangeType.INTRAWINDOW_SWING
        swing = next(r for r in result.reasons if r.code == "intrawindow_swing")
        assert "7.0%" in swing.text
        assert "0.4%" in swing.text

    def test_swing_not_double_counted_on_a_clean_directional_move(self):
        """A price that simply walked up to +6% is a move, not a round trip."""
        window = [
            quote("100.00", offset_seconds=300),
            quote("103.00", offset_seconds=200),
            quote("106.00", offset_seconds=10),
        ]

        result = evaluate(window)

        codes = {r.code for r in result.reasons}
        assert "intrawindow_swing" not in codes
        assert "move_vs_threshold" in codes

    def test_downward_swing_reports_the_low(self):
        window = [
            quote("92.00", offset_seconds=200),
            quote("99.70", offset_seconds=10),
        ]

        result = evaluate(window)

        swing = next(r for r in result.reasons if r.code == "intrawindow_swing")
        assert "-8.0%" in swing.text
        assert "low" in swing.text


# --- Freshness interaction ---------------------------------------------------


class TestFreshnessAffectsRanking:
    def test_stale_data_scores_lower_than_identical_fresh_data(self):
        fresh_result = evaluate([quote("106.00", offset_seconds=5)])
        stale_result = evaluate([quote("106.00", offset_seconds=3600)])

        assert stale_result.score < fresh_result.score
        assert stale_result.freshness == "stale"
        assert fresh_result.freshness == "fresh"

    def test_stale_data_is_labelled_in_the_explanation(self):
        result = evaluate([quote("106.00", offset_seconds=3600)])

        note = next(r for r in result.reasons if r.code == "freshness_penalty")
        assert "stale" in note.text

    def test_future_timestamp_is_treated_as_stale_not_fresh(self):
        """A feed clock running ahead must not manufacture confident alerts."""
        future = Quote("TEST", Decimal("106.00"), 1_000_000, NOW + timedelta(minutes=5))

        result = evaluate([future])

        assert result.freshness == "stale"


# --- Priority ----------------------------------------------------------------


class TestPriority:
    def test_priority_one_outranks_identical_priority_three(self):
        high = evaluate([quote("105.00")], watched=WatchedSymbol("TEST", priority=1))
        low = evaluate([quote("105.00")], watched=WatchedSymbol("TEST", priority=3))

        assert high.score > low.score

    def test_priority_does_not_invent_an_alert_from_nothing(self):
        """Priority scales attention; it does not create it.

        A priority-1 stock that did nothing must stay quiet, or the setting
        becomes a permanent false alarm.
        """
        result = evaluate([quote("100.05")], watched=WatchedSymbol("TEST", priority=1))

        assert result.severity is Severity.QUIET
        assert result.reasons == []


# --- Score integrity ---------------------------------------------------------


class TestUserThresholdIsHonoured:
    def test_a_move_just_past_the_users_threshold_is_surfaced(self):
        """If the user says 2% matters, a 2.9% move must not be called quiet."""
        prefs = AttentionPreferences(min_move_pct=2.0)
        result = evaluate([quote("102.90")], prefs=prefs, baseline=steady_baseline(stdev=9.0))

        assert engine.is_meaningful(result)

    def test_a_move_just_under_the_threshold_stays_quiet(self):
        prefs = AttentionPreferences(min_move_pct=2.0)
        result = evaluate([quote("101.50")], prefs=prefs, baseline=steady_baseline(stdev=9.0))

        assert result.severity is Severity.QUIET

    def test_raising_the_threshold_silences_a_previously_surfaced_move(self):
        """The preference has to actually change the outcome to be worth having."""
        window = [quote("103.00")]
        calm = steady_baseline(stdev=9.0)

        loose = evaluate(window, prefs=AttentionPreferences(min_move_pct=2.0), baseline=calm)
        strict = evaluate(window, prefs=AttentionPreferences(min_move_pct=8.0), baseline=calm)

        assert engine.is_meaningful(loose)
        assert not engine.is_meaningful(strict)


class TestScoreIntegrity:
    def test_score_never_exceeds_one_hundred(self):
        watched = WatchedSymbol(
            "TEST", priority=1, threshold_above=Decimal("101"),
            threshold_below=Decimal("99"),
        )
        window = [
            quote("80.00", offset_seconds=200),
            quote("160.00", offset_seconds=5),
        ]

        result = evaluate(window, watched=watched, baseline=steady_baseline(stdev=0.5))

        assert result.score <= 100.0

    def test_explanation_reconciles_with_the_score(self):
        """The headline number must equal the sum of what the user is shown.

        This is the property that makes the score defensible rather than
        decorative.
        """
        result = evaluate(
            [quote("106.00", volume=2_500_000)],
            watched=WatchedSymbol("TEST", priority=1),
        )

        total = sum(r.contribution for r in result.reasons)
        assert result.score == pytest.approx(total, abs=0.3)

    def test_severity_bands_are_monotonic_in_score(self):
        order = [Severity.QUIET, Severity.NOTABLE, Severity.HIGH, Severity.CRITICAL]
        scores = [10.0, 30.0, 50.0, 80.0]
        got = [engine._severity_for(s) for s in scores]

        assert got == order

    def test_zero_previous_price_does_not_divide_by_zero(self):
        result = evaluate([quote("50.00")], checkpoint=quote("0.00"))

        assert result.change_pct == 0.0


# --- Ranking -----------------------------------------------------------------


class TestRanking:
    def test_ranked_by_score_descending(self):
        big = evaluate([quote("112.00")])
        small = evaluate([quote("102.10")])

        ranked = engine.rank([small, big])

        assert ranked[0].score >= ranked[1].score

    def test_ties_break_on_symbol_for_stable_ordering(self):
        a = evaluate([quote("105.00")], watched=WatchedSymbol("AAA"))
        z = evaluate([quote("105.00")], watched=WatchedSymbol("ZZZ"))

        assert [c.symbol for c in engine.rank([z, a])] == ["AAA", "ZZZ"]

    def test_ranking_is_deterministic_across_input_orderings(self):
        changes = [
            evaluate([quote("105.00")], watched=WatchedSymbol(s))
            for s in ("MMM", "AAA", "ZZZ")
        ]

        forward = [c.symbol for c in engine.rank(changes)]
        backward = [c.symbol for c in engine.rank(list(reversed(changes)))]

        assert forward == backward


# --- Determinism -------------------------------------------------------------


def test_engine_is_pure_repeated_calls_are_identical():
    window = [quote("107.00", offset_seconds=120), quote("103.50")]

    first = evaluate(window)
    second = evaluate(window)

    assert first == second


# --- Baseline computation ----------------------------------------------------


class TestBaselineComputation:
    def test_baseline_from_a_calm_series_has_small_stdev(self):
        history = [quote(p, offset_seconds=o) for p, o in
                   [("100", 600), ("100.5", 500), ("100.2", 400),
                    ("100.6", 300), ("100.3", 200), ("100.7", 100)]]

        b = compute_baseline("TEST", history)

        assert b.is_reliable
        assert b.stdev_return_pct < 1.0

    def test_baseline_from_a_volatile_series_has_large_stdev(self):
        history = [quote(p, offset_seconds=o) for p, o in
                   [("100", 600), ("108", 500), ("95", 400),
                    ("104", 300), ("92", 200), ("101", 100)]]

        b = compute_baseline("TEST", history)

        assert b.is_reliable
        assert b.stdev_return_pct > 5.0

    def test_insufficient_history_is_marked_unreliable(self):
        b = compute_baseline("TEST", [quote("100")])

        assert b.sample_size == 0
        assert b.is_reliable is False

    def test_same_move_is_unusual_for_a_calm_stock_and_normal_for_a_wild_one(self):
        """The whole point of per-symbol baselines, as one assertion."""
        calm = steady_baseline(stdev=0.5)
        wild = steady_baseline(stdev=6.0)

        calm_result = evaluate([quote("104.00")], baseline=calm)
        wild_result = evaluate([quote("104.00")], baseline=wild)

        assert "unusual_vs_baseline" in {r.code for r in calm_result.reasons}
        assert "unusual_vs_baseline" not in {r.code for r in wild_result.reasons}


def test_standalone_signals_can_clear_the_notable_band():
    """Regression guard on scoring calibration.

    A swing or a threshold cross fires when the endpoint move is small, so no
    other signal is available to add to it. If either weight drops below the
    NOTABLE floor, that signal silently stops being able to surface anything.
    """
    assert engine.W_SWING >= engine.SEVERITY_NOTABLE
    assert engine.W_THRESHOLD >= engine.SEVERITY_NOTABLE
    # Meeting the user's own stated threshold must also be enough on its own,
    # or the setting silently means something stricter than it says.
    assert engine.W_MOVE_MIN >= engine.SEVERITY_NOTABLE


class TestVolatilityHorizonScaling:
    """The baseline is a per-observation deviation; the move spans the window.

    Comparing them directly is a horizon mismatch that makes a three-hour move
    read as 20-plus sigma against 15-second volatility, firing the "unusual"
    signal for ordinary drift. Volatility must scale with sqrt(time).
    """

    def test_long_window_drift_is_not_called_unusual(self):
        # 0.8% total drift across 200 observations of a stock whose typical
        # per-observation move is 0.1%. Unscaled this reads as 8 sigma;
        # correctly scaled the expected move is ~1.4%, so 0.8% is unremarkable.
        window = [
            quote(f"{100 + i * 0.004:.4f}", offset_seconds=(200 - i) * 15)
            for i in range(201)
        ]

        result = evaluate(window, baseline=steady_baseline(stdev=0.1))

        assert "unusual_vs_baseline" not in {r.code for r in result.reasons}

    def test_genuinely_large_move_still_fires_over_a_long_window(self):
        window = [
            quote("100.00", offset_seconds=3000),
            *[quote("100.00", offset_seconds=(200 - i) * 15) for i in range(1, 200)],
            quote("112.00", offset_seconds=10),
        ]

        result = evaluate(window, baseline=steady_baseline(stdev=0.1))

        assert "unusual_vs_baseline" in {r.code for r in result.reasons}

    def test_scaling_is_a_no_op_for_a_single_observation_window(self):
        """A one-tick window has one period, so sqrt(1) leaves it unchanged."""
        result = evaluate([quote("106.00")], baseline=steady_baseline(stdev=1.0))

        unusual = next(r for r in result.reasons if r.code == "unusual_vs_baseline")
        assert "6.0x" in unusual.text
