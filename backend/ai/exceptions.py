"""AI response model and provider exceptions.

These definitions are independent — neither depends on backend.ai
package internals, avoiding circular imports.
"""

from __future__ import annotations

from typing import Any


class MissingCredentialsError(Exception):
    """Raised when a provider lacks the required credentials/configuration."""

    def __init__(self, provider_name: str, missing: list[str]):
        self.provider_name = provider_name
        self.missing = missing
        super().__init__(
            f"Provider '{provider_name}' missing required credentials: {', '.join(missing)}"
        )


class ProviderFailureError(Exception):
    """Raised when a provider returns an error or malformed response."""

    def __init__(
        self,
        provider_name: str,
        message: str,
        status_code: int | None = None,
        raw: dict[str, Any] | None = None,
    ):
        self.provider_name = provider_name
        self.message = message
        self.status_code = status_code
        self.raw = raw or {}
        super().__init__(
            f"Provider '{provider_name}' failure: {message}"
            + (f" (status {status_code})" if status_code else "")
        )


class ProviderTimeoutError(Exception):
    """Raised when a provider request times out."""

    def __init__(self, provider_name: str, timeout: float):
        self.provider_name = provider_name
        self.timeout = timeout
        super().__init__(
            f"Provider '{provider_name}' request timed out after {timeout}s"
        )