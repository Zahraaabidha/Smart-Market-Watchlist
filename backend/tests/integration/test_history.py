"""Tests for the persisted 'since you last checked' timeline."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from app.domain.models import ChangeType, DetectedChange, Reason, Severity
from app.services import history, watchlists as wl

NOW = datetime(2026, 9, 4, 12, 0, tzinfo=timezone.utc)


def make_change(symbol: str, score: float = 60.0) -> DetectedChange:
    return DetectedChange(
        symbol=symbol,
        change_type=ChangeType.PRICE_MOVE,
        severity=Severity.HIGH,
        score=score,
        previous_value=Decimal("100.00"),
        current_value=Decimal("104.80"),
        change_pct=4.8,
        occurred_at=NOW,
        reasons=[Reason("move_vs_threshold", "Moved 4.8% up.", 31.0)],
        source_timestamp=NOW,
        freshness="fresh",
        priority=2,
    )


class TestRecordingChanges:
    def test_surfaced_changes_are_persisted_against_the_checkpoint(
        self, session, user
    ):
        watchlist = wl.create_default_watchlist(session, user)
        checkpoint = wl.record_checkpoint(session, user, watchlist.id, NOW, "k1")

        written = history.record_changes(
            session, watchlist.id, checkpoint.id, [make_change("RELIANCE")], NOW
        )

        assert written == 1
        entries = history.load_timeline(session, watchlist.id)
        assert [symbol for _, symbol in entries] == ["RELIANCE"]

    def test_the_explanation_shown_to_the_user_is_stored_verbatim(
        self, session, user
    ):
        """The timeline must show what was said then, not a regeneration.

        Baselines shift as the window advances, so recomputing an old brief can
        legitimately produce different wording or a different score.
        """
        watchlist = wl.create_default_watchlist(session, user)
        checkpoint = wl.record_checkpoint(session, user, watchlist.id, NOW, "k1")
        history.record_changes(
            session, watchlist.id, checkpoint.id, [make_change("TCS")], NOW
        )

        (row, _), = history.load_timeline(session, watchlist.id)
        reasons = json.loads(row.explanation)

        assert reasons[0]["text"] == "Moved 4.8% up."
        assert reasons[0]["contribution"] == 31.0

    def test_empty_change_list_writes_nothing(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)
        checkpoint = wl.record_checkpoint(session, user, watchlist.id, NOW, "k1")

        assert history.record_changes(
            session, watchlist.id, checkpoint.id, [], NOW
        ) == 0

    def test_a_symbol_removed_before_saving_is_skipped_not_fatal(
        self, session, user
    ):
        """The watchlist can change between generating a brief and saving it."""
        watchlist = wl.create_default_watchlist(session, user)
        checkpoint = wl.record_checkpoint(session, user, watchlist.id, NOW, "k1")

        written = history.record_changes(
            session,
            watchlist.id,
            checkpoint.id,
            [make_change("RELIANCE"), make_change("NOT_ON_THE_LIST")],
            NOW,
        )

        assert written == 1


class TestTimelineOrderingAndPaging:
    def test_newest_entries_come_first(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)
        for index, symbol in enumerate(["RELIANCE", "TCS", "INFY"]):
            cp = wl.record_checkpoint(
                session, user, watchlist.id, NOW + timedelta(minutes=index), f"k{index}"
            )
            history.record_changes(
                session, watchlist.id, cp.id, [make_change(symbol)], NOW
            )

        entries = history.load_timeline(session, watchlist.id)

        assert [symbol for _, symbol in entries] == ["INFY", "TCS", "RELIANCE"]

    def test_limit_is_respected(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)
        cp = wl.record_checkpoint(session, user, watchlist.id, NOW, "k1")
        history.record_changes(
            session,
            watchlist.id,
            cp.id,
            [make_change(s) for s in ["RELIANCE", "TCS", "INFY"]],
            NOW,
        )

        assert len(history.load_timeline(session, watchlist.id, limit=2)) == 2

    def test_keyset_paging_continues_without_gaps_or_repeats(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)
        cp = wl.record_checkpoint(session, user, watchlist.id, NOW, "k1")
        history.record_changes(
            session,
            watchlist.id,
            cp.id,
            [make_change(s) for s in ["RELIANCE", "TCS", "INFY", "ZOMATO"]],
            NOW,
        )

        first = history.load_timeline(session, watchlist.id, limit=2)
        second = history.load_timeline(
            session, watchlist.id, limit=2, before_id=first[-1][0].id
        )

        first_ids = {row.id for row, _ in first}
        second_ids = {row.id for row, _ in second}
        assert len(second) == 2
        assert first_ids.isdisjoint(second_ids)

    def test_timeline_is_scoped_to_one_watchlist(self, session, user, other_user):
        """Another user's history must never appear in this timeline."""
        mine = wl.create_default_watchlist(session, user)
        theirs = wl.create_default_watchlist(session, other_user)

        my_cp = wl.record_checkpoint(session, user, mine.id, NOW, "a")
        their_cp = wl.record_checkpoint(session, other_user, theirs.id, NOW, "b")
        history.record_changes(session, mine.id, my_cp.id, [make_change("TCS")], NOW)
        history.record_changes(
            session, theirs.id, their_cp.id, [make_change("INFY")], NOW
        )

        assert [s for _, s in history.load_timeline(session, mine.id)] == ["TCS"]
        assert [s for _, s in history.load_timeline(session, theirs.id)] == ["INFY"]

    def test_empty_history_returns_an_empty_list(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)

        assert history.load_timeline(session, watchlist.id) == []
