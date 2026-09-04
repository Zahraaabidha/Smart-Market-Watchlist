"""Live market data via Twelve Data.

This is the optional live implementation of :class:`MarketDataProvider`. It is
never used on its own in the running product -- it is always wrapped by
:class:`app.integrations.fallback.FallbackProvider`, so a vendor outage, a bad
key or a rate-limit degrades to the deterministic replay provider instead of
breaking the brief.

Design rules, mirroring the replay provider's contract:

* Partial results, not total failure. One unknown or errored symbol is omitted
  from the batch; the rest still return. ``MarketDataError`` is raised only when
  nothing at all could be fetched (network down, auth rejected, quota spent).
* No credential in code. The API key comes from the environment via settings.
* Bounded work. History requests are clamped so an absurd date range cannot
  pull an unbounded series.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import httpx

from app.domain.models import Quote
from app.integrations.provider import MarketDataError, MarketDataProvider

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.twelvedata.com"
_TIMEOUT = httpx.Timeout(8.0, connect=4.0)
# Twelve Data accepts comma-separated batches; keep well under its documented
# ceiling so a large watchlist still resolves in one call.
_MAX_BATCH = 100
# 15-second cadence would blow a free-tier quota instantly, so history is
# fetched at the finest interval the vendor offers for free.
_HISTORY_INTERVAL = "15min"
_MAX_HISTORY_POINTS = 5000


def _parse_price(raw: object) -> Decimal | None:
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return value if value > 0 else None


def _parse_ts(raw: object) -> datetime | None:
    """Twelve Data returns naive exchange-local strings; treat as UTC.

    The absolute offset does not matter for the product's reasoning -- freshness
    and windows are all computed as differences -- but the value must be
    timezone-aware or it will raise when compared with the injected ``now``.
    """
    if not isinstance(raw, str):
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


class TwelveDataProvider(MarketDataProvider):
    name = "twelvedata"

    def __init__(
        self,
        api_key: str,
        exchange: str = "NSE",
        client: httpx.Client | None = None,
    ) -> None:
        if not api_key:
            # A missing key is a configuration error, caught at construction
            # rather than surfacing as a confusing 401 on the first poll.
            raise ValueError("TwelveDataProvider requires an API key")
        self.api_key = api_key
        self.exchange = exchange
        self._client = client or httpx.Client(timeout=_TIMEOUT)

    # --- provider interface ------------------------------------------------

    def fetch_current(self, symbols: Sequence[str], now: datetime) -> list[Quote]:
        wanted = list(dict.fromkeys(s.upper() for s in symbols))
        if not wanted:
            return []

        quotes: list[Quote] = []
        errors = 0
        for start in range(0, len(wanted), _MAX_BATCH):
            batch = wanted[start : start + _MAX_BATCH]
            try:
                payload = self._get(
                    "/quote",
                    {"symbol": ",".join(batch), "exchange": self.exchange},
                )
            except MarketDataError:
                errors += 1
                continue
            quotes.extend(self._quotes_from_payload(payload, batch))

        # Every batch failed and nothing came back: the caller must degrade.
        if not quotes and errors:
            raise MarketDataError("twelve data: no quotes returned for any symbol")
        return quotes

    def fetch_history(
        self, symbol: str, since: datetime, now: datetime
    ) -> list[Quote]:
        if now < since:
            return []
        payload = self._get(
            "/time_series",
            {
                "symbol": symbol.upper(),
                "exchange": self.exchange,
                "interval": _HISTORY_INTERVAL,
                "start_date": since.strftime("%Y-%m-%d %H:%M:%S"),
                "end_date": now.strftime("%Y-%m-%d %H:%M:%S"),
                "outputsize": _MAX_HISTORY_POINTS,
                "order": "ASC",
            },
        )
        values = payload.get("values")
        if not isinstance(values, list):
            return []

        out: list[Quote] = []
        for row in values:
            if not isinstance(row, dict):
                continue
            price = _parse_price(row.get("close"))
            ts = _parse_ts(row.get("datetime"))
            if price is None or ts is None or ts > now:
                continue
            out.append(
                Quote(
                    symbol=symbol.upper(),
                    price=price,
                    volume=int(float(row.get("volume") or 0)),
                    source_timestamp=ts,
                )
            )
        out.sort(key=lambda q: q.source_timestamp)
        return out[:_MAX_HISTORY_POINTS]

    # --- internals -------------------------------------------------------

    def _get(self, path: str, params: dict[str, object]) -> dict:
        params = {**params, "apikey": self.api_key}
        try:
            response = self._client.get(f"{_BASE_URL}{path}", params=params)
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise MarketDataError(f"twelve data request failed: {exc}") from exc

        # The API returns HTTP 200 with an error envelope for auth and quota
        # problems, so the status code alone is not enough.
        if isinstance(body, dict) and body.get("status") == "error":
            message = body.get("message", "unknown error")
            raise MarketDataError(f"twelve data error: {message}")
        return body if isinstance(body, dict) else {}

    def _quotes_from_payload(
        self, payload: dict, batch: Sequence[str]
    ) -> list[Quote]:
        # A single-symbol request returns the quote object directly; a batch
        # returns a mapping of symbol -> quote object.
        rows: list[tuple[str, dict]]
        if len(batch) == 1 and "symbol" in payload:
            rows = [(batch[0], payload)]
        else:
            rows = [
                (sym, obj)
                for sym, obj in payload.items()
                if isinstance(obj, dict)
            ]

        quotes: list[Quote] = []
        for symbol, obj in rows:
            if obj.get("status") == "error":
                logger.warning(
                    "twelve data: %s unavailable (%s)", symbol, obj.get("message")
                )
                continue
            price = _parse_price(obj.get("close") or obj.get("price"))
            if price is None:
                continue
            ts = _parse_ts(obj.get("datetime")) or datetime.now(timezone.utc)
            quotes.append(
                Quote(
                    symbol=symbol.upper(),
                    price=price,
                    volume=int(float(obj.get("volume") or 0)),
                    source_timestamp=ts,
                )
            )
        return quotes
