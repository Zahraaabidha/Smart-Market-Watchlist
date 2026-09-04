"""Centralised configuration. Every tunable lives here or in the environment.

No secret has a usable default. `SECRET_KEY` intentionally has no production
fallback -- the app refuses to start in non-demo mode without one, rather than
silently signing tokens with a value that is public in the git history.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEMO_SECRET = "insecure-demo-key-do-not-use-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "Smart Market Watchlist"
    environment: str = "development"
    demo_mode: bool = True

    database_url: str = "postgresql+psycopg://watchlist:watchlist@localhost:5432/watchlist"

    secret_key: str = DEMO_SECRET
    access_token_ttl_minutes: int = 60 * 12

    # Ingestion cadence. One shared poll per interval serves every user, so
    # this is a global cost, not a per-request one.
    ingest_interval_seconds: int = 15
    # How much per-symbol history the engine keeps for baseline computation.
    baseline_window_size: int = 40

    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    @field_validator("secret_key")
    @classmethod
    def _reject_demo_secret_in_production(cls, value: str, info) -> str:
        env = (info.data or {}).get("environment", "development")
        if env == "production" and value == DEMO_SECRET:
            raise ValueError(
                "SECRET_KEY must be set to a real value when ENVIRONMENT=production"
            )
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
