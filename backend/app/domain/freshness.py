"""Data freshness as a first-class domain concept.

Freshness is always derived from the *source* timestamp (when the market
produced the tick), never from when our database happened to store the row.
A row inserted one second ago carrying a twenty-minute-old quote is stale
data, and presenting it as current would be a lie.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum


class Freshness(str, Enum):
    FRESH = "fresh"
    DELAYED = "delayed"
    STALE = "stale"


# Thresholds measured against source_timestamp. Chosen for an equities
# product where a quote older than a minute is noticeably behind, and one
# older than fifteen minutes must not drive an attention decision.
FRESH_WITHIN = timedelta(seconds=60)
DELAYED_WITHIN = timedelta(minutes=15)


@dataclass(frozen=True)
class FreshnessAssessment:
    state: Freshness
    age_seconds: float
    source_timestamp: datetime

    @property
    def is_trustworthy(self) -> bool:
        """Whether this data may drive an attention decision at full weight."""
        return self.state is not Freshness.STALE


def assess(source_timestamp: datetime, now: datetime) -> FreshnessAssessment:
    """Classify how current a quote is.

    `now` is injected rather than read from the clock so that every caller,
    including tests and the replay engine, is deterministic.
    """
    age = (now - source_timestamp).total_seconds()

    # Negative age means the source claims a timestamp in our future. That is
    # a clock-skew or bad-feed symptom, not freshness. Treat it as stale
    # rather than as maximally fresh, so a broken feed cannot manufacture
    # high-confidence alerts.
    if age < 0:
        return FreshnessAssessment(Freshness.STALE, age, source_timestamp)

    if age <= FRESH_WITHIN.total_seconds():
        state = Freshness.FRESH
    elif age <= DELAYED_WITHIN.total_seconds():
        state = Freshness.DELAYED
    else:
        state = Freshness.STALE

    return FreshnessAssessment(state, age, source_timestamp)


# How much a signal score is trusted at each freshness level. Stale data is
# not discarded outright -- the user is still told what we last knew -- but it
# cannot rank above genuinely current information.
CONFIDENCE_WEIGHT = {
    Freshness.FRESH: 1.0,
    Freshness.DELAYED: 0.85,
    Freshness.STALE: 0.5,
}


def confidence_weight(state: Freshness) -> float:
    return CONFIDENCE_WEIGHT[state]
