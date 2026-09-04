"""HTTP routes.

Handlers stay thin on purpose: parse, delegate, serialize. Any logic that
needs a test lives in `app.services` or `app.domain`, where it can be tested
without spinning up a request.
"""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import current_user, utcnow
from app.core.errors import AppError
from app.core.security import create_access_token, hash_password, verify_password
from app.persistence.db import get_session
from app.persistence.models import User
from app.services import brief as brief_service
from app.services import history as history_service
from app.services import watchlists as wl

router = APIRouter()


def _fail(error: AppError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.message)


# --- auth ---------------------------------------------------------------

auth_router = APIRouter(prefix="/auth", tags=["auth"])


@auth_router.post("/register", response_model=schemas.TokenResponse, status_code=201)
def register(
    payload: schemas.RegisterRequest, session: Session = Depends(get_session)
) -> schemas.TokenResponse:
    email = payload.email.lower()

    user = User(email=email, password_hash=hash_password(payload.password))
    try:
        with session.begin_nested():
            session.add(user)
            session.flush()
    except IntegrityError as exc:
        # The unique index on email is the real guard; a pre-check SELECT
        # would still race under concurrent signups.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="an account with that email already exists",
        ) from exc

    # A new account lands on a populated brief rather than an empty page.
    wl.create_default_watchlist(session, user)

    return schemas.TokenResponse(access_token=create_access_token(user.id))


@auth_router.post("/login", response_model=schemas.TokenResponse)
def login(
    payload: schemas.LoginRequest, session: Session = Depends(get_session)
) -> schemas.TokenResponse:
    user = session.execute(
        select(User).where(User.email == payload.email.lower())
    ).scalar_one_or_none()

    # One message and one code for both failure modes, so the endpoint cannot
    # be used to discover which email addresses have accounts.
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid email or password",
        )

    return schemas.TokenResponse(access_token=create_access_token(user.id))


@auth_router.get("/me", response_model=schemas.UserResponse)
def me(user: User = Depends(current_user)) -> User:
    return user


# --- preferences ---------------------------------------------------------

prefs_router = APIRouter(prefix="/preferences", tags=["preferences"])


@prefs_router.get("", response_model=schemas.PreferencesResponse)
def get_preferences(user: User = Depends(current_user)) -> User:
    return user


