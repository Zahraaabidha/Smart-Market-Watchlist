"""Domain-level error types.

The service layer raises these instead of HTTPException so that business logic
stays independent of the web framework and remains unit-testable without a
request context. The API layer maps them to status codes in one place.
"""

from __future__ import annotations


class AppError(Exception):
    """Base class for expected, user-facing failures."""

    status_code = 400

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class NotFound(AppError):
    status_code = 404


class Conflict(AppError):
    status_code = 409


class Unauthorized(AppError):
    status_code = 401


class ProviderUnavailable(AppError):
    status_code = 503
