"""HTTP routes.

Handlers stay thin on purpose: parse, delegate, serialize. Any logic that
needs a test lives in `app.services` or `app.domain`, where it can be tested
without spinning up a request.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import current_user, utcnow
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.security import (
    create_access_token,
    hash_password,
    verify_google_id_token,
    verify_password,
)
from app.integrations.replay import FailingProvider, ReplayProvider
from app.persistence.db import get_session
from app.persistence.models import MarketSnapshot, User, UserCheckpoint
from app.services import brief as brief_service
from app.services import history as history_service
from app.services import watchlists as wl
from app.services.backfill import backfill

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
    # be used to discover which email addresses have accounts. A Google-only
    # account has no password_hash to check against -- it must fail the same
    # way as a wrong password, not raise.
    if (
        user is None
        or user.password_hash is None
        or not verify_password(payload.password, user.password_hash)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid email or password",
        )

    return schemas.TokenResponse(access_token=create_access_token(user.id))


@auth_router.post("/google", response_model=schemas.TokenResponse)
def google_login(
    payload: schemas.GoogleAuthRequest, session: Session = Depends(get_session)
) -> schemas.TokenResponse:
    settings = get_settings()
    if not settings.google_client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is not configured",
        )

    try:
        claims = verify_google_id_token(payload.credential, settings.google_client_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid Google credential",
        ) from exc

    if not claims.get("email_verified") or not claims.get("email"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google account has no verified email",
        )
    email = claims["email"].lower()

    user = session.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()

    if user is None:
        # No password on a Google-created account: there is nothing for the
        # password login path to ever match, by design (see login() above).
        user = User(email=email, password_hash=None)
        try:
            with session.begin_nested():
                session.add(user)
                session.flush()
        except IntegrityError:
            # Lost a race with a concurrent signup for the same email -- load
            # the row that won rather than creating a second account.
            user = session.execute(
                select(User).where(User.email == email)
            ).scalar_one()
        else:
            wl.create_default_watchlist(session, user)

    # An existing email/password account signing in with Google for the
    # first time is linked by email rather than duplicated; it keeps working
    # with its original password too.
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
    request: Request,
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
    status = getattr(request.app.state, "market_status", None)

    return schemas.BriefResponse(
        watchlist_id=result.watchlist_id,
        watchlist_name=result.watchlist_name,
        last_checked_at=result.last_checked_at,
        generated_at=result.generated_at,
        monitored_count=result.monitored_count,
        meaningful_count=len(result.attention),
        attention=[
            _change_to_schema(c, result.paths, result.market_source)
            for c in result.attention
        ],
        quiet=[_change_to_schema(c, {}, result.market_source) for c in result.quiet],
        unavailable_symbols=result.unavailable_symbols,
        overall_freshness=result.overall_freshness,
        window_truncated=result.window_truncated,
        market_source=result.market_source,
        degraded=bool(getattr(status, "degraded", False)),
    )


@brief_router.get(
    "/watchlists/{watchlist_id}/path/{symbol}",
    response_model=schemas.SymbolPathResponse,
)
def get_symbol_path(
    watchlist_id: int,
    symbol: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
    now: datetime = Depends(utcnow),
):
    """Full-resolution price path for one watched symbol, for the detail view.

    The symbol must be on the watchlist -- an arbitrary symbol returns 404, the
    same answer as a watchlist that is not the caller's, so ownership and
    membership leak nothing by their error codes.
    """
    try:
        watchlist = wl.get_owned_watchlist(session, user, watchlist_id)
    except AppError as exc:
        raise _fail(exc) from exc

    wanted = symbol.upper()
    if not any(item.symbol == wanted for item in watchlist.items):
        raise HTTPException(status_code=404, detail="symbol not on this watchlist")

    path = brief_service.build_symbol_path(session, watchlist, wanted, now)
    if path is None:
        raise HTTPException(
            status_code=404, detail="no market data on record for this symbol"
        )

    return schemas.SymbolPathResponse(
        symbol=path.symbol,
        points=[
            schemas.PathPoint(t=t, price=p, gap_before=gap)
            for t, p, gap in path.points
        ],
        checkpoint_at=path.checkpoint_at,
        checkpoint_price=path.checkpoint_price,
        window_high=path.window_high,
        window_low=path.window_low,
        window_start=path.window_start,
        window_end=path.window_end,
        current_value=path.current_value,
        source=path.source,
        source_timestamp=path.source_timestamp,
        received_at=path.received_at,
        freshness=path.freshness,
        last_checked_at=path.last_checked_at,
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


def _path_to_schema(path) -> schemas.PricePath:
    return schemas.PricePath(
        points=[
            schemas.PathPoint(t=t, price=p, gap_before=gap)
            for t, p, gap in path.points
        ],
        checkpoint_at=path.checkpoint_at,
        checkpoint_price=path.checkpoint_price,
        window_high=path.window_high,
        window_low=path.window_low,
        window_start=path.window_start,
        window_end=path.window_end,
    )


def _change_to_schema(change, paths, market_source) -> schemas.ChangeResponse:
    path = paths.get(change.symbol)
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
        source=market_source if market_source != "none" else None,
        path=_path_to_schema(path) if path is not None else None,
    )


# --- market source & demo controls ------------------------------------------

ops_router = APIRouter(tags=["ops"])


@ops_router.get("/market/source", response_model=schemas.MarketSourceResponse)
def market_source(request: Request) -> schemas.MarketSourceResponse:
    """What is actually feeding the product right now, and whether it degraded.

    Reads process state written by the ingestion loop -- no database hit. The
    UI uses this to label data honestly ("Replay data" vs "Live") and to show a
    degraded badge instead of pretending a dead vendor is healthy.
    """
    settings = get_settings()
    status = getattr(request.app.state, "market_status", None)
    provider = getattr(request.app.state, "provider", None)
    provider_name = getattr(provider, "name", "replay")

    return schemas.MarketSourceResponse(
        provider=provider_name,
        mode="live" if settings.market_provider == "live" else "replay",
        degraded=bool(getattr(status, "degraded", False)),
        degraded_reason=getattr(status, "degraded_reason", None),
        last_poll_at=getattr(status, "last_poll_at", None),
        last_success_at=getattr(status, "last_success_at", None),
        demo_mode=settings.demo_mode,
    )


demo_router = APIRouter(prefix="/demo", tags=["demo"])

# Candidate absence windows for the in-app demo, tried in order. The replay
# series is deterministic per timestamp but which symbols are "interesting"
# depends on where the wall clock currently sits, so the demo picks the first
# window that actually surfaces a meaningful change (falling back to the first).
_DEMO_AWAY_CANDIDATES = (
    timedelta(hours=3),
    timedelta(hours=4),
)
_DEMO_BACKFILL = timedelta(hours=7)


@demo_router.post("/replay", status_code=200)
def demo_replay(
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
    now: datetime = Depends(utcnow),
) -> dict[str, str]:
    """Reproduce the product's core scenario for the signed-in user.

    check (a few hours ago) -> market moves -> return (now) -> brief explains it.

    Deterministic in substance: the replay series is a pure function of
    timestamp. The absence window is chosen from a fixed ordered list so the
    demo reliably lands on a window that has something to explain. Only
    meaningful in demo_mode; the router is not mounted otherwise.
    """
    watchlist = wl.list_watchlists(session, user)[0]

    # Make sure the demo universe is present so there is something varied to
    # rank. Adding is idempotent, so re-running is safe.
    for symbol in wl.DEFAULT_SYMBOLS:
        wl.add_item(session, user, watchlist.id, symbol)
    session.flush()
    watchlist = wl.get_owned_watchlist(session, user, watchlist.id)

    provider = ReplayProvider()
    symbols = [item.symbol for item in watchlist.items]
    # Backfill any symbol whose coverage of the demo window is thin. `backfill`
    # goes through the normal ingest path (ON CONFLICT DO NOTHING), so symbols
    # the shared ingestion loop already filled cost only a fast no-op scan and a
    # freshly added symbol gets a gap-free series.
    window_start = now - _DEMO_AWAY_CANDIDATES[-1]
    covered = dict(
        session.execute(
            select(MarketSnapshot.symbol, func.count())
            .where(
                MarketSnapshot.symbol.in_(symbols),
                MarketSnapshot.source_timestamp >= window_start,
                MarketSnapshot.source_timestamp <= now,
                MarketSnapshot.out_of_order.is_(False),
            )
            .group_by(MarketSnapshot.symbol)
        ).all()
    )
    thin = [s for s in symbols if covered.get(s, 0) < 200]
    if thin:
        backfill(session, provider, thin, now, window=_DEMO_BACKFILL)
        session.flush()

    def _reset_checkpoints() -> None:
        # A demo *reset*: drop this watchlist's checkpoints so the window is
        # exactly the one we choose, not whatever the account last marked as
        # read. The only place checkpoints are deleted, scoped to the caller's
        # own watchlist, demo-mode only.
        session.query(UserCheckpoint).filter(
            UserCheckpoint.watchlist_id == watchlist.id
        ).delete(synchronize_session=False)
        session.flush()

    chosen = _DEMO_AWAY_CANDIDATES[0]
    for away in _DEMO_AWAY_CANDIDATES:
        _reset_checkpoints()
        wl.record_checkpoint(
            session, user, watchlist.id, now - away, f"demo-{int(now.timestamp())}"
        )
        session.flush()
        result = brief_service.build_brief(session, user, watchlist, now)
        if result.attention:
            chosen = away
            break
    else:
        # None surfaced anything; keep the last (first-candidate) checkpoint.
        _reset_checkpoints()
        wl.record_checkpoint(
            session, user, watchlist.id, now - chosen, f"demo-{int(now.timestamp())}"
        )

    session.commit()
    return {
        "checked_at": (now - chosen).isoformat(),
        "returned_at": now.isoformat(),
        "away_for": str(chosen),
    }


@demo_router.post("/provider", status_code=200)
def demo_provider(
    payload: schemas.DemoProviderRequest, request: Request
) -> schemas.MarketSourceResponse:
    """Swap the running provider to demonstrate degradation and failover.

    `failing` proves the product keeps serving last-known-good data with an
    explicit degraded badge instead of erroring. `replay` restores the default.
    """
    settings = get_settings()
    if payload.mode == "failing":
        request.app.state.provider = FailingProvider()
    elif payload.mode == "live" and settings.twelve_data_api_key:
        from app.integrations.fallback import FallbackProvider
        from app.integrations.twelve_data import TwelveDataProvider

        request.app.state.provider = FallbackProvider(
            TwelveDataProvider(
                api_key=settings.twelve_data_api_key,
                exchange=settings.twelve_data_exchange,
            ),
            ReplayProvider(),
        )
    else:
        request.app.state.provider = ReplayProvider()

    status = request.app.state.market_status
    status.mode = request.app.state.provider.name
    status.degraded = payload.mode == "failing"
    status.degraded_reason = (
        "demo: provider forced into a failing state"
        if payload.mode == "failing"
        else None
    )
    return market_source(request)


router.include_router(auth_router)
router.include_router(prefs_router)
router.include_router(watchlist_router)
router.include_router(brief_router)
router.include_router(ops_router)

if get_settings().demo_mode:
    router.include_router(demo_router)
