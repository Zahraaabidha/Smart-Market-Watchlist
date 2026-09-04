"""TwelveDataProvider maps vendor payloads to Quotes and degrades correctly."""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from app.integrations.provider import MarketDataError
from app.integrations.twelve_data import TwelveDataProvider

NOW = datetime(2026, 9, 4, 10, 0, 0, tzinfo=timezone.utc)


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_requires_an_api_key() -> None:
    with pytest.raises(ValueError):
        TwelveDataProvider(api_key="")


def test_maps_a_batch_quote_payload() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "/quote" in request.url.path
        assert request.url.params["exchange"] == "NSE"
        return httpx.Response(
            200,
            json={
                "RELIANCE": {
                    "symbol": "RELIANCE",
                    "close": "2841.50",
                    "volume": "4200000",
                    "datetime": "2026-09-04 09:59:00",
                },
                "TCS": {
                    "symbol": "TCS",
                    "close": "3920.10",
                    "volume": "1800000",
                    "datetime": "2026-09-04 09:59:00",
                },
            },
        )

    provider = TwelveDataProvider(api_key="k", client=_client(handler))
    quotes = {q.symbol: q for q in provider.fetch_current(["RELIANCE", "TCS"], NOW)}

    assert set(quotes) == {"RELIANCE", "TCS"}
    assert str(quotes["RELIANCE"].price) == "2841.50"
    assert quotes["RELIANCE"].volume == 4_200_000
    assert quotes["RELIANCE"].source_timestamp.tzinfo is not None


def test_skips_one_bad_symbol_but_keeps_the_rest() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "GOOD": {"symbol": "GOOD", "close": "10.00", "datetime": "2026-09-04 09:59:00"},
                "BAD": {"status": "error", "message": "symbol not found"},
            },
        )

    provider = TwelveDataProvider(api_key="k", client=_client(handler))
    quotes = provider.fetch_current(["GOOD", "BAD"], NOW)

    assert [q.symbol for q in quotes] == ["GOOD"]


def test_total_failure_raises_market_data_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "error", "message": "quota exceeded"})

    provider = TwelveDataProvider(api_key="k", client=_client(handler))
    with pytest.raises(MarketDataError):
        provider.fetch_current(["RELIANCE"], NOW)


def test_network_error_raises_market_data_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    provider = TwelveDataProvider(api_key="k", client=_client(handler))
    with pytest.raises(MarketDataError):
        provider.fetch_current(["RELIANCE"], NOW)


def test_api_key_is_sent_as_a_header_never_in_the_url() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            json={"X": {"symbol": "X", "close": "1.0", "datetime": "2026-09-04 09:59:00"}},
        )

    provider = TwelveDataProvider(api_key="SECRET123", client=_client(handler))
    provider.fetch_current(["X"], NOW)

    assert "SECRET123" not in str(seen["url"])
    assert "apikey=" not in str(seen["url"])
    assert seen["auth"] == "apikey SECRET123"


def test_error_messages_never_contain_the_api_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="Unauthorized")

    provider = TwelveDataProvider(api_key="SECRET123", client=_client(handler))
    try:
        provider.fetch_current(["X"], NOW)
        raise AssertionError("expected MarketDataError")
    except MarketDataError as exc:
        assert "SECRET123" not in str(exc)


def test_history_is_ascending_and_bounded_to_now() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "values": [
                    {"datetime": "2026-09-04 09:30:00", "close": "100.0", "volume": "10"},
                    {"datetime": "2026-09-04 09:45:00", "close": "101.0", "volume": "12"},
                    # after `now`: must be dropped
                    {"datetime": "2026-09-04 10:15:00", "close": "109.0", "volume": "20"},
                ]
            },
        )

    provider = TwelveDataProvider(api_key="k", client=_client(handler))
    history = provider.fetch_history(
        "RELIANCE", datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc), NOW
    )

    assert [str(q.price) for q in history] == ["100.0", "101.0"]
    assert history == sorted(history, key=lambda q: q.source_timestamp)
