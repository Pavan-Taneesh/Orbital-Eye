"""Fake/test AI provider for unit testing.

Implements the ProviderInterface using no external APIs. Useful for testing
the AI service and application layer without requiring a real paid AI API key.

Each call returns a deterministic, configurable response so tests are
predictable and fast.

Configuration can be set at the class level (default) or instance level
via __init__ kwargs. Class-level defaults apply unless overridden per-instance.
"""

from __future__ import annotations

import time
from typing import Any

from .exceptions import (
    ProviderFailureError,
    ProviderTimeoutError,
)
from .provider import ProviderInterface
from .response import AIResponse


class FakeProvider(ProviderInterface):
    """A fake/test AI provider that returns configurable responses.

    Useful for testing the AIService and application layer without
    requiring a real paid AI API key.

    Configuration can be set at the class level (defaults) or instance level
    via __init__ kwargs. Class-level defaults apply unless overridden.

    Defaults:
        - respond_with: "hello"
        - delay_seconds: 0.0
        - error_message: "simulated error"
        - model_name: "fake-model"
        - usage_input_tokens: 5
        - usage_output_tokens: 10
    """

    name: str = "fake_provider"

    # Class-level defaults
    respond_with: str = "hello"
    delay_seconds: float = 0.0
    error_message: str = "simulated error"
    model_name: str = "fake-model"
    usage_input_tokens: int = 5
    usage_output_tokens: int = 10

    def __init__(self, **kwargs: Any) -> None:
        """Override class-level defaults per-instance."""
        for key, value in kwargs.items():
            setattr(self, key, value)

    # Re-apply class defaults as fallbacks for any attributes not set instance-level
    @property
    def _effective_respond_with(self) -> str:
        return getattr(self, "respond_with", self.respond_with)

    @property
    def _effective_delay(self) -> float:
        return getattr(self, "delay_seconds", self.delay_seconds)

    @property
    def _effective_error_message(self) -> str:
        return getattr(self, "error_message", self.error_message)

    @property
    def _effective_model_name(self) -> str:
        return getattr(self, "model_name", self.model_name)

    @property
    def _effective_input_tokens(self) -> int:
        return getattr(self, "usage_input_tokens", self.usage_input_tokens)

    @property
    def _effective_output_tokens(self) -> int:
        return getattr(self, "usage_output_tokens", self.usage_output_tokens)

    def _sleep(self) -> None:
        """Artificial delay if configured."""
        time.sleep(self._effective_delay)

    def generate(
        self,
        prompt: str,
        system: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout: float | None = None,
    ) -> AIResponse:
        """Generate a response to the given prompt.

        Args:
            prompt: The user prompt/question.
            system: Optional system/instruction prompt.
            temperature: Sampling temperature (0-2+).
            max_tokens: Maximum tokens to generate.
            timeout: Request timeout in seconds.

        Returns:
            AIResponse with the provider's output and metadata.

        Raises:
            ProviderTimeoutError: If the request times out.
            ProviderFailureError: If respond_with="error".
        """
        self._sleep()

        if timeout is not None and timeout < self._effective_delay:
            raise ProviderTimeoutError(
                provider_name=self.name, timeout=timeout
            )

        if self._effective_respond_with == "error":
            raise ProviderFailureError(
                provider_name=self.name,
                message=self._effective_error_message,
            )

        if self._effective_respond_with == "timeout":
            raise ProviderTimeoutError(
                provider_name=self.name, timeout=timeout or 30.0
            )

        # If respond_with looks like JSON, return it directly for testing
        # Otherwise return a greeting message
        respond_with = self._effective_respond_with
        if respond_with.strip().startswith("{") and respond_with.strip().endswith("}"):
            content = respond_with
        else:
            content = (
                f"Hello! You prompted: '{prompt[:50]}...'"
                if len(prompt) > 50
                else f"Hello! You prompted: '{prompt}'"
            )

        return AIResponse(
            content=content,
            role="assistant",
            model=self._effective_model_name,
            usage={
                "input": self._effective_input_tokens,
                "output": self._effective_output_tokens,
                "total": self._effective_input_tokens + self._effective_output_tokens,
            },
            finish_reason="stop",
            raw={
                "provider": "fake",
                "prompt": prompt,
                "system": system,
            },
        )

    def validate(self, response: AIResponse) -> bool:
        """Validate a provider response for correct structure.

        Args:
            response: The AIResponse to validate.

        Returns:
            True if the response has required fields.
        """
        return (
            isinstance(response.content, str)
            and isinstance(response.role, str)
            and response.content.strip() != ""
        )

    def health(self) -> dict[str, Any]:
        """Check provider connectivity and credentials.

        Returns:
            Dict with health status information.
        """
        return {
            "status": "healthy",
            "provider": self.name,
            "model": self._effective_model_name,
            "configured": True,
        }

    def get_config(self) -> dict[str, Any]:
        """Return provider configuration (non-sensitive info only).

        Returns:
            Dict with configuration metadata suitable for logging/monitoring.
        """
        return {
            "provider": self.name,
            "model": self._effective_model_name,
            "respond_with": self._effective_respond_with,
            "delay_seconds": self._effective_delay,
            "configured": True,
        }