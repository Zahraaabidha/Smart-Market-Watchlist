"""Deterministic demo scenario.

Reconstructs the story the product exists for:

    the user checks at time A
    the market moves while they are away
    they return at time B
    the system reconstructs what happened, ranks it, and explains it

Run with:  python -m app.demo

Every number is reproducible: the replay provider is seeded, and the scenario
pins its own `now` rather than reading the clock. Running this twice produces
identical output, which is what makes it usable as a demo and as a smoke test.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

from app.core.security import hash_password
from app.integrations.replay import EPOCH, ReplayProvider
from app.persistence.db import SessionLocal, engine
from app.persistence.models import Base, User
from app.services import watchlists as wl
from app.services.backfill import backfill
from app.services.brief import build_brief

# A real, routable-looking domain. Reserved special-use suffixes such as
# .local are rejected by the API's email validation, which would seed an
# account that exists in the database but can never sign in.
DEMO_EMAIL = "demo@example.com"
DEMO_PASSWORD = "demo-password-123"

# A fixed point on the replay timeline, chosen because this particular window
# exercises every part of the engine: a large move, a spike that reversed, and
# symbols that genuinely did nothing. The market is deterministic, so this is a
# selected illustrative moment, not a manufactured one -- any other timestamp
# produces a real but less varied brief.
SCENARIO_NOW = EPOCH + timedelta(days=14, hours=13)
AWAY_FOR = timedelta(hours=3)


def _reset_demo_user(session) -> User:
    existing = (
        session.query(User).filter(User.email == DEMO_EMAIL).one_or_none()
    )
    if existing is not None:
        # Cascades to watchlists, items and checkpoints, so re-running the
        # scenario always starts from the same state.
        session.delete(existing)
        session.flush()

    user = User(email=DEMO_EMAIL, password_hash=hash_password(DEMO_PASSWORD))
    session.add(user)
    session.flush()
    return user


def _print_change(change, index: int) -> None:
    arrow = "up" if change.change_pct > 0 else "down"
    print(f"  {index}. {change.symbol}  [{change.severity.value.upper()}]  score {change.score:.0f}")
    print(
        f"     {change.change_pct:+.2f}% {arrow}  "
        f"{change.previous_value} -> {change.current_value}  "
        f"({change.freshness}, source {change.source_timestamp:%H:%M:%S})"
    )
    print("     Why surfaced:")
    for reason in change.reasons:
        points = f"+{reason.contribution:.0f}" if reason.contribution > 0 else "   "
        print(f"       {points}  {reason.text}")
    print()


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv

    # --live anchors the scenario to the wall clock instead of the fixed replay
    # date, so the seeded account shows a populated brief in the running UI.
    # The market data is still fully deterministic; only the window moves.
    live = "--live" in argv
    scenario_now = datetime.now(timezone.utc) if live else SCENARIO_NOW

    Base.metadata.create_all(engine)
    provider = ReplayProvider()

    with SessionLocal() as session:
        user = _reset_demo_user(session)
        watchlist = wl.create_default_watchlist(session, user)

        # Give one symbol a tighter alert band and a priority flag, so the
        # threshold and priority signals have something to fire on.
        for item in watchlist.items:
            if item.symbol == "ZOMATO":
                item.priority = 1
        session.flush()

        symbols = [i.symbol for i in watchlist.items]

        print("Groww Focus - deterministic demo")
        print("=" * 60)
        print(f"Watchlist : {watchlist.name} ({len(symbols)} symbols)")
        print(f"Symbols   : {', '.join(symbols)}")
        print()

        checked_at = scenario_now - AWAY_FOR

        # Load the full window the user was away for, plus history before it so
        # baselines are reliable.
        print(f"Loading market history through {scenario_now:%Y-%m-%d %H:%M} UTC ...")
        rows = backfill(
            session, provider, symbols, scenario_now, window=timedelta(hours=9)
        )
        session.commit()
        print(f"  {rows} observations ingested\n")

        wl.record_checkpoint(
            session, user, watchlist.id, checked_at, "demo-scenario"
        )
        session.commit()

        print(f"User last checked : {checked_at:%H:%M:%S} UTC")
        print(f"User returns at   : {scenario_now:%H:%M:%S} UTC")
        print(f"Away for          : {AWAY_FOR}")
        print("=" * 60)
        print()

        # Evaluated at the scenario's own instant. Freshness is measured
        # against that same instant, so the fixed scenario does not depend on
        # when it happens to be run.
        result = build_brief(session, user, watchlist, scenario_now)

        print(f"MARKET BRIEF -- {result.monitored_count} monitored, "
              f"{len(result.attention)} meaningful changes")
        print(f"Overall data freshness: {result.overall_freshness}")
        print()

        if result.attention:
            print("NEEDS ATTENTION")
            print("-" * 60)
            for index, change in enumerate(result.attention, start=1):
                _print_change(change, index)
        else:
            print("Nothing crossed the attention threshold in this window.\n")

        if result.quiet:
            print("NO MEANINGFUL CHANGE")
            print("-" * 60)
            for change in result.quiet:
                print(
                    f"  {change.symbol:<12} {change.change_pct:+6.2f}%  "
                    f"{change.current_value}"
                )
            print()

        if result.unavailable_symbols:
            print(f"NO DATA: {', '.join(result.unavailable_symbols)}\n")

        print("=" * 60)
        if live:
            print(f"Seeded account: {DEMO_EMAIL} / {DEMO_PASSWORD}")
            print("Sign in with it to see this brief in the UI.")
        else:
            print("Re-running this command produces identical output.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
