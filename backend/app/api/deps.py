"""Shared request dependencies."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.persistence.db import get_session
from app.persistence.models import User

UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def current_user(
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
) -> User:
    """Resolve the caller from a bearer token.

    Every authenticated route depends on this, so there is exactly one place
    where identity is established. Routes receive a User object rather than an
    id, which removes the temptation to trust a user id from the request body.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise UNAUTHORIZED

    user_id = decode_access_token(authorization.split(" ", 1)[1].strip())
    if user_id is None:
        raise UNAUTHORIZED

    user = session.get(User, user_id)
    if user is None:
        # Valid signature for a deleted account.
        raise UNAUTHORIZED
    return user


def utcnow() -> datetime:
    """The single clock read for a request.

    Injected as a dependency so tests can freeze time and so every part of one
    brief is evaluated against the same instant. Reading the clock separately
    in each function would let a slow request classify one symbol as fresh and
    another as delayed for no reason but scheduling.
    """
    return datetime.now(timezone.utc)
