"""Deterministic replay market data provider.

Generates a reproducible price path per symbol from a seeded PRNG. Given the
same seed and the same timestamp, this always returns the same quote -- on any
machine, in any process, in any order. That property is what makes it usable
as the backbone of both the demo and the test suite: a failing scenario can be
reproduced exactly rather than waited for.

The generator is intentionally not a random walk accumulated over calls, which
would make output depend on how many times it had been called. Instead each
quote is a pure function of (seed, symbol, tick index), so history can be
computed for any point in time without replaying everything before it.
"""

from __future__ import annotations

import hashlib
import math
import struct
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

from app.domain.models import Quote
from app.integrations.provider import MarketDataError, MarketDataProvider

TICK = timedelta(seconds=15)

# Ticks aggregated into one block draw. sqrt(BLOCK) keeps the variance of an
# aggregated block equal to that of summing BLOCK individual ticks.
BLOCK = 64
BLOCK_SCALE = math.sqrt(BLOCK)
# AR(1) decay applied per block. Below 1.0 the series is mean-reverting, so
# prices stay in a plausible band around the base price indefinitely instead of
# drifting away over months. Stationary spread is roughly
# volatility * BLOCK_SCALE / sqrt(1 - MEAN_REVERSION**2).
MEAN_REVERSION = 0.998
# Weight of non-accumulating per-tick jitter, as a fraction of volatility.
TICK_NOISE = 0.6


class SymbolProfile:
    """Static characteristics of a simulated instrument.

    `volatility` is the per-tick standard deviation in percent. Varying it
    across symbols is what makes per-symbol baselines meaningful in the demo:
    a 2% move must read as routine for one name and alarming for another.
    """

    def __init__(
        self,
        symbol: str,
        base_price: str,
        volatility: float,
        base_volume: int,
        drift: float = 0.0,
    ) -> None:
        self.symbol = symbol
        self.base_price = Decimal(base_price)
        self.volatility = volatility
        self.base_volume = base_volume
        self.drift = drift


# A small, varied default universe. Deliberately spans a calm large-cap, a
# volatile mid-cap and a very quiet name so the ranking logic has something
# real to discriminate between during a demo.
#
# RELIANCE and INFY sit a step above HDFCBANK/TCS on purpose: with only
# ZOMATO markedly more volatile than the rest of the default watchlist, a
# random demo window almost always surfaced ZOMATO alone. Nudging these two
# into a second, moderate tier (still well under ZOMATO's) makes it commonly
# join ZOMATO as meaningful while TCS and HDFCBANK stay calm often enough
# that the quiet list still demonstrates filtering. This does not touch the
# scoring engine, thresholds, or any other symbol's profile.
DEFAULT_UNIVERSE: dict[str, SymbolProfile] = {
    p.symbol: p
    for p in [
        SymbolProfile("RELIANCE", "2840.00", volatility=0.26, base_volume=4_200_000),
        SymbolProfile("TCS", "3920.00", volatility=0.1, base_volume=1_800_000),
        SymbolProfile("HDFCBANK", "1685.00", volatility=0.13, base_volume=3_100_000),
        SymbolProfile("INFY", "1540.00", volatility=0.26, base_volume=2_700_000),
        SymbolProfile("ZOMATO", "268.00", volatility=0.42, base_volume=9_400_000),
        SymbolProfile("ITC", "462.00", volatility=0.07, base_volume=2_200_000),
        SymbolProfile("TATAMOTORS", "985.00", volatility=0.3, base_volume=6_800_000),
        SymbolProfile("SBIN", "824.00", volatility=0.18, base_volume=5_300_000),
    ]
}

# Timezone-aware: the ingestion loop passes datetime.now(timezone.utc), and
# mixing naive and aware datetimes raises at runtime rather than at import.
EPOCH = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)


def _unit_noise(seed: int, symbol: str, tick: int, salt: str) -> float:
    """A deterministic value in [-1, 1) derived from the inputs.

    Uses a hash rather than a stateful PRNG so that the value for any tick can
    be computed directly, without generating every preceding tick.
    """
    material = f"{seed}:{symbol}:{tick}:{salt}".encode()
    digest = hashlib.sha256(material).digest()
    (raw,) = struct.unpack_from("<Q", digest)
    return (raw / 2**63) - 1.0


