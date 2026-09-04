"""Persisted history of what the system surfaced, and when.

The brief is recomputed from snapshots on every read, so in principle the
timeline could be derived too. It is stored instead, for one reason: the
derivation is only stable while its inputs are. Baselines shift as the window
advances and old snapshots age out, so recomputing last Tuesday's brief next
month can legitimately produce a different answer.

A user checking "what was I told on Tuesday?" needs the answer that was
actually shown to them. That is a record, not a recomputation.

Rows are written when the user marks a brief as read, which is the moment the
window closes and its contents become historical fact.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.models import DetectedChange
from app.persistence.models import MeaningfulChange, WatchlistItem


def record_changes(
    session: Session,
    watchlist_id: int,
    checkpoint_id: int,
    changes: Sequence[DetectedChange],
    detected_at: datetime,
) -> int:
    """Persist surfaced changes against the checkpoint that closed their window.

    Returns the number of rows written. Only meaningful changes are stored --
    keeping a row for every quiet symbol on every check would grow without
    bound to record that nothing happened.
    """
    if not changes:
        return 0

    # One query to map symbols to item ids, rather than one lookup per change.
    item_ids = {
        row.symbol: row.id
        for row in session.execute(
            select(WatchlistItem).where(WatchlistItem.watchlist_id == watchlist_id)
        ).scalars()
    }

    written = 0
    for change in changes:
        item_id = item_ids.get(change.symbol)
        if item_id is None:
            # The symbol was removed between the brief being generated and the
            # checkpoint being saved. Nothing to attach the record to.
            continue

        session.add(
            MeaningfulChange(
                watchlist_item_id=item_id,
                checkpoint_id=checkpoint_id,
                detected_at=detected_at,
                change_type=change.change_type.value,
                severity=change.severity.value,
                score=change.score,
                previous_value=change.previous_value,
                current_value=change.current_value,
                change_pct=change.change_pct,
                # The reasons are stored as written, so the timeline shows the
                # explanation the user actually saw rather than one regenerated
                # against today's constants.
                explanation=json.dumps(
                    [
                        {
                            "code": r.code,
                            "text": r.text,
                            "contribution": r.contribution,
                        }
                        for r in change.reasons
                    ]
                ),
                source_timestamp=change.source_timestamp,
                freshness=change.freshness,
            )
        )
        written += 1

    session.flush()
    return written


def load_timeline(
    session: Session,
    watchlist_id: int,
    limit: int = 50,
    before_id: int | None = None,
) -> list[tuple[MeaningfulChange, str]]:
    """Recent surfaced changes, newest first, with each row's symbol.

    Keyset pagination on the primary key rather than OFFSET: offsets get slower
    as the history grows and can skip or repeat rows when new entries arrive
    mid-scroll.
    """
    query = (
        select(MeaningfulChange, WatchlistItem.symbol)
        .join(WatchlistItem, MeaningfulChange.watchlist_item_id == WatchlistItem.id)
        .where(WatchlistItem.watchlist_id == watchlist_id)
        .order_by(MeaningfulChange.id.desc())
        .limit(limit)
    )
    if before_id is not None:
        query = query.where(MeaningfulChange.id < before_id)

    return [(row[0], row[1]) for row in session.execute(query).all()]
