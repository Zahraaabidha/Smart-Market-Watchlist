"""Password hashing, access tokens, and Google ID token verification."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import get_settings

# bcrypt has a hard 72-byte input limit and silently truncates beyond it.
# Passwords are length-capped at the schema layer so no user ends up with a
# password whose tail is ignored.
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

ALGORITHM = "HS256"


def hash_password(plain: str) -> str:
    return _pwd.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd.verify(plain, hashed)


def create_access_token(user_id: int) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int(
            (now + timedelta(minutes=settings.access_token_ttl_minutes)).timestamp()
        ),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> int | None:
    """Return the user id, or None for any invalid token.

    Every failure mode collapses to None on purpose. Distinguishing "expired"
    from "bad signature" in the response would tell an attacker which of their
    guesses was structurally correct.
    """
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        return None

    subject = payload.get("sub")
    if subject is None:
        return None
    try:
        return int(subject)
    except (TypeError, ValueError):
        return None


# One shared HTTP transport for verifying Google ID tokens. google-auth uses
# it to fetch and cache Google's public keys rather than one per request.
_google_request = google_requests.Request()


def verify_google_id_token(token: str, client_id: str) -> dict:
    """Verify a Google Identity Services credential and return its claims.

    Delegates signature, issuer, expiry, and audience checks to google-auth
    rather than reimplementing JWKS handling -- this is the one place where
    getting verification subtly wrong lets an attacker forge a session.
    Raises ValueError (via the underlying library) for any invalid token.
    """
    return google_id_token.verify_oauth2_token(
        token, _google_request, audience=client_id
    )
