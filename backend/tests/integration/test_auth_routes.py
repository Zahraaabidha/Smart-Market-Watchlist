"""HTTP-level tests for /auth/*, including Google Sign-In.

Google ID token verification itself (signature, issuer, audience, expiry) is
Google's own well-tested library, not something to re-verify here. What these
tests own is the boundary we actually wrote: what happens once a token is
known-valid or known-invalid -- account lookup, account creation, and the
password-login path staying safe for an account that has no password.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import MarketStatus, app
from app.persistence.db import get_session
from app.persistence.models import User


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


@pytest.fixture
def google_client_id(monkeypatch):
    """Google sign-in only activates once GOOGLE_CLIENT_ID is configured."""
    get_settings.cache_clear()
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "test-client-id.apps.googleusercontent.com")
    yield "test-client-id.apps.googleusercontent.com"
    get_settings.cache_clear()


def _stub_verify(claims: dict):
    def _verify(token: str, client_id: str) -> dict:
        assert token == "the-credential"
        assert client_id == "test-client-id.apps.googleusercontent.com"
        return claims

    return _verify


class TestGoogleSignIn:
    def test_creates_a_new_account_on_first_google_sign_in(
        self, client, session, google_client_id, monkeypatch
    ):
        monkeypatch.setattr(
            "app.api.routes.verify_google_id_token",
            _stub_verify(
                {"email": "new-google-user@example.com", "email_verified": True}
            ),
        )

        res = client.post("/api/auth/google", json={"credential": "the-credential"})

        assert res.status_code == 200
        assert "access_token" in res.json()
        user = (
            session.query(User)
            .filter(User.email == "new-google-user@example.com")
            .one()
        )
        assert user.password_hash is None

    def test_signing_in_again_reuses_the_same_account(
        self, client, session, google_client_id, monkeypatch
    ):
        monkeypatch.setattr(
            "app.api.routes.verify_google_id_token",
            _stub_verify(
                {"email": "repeat-google-user@example.com", "email_verified": True}
            ),
        )

        first = client.post("/api/auth/google", json={"credential": "the-credential"})
        second = client.post("/api/auth/google", json={"credential": "the-credential"})

        assert first.status_code == 200 and second.status_code == 200
        count = (
            session.query(User)
            .filter(User.email == "repeat-google-user@example.com")
            .count()
        )
        assert count == 1

    def test_links_to_an_existing_password_account_by_email_without_duplicating(
        self, client, session, google_client_id, monkeypatch
    ):
        from app.core.security import hash_password

        existing = User(
            email="already-has-a-password@example.com",
            password_hash=hash_password("correct-horse-battery"),
        )
        session.add(existing)
        session.flush()

        monkeypatch.setattr(
            "app.api.routes.verify_google_id_token",
            _stub_verify(
                {
                    "email": "already-has-a-password@example.com",
                    "email_verified": True,
                }
            ),
        )

        res = client.post("/api/auth/google", json={"credential": "the-credential"})

        assert res.status_code == 200
        count = (
            session.query(User)
            .filter(User.email == "already-has-a-password@example.com")
            .count()
        )
        assert count == 1
        # The original password still works -- Google sign-in must not have
        # cleared or altered it.
        login = client.post(
            "/api/auth/login",
            json={
                "email": "already-has-a-password@example.com",
                "password": "correct-horse-battery",
            },
        )
        assert login.status_code == 200

    def test_rejects_an_unverified_email(self, client, google_client_id, monkeypatch):
        monkeypatch.setattr(
            "app.api.routes.verify_google_id_token",
            _stub_verify(
                {"email": "unverified@example.com", "email_verified": False}
            ),
        )

        res = client.post("/api/auth/google", json={"credential": "the-credential"})

        assert res.status_code == 401

    def test_rejects_an_invalid_credential(self, client, google_client_id, monkeypatch):
        def _raise(token: str, client_id: str) -> dict:
            raise ValueError("bad signature")

        monkeypatch.setattr("app.api.routes.verify_google_id_token", _raise)

        res = client.post("/api/auth/google", json={"credential": "garbage"})

        assert res.status_code == 401

    def test_is_disabled_when_no_client_id_is_configured(self, client, monkeypatch):
        # An env var always wins over whatever is in .env (see the
        # google_client_id fixture above, which relies on the same
        # precedence to inject a fake id) -- forcing it empty here is what
        # actually simulates "unconfigured", regardless of what a real
        # developer's local .env happens to contain.
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "")
        get_settings.cache_clear()
        try:
            res = client.post(
                "/api/auth/google", json={"credential": "the-credential"}
            )
            assert res.status_code == 503
        finally:
            get_settings.cache_clear()

    def test_a_google_only_account_cannot_log_in_with_a_password(
        self, client, session, google_client_id, monkeypatch
    ):
        monkeypatch.setattr(
            "app.api.routes.verify_google_id_token",
            _stub_verify(
                {"email": "google-only@example.com", "email_verified": True}
            ),
        )
        client.post("/api/auth/google", json={"credential": "the-credential"})

        res = client.post(
            "/api/auth/login",
            json={"email": "google-only@example.com", "password": "anything-at-all"},
        )

        assert res.status_code == 401
        assert res.json()["detail"] == "invalid email or password"
