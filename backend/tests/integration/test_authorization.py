"""Authorization and multi-tenancy tests.

The requirement is absolute: no user may reach another user's data by editing
an id. These tests attack the service layer directly, below the HTTP handlers,
because that is where the ownership checks actually live -- passing them at the
route layer alone would prove only that today's routes remember to call them.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.core.errors import Conflict, NotFound
from app.services import watchlists as wl

NOW = datetime(2026, 9, 4, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def victim_watchlist(session, other_user):
    watchlist = wl.create_default_watchlist(session, other_user)
    return watchlist


class TestCrossUserAccessIsDenied:
    def test_cannot_read_another_users_watchlist(self, session, user, victim_watchlist):
        with pytest.raises(NotFound):
            wl.get_owned_watchlist(session, user, victim_watchlist.id)

    def test_cannot_delete_another_users_watchlist(self, session, user, victim_watchlist):
        with pytest.raises(NotFound):
            wl.delete_watchlist(session, user, victim_watchlist.id)

    def test_cannot_add_an_item_to_another_users_watchlist(
        self, session, user, victim_watchlist
    ):
        with pytest.raises(NotFound):
            wl.add_item(session, user, victim_watchlist.id, "INFY")

    def test_cannot_remove_another_users_item(self, session, user, victim_watchlist):
        target = victim_watchlist.items[0]

        with pytest.raises(NotFound):
            wl.remove_item(session, user, victim_watchlist.id, target.id)

    def test_cannot_update_another_users_item(self, session, user, victim_watchlist):
        target = victim_watchlist.items[0]

        with pytest.raises(NotFound):
            wl.update_item(session, user, victim_watchlist.id, target.id, priority=1)

    def test_cannot_reorder_another_users_watchlist(
        self, session, user, victim_watchlist
    ):
        ids = [i.id for i in victim_watchlist.items]

        with pytest.raises(NotFound):
            wl.reorder_items(session, user, victim_watchlist.id, ids)

    def test_cannot_checkpoint_another_users_watchlist(
        self, session, user, victim_watchlist
    ):
        with pytest.raises(NotFound):
            wl.record_checkpoint(session, user, victim_watchlist.id, NOW)

    def test_item_id_from_another_watchlist_is_rejected(self, session, user, other_user):
        """Guards against checking the watchlist but trusting the item id.

        A user who owns watchlist A must not be able to mutate an item in
        watchlist B by passing their own watchlist id alongside a foreign item
        id.
        """
        mine = wl.create_default_watchlist(session, user)
        theirs = wl.create_default_watchlist(session, other_user)
        foreign_item = theirs.items[0]

        with pytest.raises(NotFound):
            wl.get_owned_item(session, user, mine.id, foreign_item.id)

    def test_nonexistent_ids_report_not_found_not_a_crash(self, session, user):
        with pytest.raises(NotFound):
            wl.get_owned_watchlist(session, user, 999_999)


class TestOwnerAccessStillWorks:
    def test_owner_can_read_their_own_watchlist(self, session, user):
        created = wl.create_default_watchlist(session, user)

        loaded = wl.get_owned_watchlist(session, user, created.id)

        assert loaded.id == created.id
        assert len(loaded.items) == len(wl.DEFAULT_SYMBOLS)

    def test_listing_returns_only_the_callers_watchlists(
        self, session, user, other_user
    ):
        wl.create_default_watchlist(session, user)
        wl.create_default_watchlist(session, other_user)

        mine = wl.list_watchlists(session, user)

        assert len(mine) == 1
        assert mine[0].user_id == user.id


class TestDuplicateUserOperations:
    def test_adding_the_same_symbol_twice_is_idempotent(self, session, user):
        watchlist = wl.create_watchlist(session, user, "Test")

        first = wl.add_item(session, user, watchlist.id, "INFY")
        second = wl.add_item(session, user, watchlist.id, "INFY")

        assert first.id == second.id
        assert len(wl.get_owned_watchlist(session, user, watchlist.id).items) == 1

    def test_symbols_are_normalised_so_case_is_not_a_duplicate_loophole(
        self, session, user
    ):
        watchlist = wl.create_watchlist(session, user, "Test")

        wl.add_item(session, user, watchlist.id, "infy")
        wl.add_item(session, user, watchlist.id, "INFY")

        items = wl.get_owned_watchlist(session, user, watchlist.id).items
        assert [i.symbol for i in items] == ["INFY"]

    def test_duplicate_watchlist_name_is_rejected(self, session, user):
        wl.create_watchlist(session, user, "Growth")

        with pytest.raises(Conflict):
            wl.create_watchlist(session, user, "Growth")

    def test_two_users_may_share_a_watchlist_name(self, session, user, other_user):
        wl.create_watchlist(session, user, "Growth")
        wl.create_watchlist(session, other_user, "Growth")

        assert len(wl.list_watchlists(session, user)) == 1
        assert len(wl.list_watchlists(session, other_user)) == 1


class TestCheckpointIdempotency:
    def test_same_key_returns_the_original_checkpoint(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)

        first = wl.record_checkpoint(session, user, watchlist.id, NOW, "key-1")
        second = wl.record_checkpoint(session, user, watchlist.id, NOW, "key-1")

        assert first.id == second.id

    def test_a_double_submit_cannot_collapse_the_comparison_window(
        self, session, user
    ):
        """The reason checkpoint idempotency exists.

        Two checkpoints seconds apart would leave the next brief comparing
        against a moment when nothing had happened yet, silently erasing what
        the user came back to read.
        """
        watchlist = wl.create_default_watchlist(session, user)

        wl.record_checkpoint(session, user, watchlist.id, NOW, "submit-1")
        wl.record_checkpoint(session, user, watchlist.id, NOW, "submit-1")

        from sqlalchemy import func, select

        from app.persistence.models import UserCheckpoint

        count = session.execute(
            select(func.count())
            .select_from(UserCheckpoint)
            .where(UserCheckpoint.watchlist_id == watchlist.id)
        ).scalar_one()

        assert count == 1

    def test_distinct_keys_create_distinct_checkpoints(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)

        first = wl.record_checkpoint(session, user, watchlist.id, NOW, "a")
        second = wl.record_checkpoint(session, user, watchlist.id, NOW, "b")

        assert first.id != second.id

    def test_checkpoint_without_a_key_is_always_new(self, session, user):
        """Absent a key we cannot know it is a retry, so we must not merge."""
        watchlist = wl.create_default_watchlist(session, user)

        first = wl.record_checkpoint(session, user, watchlist.id, NOW)
        second = wl.record_checkpoint(session, user, watchlist.id, NOW)

        assert first.id != second.id


class TestReorder:
    def test_reorder_applies_the_requested_positions(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)
        ids = [i.id for i in watchlist.items]
        reversed_ids = list(reversed(ids))

        result = wl.reorder_items(session, user, watchlist.id, reversed_ids)

        assert [i.id for i in result] == reversed_ids

    def test_partial_reorder_is_rejected(self, session, user):
        watchlist = wl.create_default_watchlist(session, user)
        ids = [i.id for i in watchlist.items]

        with pytest.raises(Conflict):
            wl.reorder_items(session, user, watchlist.id, ids[:2])

    def test_reorder_with_a_foreign_id_is_rejected(self, session, user, other_user):
        mine = wl.create_default_watchlist(session, user)
        theirs = wl.create_default_watchlist(session, other_user)
        ids = [i.id for i in mine.items][:-1] + [theirs.items[0].id]

        with pytest.raises(Conflict):
            wl.reorder_items(session, user, mine.id, ids)
