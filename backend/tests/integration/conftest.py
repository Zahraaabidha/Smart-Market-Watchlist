"""Integration test fixtures.

These require a real PostgreSQL instance: the ingestion path depends on
`ON CONFLICT ... WHERE`, which is Postgres-specific and is precisely the
mechanism under test. Running these against SQLite would test a different
system than the one that ships, so they skip loudly instead.

Start the database with:  docker compose up -d db
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.persistence.models import Base

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+psycopg://watchlist:watchlist@localhost:5432/watchlist",
)


def _database_available() -> bool:
    try:
        probe = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
        with probe.connect() as conn:
            conn.execute(text("SELECT 1"))
        probe.dispose()
        return True
    except Exception:
        return False


requires_db = pytest.mark.skipif(
    not _database_available(),
    reason=f"PostgreSQL not reachable at {TEST_DATABASE_URL}; run: docker compose up -d db",
)


@pytest.fixture(scope="session")
def engine():
    if not _database_available():
        pytest.skip("PostgreSQL not reachable")
    eng = create_engine(TEST_DATABASE_URL)
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine):
    """A session on a transaction that is always rolled back.

    Each test sees a clean database without paying to recreate the schema, and
    tests cannot leak state into one another.
    """
    connection = engine.connect()
    transaction = connection.begin()
    factory = sessionmaker(bind=connection, autoflush=False, expire_on_commit=False)
    db = factory()
    try:
        yield db
    finally:
        db.close()
        transaction.rollback()
        connection.close()


@pytest.fixture
def user(session):
    from app.core.security import hash_password
    from app.persistence.models import User

    account = User(
        email=f"user-{uuid.uuid4().hex[:8]}@example.com",
        password_hash=hash_password("correct-horse-battery"),
    )
    session.add(account)
    session.flush()
    return account


@pytest.fixture
def other_user(session):
    from app.core.security import hash_password
    from app.persistence.models import User

    account = User(
        email=f"other-{uuid.uuid4().hex[:8]}@example.com",
        password_hash=hash_password("correct-horse-battery"),
    )
    session.add(account)
    session.flush()
    return account
