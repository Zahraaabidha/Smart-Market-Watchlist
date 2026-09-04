"""HTTP-level tests for the routes added in the UI pass.

These use a TestClient but deliberately do NOT enter the app lifespan, so the
background ingestion loop never starts and cannot write snapshots underneath
the assertions. `app.state` is seeded by hand instead.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.security import create_access_token
from app.main import MarketStatus, app
from app.persistence.db import get_session
from app.services import watchlists as wl


@pytest.fixture
def client(session):
    def _override():
        yield session

    app.dependency_overrides[get_session] = _override
    app.state.provider = _StubProvider()
    app.state.market_status = MarketStatus(mode="replay")
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


class _StubProvider:
    name = "replay"


def _auth(user) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


class TestMarketSource:
    def test_reports_replay_and_demo_mode(self, client):
        body = client.get("/api/market/source").json()

        assert body["provider"] == "replay"
        assert body["mode"] == "replay"
        assert body["degraded"] is False
        assert body["demo_mode"] is True


class TestDemoControls:
    def test_demo_replay_seeds_a_populated_brief(self, client, session, user):
        watchlist = wl.create_default_watchlist(session, user)

        res = client.post("/api/demo/replay", headers=_auth(user))
        assert res.status_code == 200
        assert "checked_at" in res.json()

        brief = client.get(
            f"/api/watchlists/{watchlist.id}/brief", headers=_auth(user)
        ).json()
        assert brief["monitored_count"] >= 5
        assert brief["market_source"] == "replay"
        # Something moved across a 3h replay window.
        assert brief["meaningful_count"] >= 1

    def test_demo_provider_failing_degrades_without_erroring(self, client, user):
        res = client.post(
            "/api/demo/provider", headers=_auth(user), json={"mode": "failing"}
        )
        assert res.status_code == 200
        assert res.json()["degraded"] is True

        # Restore, so the shared app object is left clean for other tests.
        client.post("/api/demo/provider", headers=_auth(user), json={"mode": "replay"})

    def test_demo_provider_rejects_an_unknown_mode(self, client, user):
        res = client.post(
            "/api/demo/provider", headers=_auth(user), json={"mode": "bogus"}
        )
        assert res.status_code == 422


class TestSymbolPathEndpoint:
    def test_path_for_a_symbol_not_on_the_watchlist_is_404(
        self, client, session, user
    ):
        watchlist = wl.create_default_watchlist(session, user)

        res = client.get(
            f"/api/watchlists/{watchlist.id}/path/NOTLISTED", headers=_auth(user)
        )
        assert res.status_code == 404

    def test_path_on_another_users_watchlist_is_404(
        self, client, session, user, other_user
    ):
        theirs = wl.create_default_watchlist(session, other_user)

        res = client.get(
            f"/api/watchlists/{theirs.id}/path/RELIANCE", headers=_auth(user)
        )
        assert res.status_code == 404

    def test_path_after_demo_seed_returns_markers(self, client, session, user):
        watchlist = wl.create_default_watchlist(session, user)
        client.post("/api/demo/replay", headers=_auth(user))

        res = client.get(
            f"/api/watchlists/{watchlist.id}/path/RELIANCE", headers=_auth(user)
        )
        assert res.status_code == 200
        body = res.json()
        assert body["symbol"] == "RELIANCE"
        assert len(body["points"]) >= 2
        assert "window_high" in body and "window_low" in body
        assert body["source"] == "replay"
        assert body["freshness"] in {"fresh", "delayed", "stale"}
