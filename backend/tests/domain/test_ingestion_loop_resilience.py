"""Loop-level resilience.

`poll_and_ingest` already degrades gracefully on its own -- a total provider
outage, a partial batch failure, an empty symbol list are all covered in
`tests/integration/test_ingestion.py`. This file is about the orchestration
wrapper *around* it: does something escaping one pass (a DB hiccup, a bug, a
timeout -- anything) ever stop `_ingestion_loop` from attempting the next
pass, and does the loop actually stop when asked to.

No real event loop timing is depended on: `ingest_interval_seconds` is
patched to 0 so iterations happen back-to-back, and `_run_one_pass` itself is
replaced with a stand-in so this exercises only the loop's own control flow,
not the database or a provider.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from app import main as main_module

pytestmark = pytest.mark.asyncio


async def test_loop_survives_an_exception_in_one_pass_and_tries_again():
    calls = 0

    def fake_pass(app):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("simulated failure escaping one pass")

    with (
        patch.object(main_module, "_run_one_pass", side_effect=fake_pass),
        patch.object(main_module.settings, "ingest_interval_seconds", 0),
    ):
        task = asyncio.create_task(main_module._ingestion_loop(app=None))
        try:
            for _ in range(200):
                if calls >= 2:
                    break
                await asyncio.sleep(0.01)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    assert calls >= 2, (
        "a pass that raised must not prevent the loop from attempting another"
    )


async def test_loop_keeps_going_across_several_consecutive_failures():
    """Not just one bad pass -- a run of them (e.g. the DB unreachable for a
    stretch) must not exhaust the loop's willingness to keep trying.
    """
    calls = 0

    def always_fails(app):
        nonlocal calls
        calls += 1
        raise RuntimeError("simulated sustained outage")

    with (
        patch.object(main_module, "_run_one_pass", side_effect=always_fails),
        patch.object(main_module.settings, "ingest_interval_seconds", 0),
    ):
        task = asyncio.create_task(main_module._ingestion_loop(app=None))
        try:
            for _ in range(200):
                if calls >= 5:
                    break
                await asyncio.sleep(0.01)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    assert calls >= 5, "repeated failures in a row must not stop the loop"


async def test_loop_stops_cleanly_on_cancellation():
    """Shutdown (the app lifespan's `task.cancel()`) must actually stop the
    loop rather than being swallowed by the broad `except Exception` guarding
    each pass -- `CancelledError` is re-raised, not logged-and-continued.
    """
    with (
        patch.object(main_module, "_run_one_pass", return_value=None),
        patch.object(main_module.settings, "ingest_interval_seconds", 0),
    ):
        task = asyncio.create_task(main_module._ingestion_loop(app=None))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert task.cancelled()