class ReplayProvider(MarketDataProvider):
    name = "replay"

    def __init__(
        self,
        seed: int = 20260101,
        universe: dict[str, SymbolProfile] | None = None,
        epoch: datetime = EPOCH,
    ) -> None:
        self.seed = seed
        self.universe = universe or DEFAULT_UNIVERSE
        self.epoch = epoch
        #: Symbols the caller has forced into a failing state, used to
        #: demonstrate partial-failure handling in the running product.
        self.failing_symbols: set[str] = set()
        self.available = True
        #: Memoised AR(1) levels per symbol. A cache, not state: it only ever
        #: holds values that are fully determined by (seed, symbol, block).
        self._levels: dict[str, list[float]] = {}

    # --- price path ----------------------------------------------------

    def _tick_index(self, at: datetime) -> int:
        return max(0, int((at - self.epoch) / TICK))

    def _block_level(self, profile: SymbolProfile, block: int) -> float:
        """Cumulative log-return at the start of `block`, mean-reverting.

        An unbounded random walk is the obvious way to build this and the wrong
        one: summed over months it drifts arbitrarily far, so a stock based at
        2840 prints 9700 and every baseline becomes meaningless.

        This is an AR(1) instead -- each block decays the previous level toward
        zero before adding its own shock -- so the series stays in a realistic
        band around the base price forever while keeping the local texture of a
        random walk. Levels are memoised per symbol and extended incrementally,
        which keeps this O(1) amortised. Memoisation is only a cache: the value
        for a given (seed, symbol, block) is identical whether it was just
        computed or recalled.
        """
        levels = self._levels.setdefault(profile.symbol, [0.0])
        while len(levels) <= block:
            index = len(levels)
            shock = (
                _unit_noise(self.seed, profile.symbol, index - 1, "block")
                * profile.volatility
                * BLOCK_SCALE
            )
            levels.append(levels[index - 1] * MEAN_REVERSION + shock)
        return levels[block]

    def _price_at(self, profile: SymbolProfile, tick: int) -> Decimal:
        """Price as a pure function of the tick index."""
        block, offset = divmod(tick, BLOCK)

        # Interpolate across the block rather than stepping at its boundary.
        # A step would inject an artificial jump every BLOCK ticks, which the
        # change engine would correctly but misleadingly report as a real move.
        start = self._block_level(profile, block)
        end = self._block_level(profile, block + 1)
        progress = (offset + 1) / BLOCK
        cumulative = start + (end - start) * progress

        # Fine per-tick noise for texture. Deliberately non-accumulating, so it
        # adds jitter without contributing drift.
        cumulative += (
            _unit_noise(self.seed, profile.symbol, tick, "tick")
            * profile.volatility
            * TICK_NOISE
        )

        cumulative += profile.drift * tick * 0.001

        price = float(profile.base_price) * math.exp(cumulative / 100.0)
        # Simulated instruments must never reach zero or go negative; the
        # schema forbids it and a real feed would not produce it.
        price = max(price, float(profile.base_price) * 0.1)
        return Decimal(price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    def _volume_at(self, profile: SymbolProfile, tick: int) -> int:
        # Volume correlates with the size of the move, which is what makes the
        # volume-anomaly signal meaningful rather than independent noise.
        move = abs(_unit_noise(self.seed, profile.symbol, tick, "tick"))
        multiplier = 0.6 + move * 2.8
        return int(profile.base_volume * multiplier)

    def _quote_at(self, profile: SymbolProfile, at: datetime) -> Quote:
        tick = self._tick_index(at)
        return Quote(
            symbol=profile.symbol,
            price=self._price_at(profile, tick),
            volume=self._volume_at(profile, tick),
            # Snapped to the tick grid so repeated polls within one interval
            # produce byte-identical timestamps, which is what lets the
            # ingestion unique constraint collapse them.
            source_timestamp=self.epoch + TICK * tick,
        )

    # --- provider interface ---------------------------------------------

    def fetch_current(self, symbols: Sequence[str], now: datetime) -> list[Quote]:
        if not self.available:
            raise MarketDataError("replay provider marked unavailable")

        quotes: list[Quote] = []
        for symbol in symbols:
            profile = self.universe.get(symbol)
            if profile is None or symbol in self.failing_symbols:
                # Partial result: an unknown or failing symbol is omitted, not
                # fatal. The caller reports it as unavailable and still serves
                # everything else.
                continue
            quotes.append(self._quote_at(profile, now))
        return quotes

    def fetch_history(
        self, symbol: str, since: datetime, now: datetime
    ) -> list[Quote]:
        if not self.available:
            raise MarketDataError("replay provider marked unavailable")

        profile = self.universe.get(symbol)
        if profile is None or symbol in self.failing_symbols:
            return []

        start = self._tick_index(since)
        end = self._tick_index(now)
        if end < start:
            return []

        # Bounded so an absurd date range cannot exhaust memory.
        span = min(end - start, 5000)
        return [
            self._quote_at(profile, self.epoch + TICK * (start + i))
            for i in range(span + 1)
        ]


class FailingProvider(MarketDataProvider):
    """A provider that is always down.

    Exists so that graceful degradation is a tested code path rather than an
    assumption. Wired in by the demo controls to prove the UI keeps serving
    last-known-good data when the feed dies.
    """

    name = "failing"

    def fetch_current(self, symbols: Sequence[str], now: datetime) -> list[Quote]:
        raise MarketDataError("market data provider unavailable")

    def fetch_history(
        self, symbol: str, since: datetime, now: datetime
    ) -> list[Quote]:
        raise MarketDataError("market data provider unavailable")