@prefs_router.patch("", response_model=schemas.PreferencesResponse)
def update_preferences(
    payload: schemas.PreferencesUpdate,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> User:
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(user, field, value)
    session.flush()
    return user


# --- watchlists ----------------------------------------------------------

watchlist_router = APIRouter(prefix="/watchlists", tags=["watchlists"])


@watchlist_router.get("", response_model=list[schemas.WatchlistResponse])
def list_watchlists(
    user: User = Depends(current_user), session: Session = Depends(get_session)
):
    return wl.list_watchlists(session, user)


@watchlist_router.post("", response_model=schemas.WatchlistResponse, status_code=201)
def create_watchlist(
    payload: schemas.WatchlistCreate,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    try:
        return wl.create_watchlist(session, user, payload.name.strip())
    except AppError as exc:
        raise _fail(exc) from exc


@watchlist_router.get("/{watchlist_id}", response_model=schemas.WatchlistResponse)
def get_watchlist(
    watchlist_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    try:
        return wl.get_owned_watchlist(session, user, watchlist_id)
    except AppError as exc:
        raise _fail(exc) from exc


@watchlist_router.delete("/{watchlist_id}", status_code=204)
def delete_watchlist(
    watchlist_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> Response:
    try:
        wl.delete_watchlist(session, user, watchlist_id)
    except AppError as exc:
        raise _fail(exc) from exc
    return Response(status_code=204)


@watchlist_router.post(
    "/{watchlist_id}/items", response_model=schemas.ItemResponse, status_code=201
)
def add_item(
    watchlist_id: int,
    payload: schemas.ItemCreate,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    try:
        return wl.add_item(
            session,
            user,
            watchlist_id,
            symbol=payload.symbol,
            priority=payload.priority,
            threshold_above=payload.threshold_above,
            threshold_below=payload.threshold_below,
        )
    except AppError as exc:
        raise _fail(exc) from exc


@watchlist_router.patch(
    "/{watchlist_id}/items/{item_id}", response_model=schemas.ItemResponse
)
def update_item(
    watchlist_id: int,
    item_id: int,
    payload: schemas.ItemUpdate,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    try:
        return wl.update_item(
            session, user, watchlist_id, item_id, **payload.model_dump()
        )
    except AppError as exc:
        raise _fail(exc) from exc


@watchlist_router.delete("/{watchlist_id}/items/{item_id}", status_code=204)
def remove_item(
    watchlist_id: int,
    item_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> Response:
    try:
        wl.remove_item(session, user, watchlist_id, item_id)
    except AppError as exc:
        raise _fail(exc) from exc
    return Response(status_code=204)


@watchlist_router.put(
    "/{watchlist_id}/order", response_model=list[schemas.ItemResponse]
)
def reorder(
    watchlist_id: int,
    payload: schemas.ReorderRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    try:
        return wl.reorder_items(session, user, watchlist_id, payload.item_ids)
    except AppError as exc:
        raise _fail(exc) from exc


# --- brief and checkpoints -----------------------------------------------

brief_router = APIRouter(tags=["brief"])


@brief_router.get("/watchlists/{watchlist_id}/brief", response_model=schemas.BriefResponse)
def get_brief(
    watchlist_id: int,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
    now: datetime = Depends(utcnow),
):
    """The primary screen.

    Deliberately does NOT record a checkpoint. Viewing the brief and declaring
    it seen are separate actions: a user who glances at the page and navigates
    away has not read it, and silently checkpointing would erase the very
    changes they came back to see.
    """
    try:
        watchlist = wl.get_owned_watchlist(session, user, watchlist_id)
    except AppError as exc:
        raise _fail(exc) from exc

    result = brief_service.build_brief(session, user, watchlist, now)

    return schemas.BriefResponse(
        watchlist_id=result.watchlist_id,
        watchlist_name=result.watchlist_name,
        last_checked_at=result.last_checked_at,
        generated_at=result.generated_at,
        monitored_count=result.monitored_count,
        meaningful_count=len(result.attention),
        attention=[_change_to_schema(c) for c in result.attention],
        quiet=[_change_to_schema(c) for c in result.quiet],
        unavailable_symbols=result.unavailable_symbols,
        overall_freshness=result.overall_freshness,
        window_truncated=result.window_truncated,
    )


@brief_router.post(
    "/watchlists/{watchlist_id}/checkpoint",
    response_model=schemas.CheckpointResponse,
    status_code=201,
)
def create_checkpoint(
    watchlist_id: int,
    payload: schemas.CheckpointRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
    now: datetime = Depends(utcnow),
):
    """Explicitly mark the market as seen, resetting the comparison window.

    The brief is built *before* the new checkpoint is recorded, so the changes
    written to history are the ones whose window this checkpoint closes. Doing
    it the other way round would record an empty window every time.
    """
    try:
        watchlist = wl.get_owned_watchlist(session, user, watchlist_id)
        closing = brief_service.build_brief(session, user, watchlist, now)

        checkpoint = wl.record_checkpoint(
            session, user, watchlist_id, now, payload.idempotency_key
        )

        # A replayed idempotency key returns the original checkpoint, whose
        # history was written on the first call. Writing again would duplicate
        # the timeline entries that idempotency exists to prevent.
        if checkpoint.checked_at == now:
            history_service.record_changes(
                session, watchlist_id, checkpoint.id, closing.attention, now
            )

        return checkpoint
    except AppError as exc:
        raise _fail(exc) from exc


@brief_router.get(
    "/watchlists/{watchlist_id}/timeline",
    response_model=list[schemas.TimelineEntry],
)
def get_timeline(
    watchlist_id: int,
    limit: int = 50,
    before_id: int | None = None,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
):
    """What this watchlist surfaced previously, newest first."""
    try:
        wl.get_owned_watchlist(session, user, watchlist_id)
    except AppError as exc:
        raise _fail(exc) from exc

    limit = max(1, min(limit, 200))
    rows = history_service.load_timeline(session, watchlist_id, limit, before_id)

    return [
        schemas.TimelineEntry(
            id=row.id,
            symbol=symbol,
            change_type=row.change_type,
            severity=row.severity,
            score=float(row.score),
            previous_value=row.previous_value,
            current_value=row.current_value,
            change_pct=float(row.change_pct),
            detected_at=row.detected_at,
            source_timestamp=row.source_timestamp,
            freshness=row.freshness,
            reasons=[
                schemas.ReasonResponse(**r) for r in json.loads(row.explanation)
            ],
        )
        for row, symbol in rows
    ]


def _change_to_schema(change) -> schemas.ChangeResponse:
    return schemas.ChangeResponse(
        symbol=change.symbol,
        change_type=change.change_type.value,
        severity=change.severity.value,
        score=change.score,
        previous_value=change.previous_value,
        current_value=change.current_value,
        change_pct=change.change_pct,
        occurred_at=change.occurred_at,
        source_timestamp=change.source_timestamp,
        freshness=change.freshness,
        priority=change.priority,
        reasons=[
            schemas.ReasonResponse(
                code=r.code, text=r.text, contribution=r.contribution
            )
            for r in change.reasons
        ],
    )


router.include_router(auth_router)
router.include_router(prefs_router)
router.include_router(watchlist_router)
router.include_router(brief_router)
