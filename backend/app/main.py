"""Application entrypoint and background ingestion loop."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import get_settings
from app.core.errors import AppError
from app.integrations.replay import ReplayProvider
from app.persistence.db import SessionLocal, engine
from app.persistence.models import Base
from app.services.backfill import backfill, symbols_without_history
from app.services.ingestion import poll_and_ingest
from app.services.watchlists import all_watched_symbols

logger = logging.getLogger(__name__)
settings = get_settings()

# One provider instance for the process. Held on the app so demo controls and
# tests can swap it without reaching into module state.
provider = ReplayProvider()


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
    app.state.provider = provider

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
