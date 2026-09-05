"""Application entrypoint and background ingestion loop."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.routes import router
from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.integrations.fallback import FallbackProvider
from app.integrations.provider import MarketDataProvider
from app.integrations.replay import ReplayProvider
from app.persistence.db import SessionLocal, engine
from app.persistence.models import Base
from app.services.backfill import backfill, symbols_without_history
from app.services.ingestion import poll_and_ingest
from app.services.watchlists import all_watched_symbols

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class MarketStatus:
    """What the last ingestion pass observed, for the /market/source endpoint."""

    mode: str = "replay"
    last_poll_at: datetime | None = None
    last_success_at: datetime | None = None
    degraded: bool = False
    degraded_reason: str | None = None


def build_provider(cfg: Settings) -> MarketDataProvider:
    """Choose the market data provider from configuration.

    Replay is the default and always the fallback: it needs no credentials and
    is deterministic. "live" wraps Twelve Data but only if a key is actually
    present -- a misconfigured live mode degrades to replay with a warning
    rather than failing to start.
    """
    if cfg.market_provider == "live" and cfg.twelve_data_api_key:
        # Imported lazily so a replay-only deployment never imports httpx.
        from app.integrations.twelve_data import TwelveDataProvider

        primary = TwelveDataProvider(
            api_key=cfg.twelve_data_api_key,
            exchange=cfg.twelve_data_exchange,
        )
        return FallbackProvider(primary, ReplayProvider())

    if cfg.market_provider == "live":
        logger.warning(
            "MARKET_PROVIDER=live but TWELVE_DATA_API_KEY is unset; using replay"
        )
    return ReplayProvider()


# One provider instance for the process. Held on the app so demo controls and
# tests can swap it without reaching into module state.
provider = build_provider(settings)


async def _ingestion_loop(app: FastAPI) -> None:
    """Poll the provider once per interval for the union of all watched symbols.

    This is the "shared ingestion" requirement in practice: cost scales with
    distinct symbols, not with users or page views. It lives in-process as an
    asyncio task because at this scale a separate worker would add deployment
    complexity without solving a problem we actually have. The extraction point
    is documented in the README.
    """
    while True:
        try:
            await asyncio.to_thread(_run_one_pass, app)
        except asyncio.CancelledError:
            raise
        except Exception:
            # The loop must survive any single failed pass. A provider outage
            # or a transient database error should degrade the data, not kill
            # ingestion for the lifetime of the process.
            logger.exception("ingestion pass failed; continuing")

        await asyncio.sleep(settings.ingest_interval_seconds)


def _run_one_pass(app: FastAPI) -> None:
    with SessionLocal() as session:
        symbols = all_watched_symbols(session)
        if not symbols:
            return

        now = datetime.now(timezone.utc)

        # A symbol nobody has watched before has no history, so its baseline
        # would be unreliable forever and the "unusual for this stock" signal
        # could never fire. Backfilling on first sight is what makes the engine
        # work from the first brief rather than after hours of uptime.
        fresh_symbols = symbols_without_history(session, symbols)
        if fresh_symbols:
            backfill(session, app.state.provider, fresh_symbols, now)
            session.commit()

        result = poll_and_ingest(session, app.state.provider, symbols, now)
        session.commit()

        # Record what this pass observed so /market/source can report it
        # without touching the database. `name` on a FallbackProvider already
        # proxies to whichever provider actually served.
        prov = app.state.provider
        status: MarketStatus = app.state.market_status
        status.last_poll_at = now
        status.mode = getattr(prov, "name", "replay")
        status.degraded = bool(getattr(prov, "degraded", False)) or result.provider_failed
        status.degraded_reason = getattr(prov, "degraded_reason", None) or (
            "provider returned no data" if result.provider_failed else None
        )
        if not result.provider_failed and (result.inserted or result.duplicates):
            status.last_success_at = now

        if result.out_of_order or result.provider_failed:
            logger.info(
                "ingest: inserted=%s duplicates=%s out_of_order=%s failed=%s",
                result.inserted,
                result.duplicates,
                result.out_of_order,
                result.provider_failed,
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    # Schema-drift repair: `password_hash` was NOT NULL when the users table
    # was first created. Google Sign-In later needed password-less accounts
    # and the model changed to nullable, but `create_all` never alters an
    # existing table, so a database provisioned before that change still
    # enforces the old constraint -- crashing every first-time Google sign-in
    # with an IntegrityError. A no-op once the column is already nullable.
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"))
    app.state.provider = provider
    app.state.market_status = MarketStatus(
        mode=getattr(provider, "name", "replay")
    )

    task = asyncio.create_task(_ingestion_loop(app))
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AppError)
async def _app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})


@app.exception_handler(Exception)
async def _unhandled_handler(_: Request, exc: Exception) -> JSONResponse:
    """Never leak internals to the client.

    The stack trace goes to the log where an operator can see it; the caller
    gets a generic message, so an unexpected failure cannot become an
    information disclosure.
    """
    logger.exception("unhandled error", exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


@app.get("/health", tags=["ops"])
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(router, prefix="/api")
