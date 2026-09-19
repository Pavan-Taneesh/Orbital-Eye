"""AI Service layer.

Application-level orchestration for AI provider interactions.

The AI service:

- depends ONLY on the ProviderInterface (not on concrete provider SDKs)
- normalizes provider output into AIResponse (vendor-agnostic)
- handles provider failures gracefully
- enforces timeouts
- validates inputs and outputs
- provides fallback-capable execution

This service must not know about FastAPI request objects or CLI arguments.

Typical usage:

    from backend.ai import AIService, FakeProvider
    service = AIService(FakeProvider())
    result = service.generate("some prompt")
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional, List, Type, Tuple

from .response import AIResponse
from .provider import ProviderInterface
from .exceptions import MissingCredentialsError, ProviderFailureError, ProviderTimeoutError


class AIService:
    """Application-level AI service.

    Orchestrates AI provider interactions with proper error handling,
    input validation, output normalization, and timeout enforcement.

    The service depends ONLY on the ProviderInterface — it knows nothing
    about OpenAI, Anthropic, Gemini, or any other vendor SDK.

    Args:
        provider: A ProviderInterface instance.
        default_timeout: Default request timeout in seconds if none given.
        validate_output: Whether to validate the provider response.
        fail_on_provider_error: If True, re-raise ProviderFailureError.
            If False, return a degraded AIResponse.
    """

    def __init__(
        self,
        provider: ProviderInterface,
        default_timeout: float = 30.0,
        validate_output: bool = True,
        fail_on_provider_error: bool = True,
    ):
        self.provider = provider
        self.default_timeout = default_timeout
        self.validate_output = validate_output
        self.fail_on_provider_error = fail_on_provider_error

    # -----------------------------------------------------------------
    # Input validation
    # -----------------------------------------------------------------

    @staticmethod
    def _validate_prompt(prompt: str) -> None:
        """Validate the prompt before sending to a provider.

        Raises ValueError if the prompt is invalid.
        """
        if prompt is None:
            raise ValueError("Prompt must not be None")
        if not isinstance(prompt, str):
            raise ValueError(f"Prompt must be a string, got {type(prompt)}")
        if prompt.strip() == "":
            raise ValueError("Prompt must not be empty or whitespace-only")
        if len(prompt) > 100_000:
            raise ValueError(
                f"Prompt exceeds maximum length (100000 chars), got {len(prompt)}"
            )

    # -----------------------------------------------------------------
    # Core generation
    # -----------------------------------------------------------------

    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> AIResponse:
        """Generate a response to the given prompt.

        Application-level orchestration for AI provider interactions.

        Args:
            prompt: The user prompt/question.
            system: Optional system/instruction prompt.
            temperature: Sampling temperature (0-2+).
            max_tokens: Maximum tokens to generate.
            timeout: Request timeout in seconds (defaults to default_timeout).

        Returns:
            AIResponse with the provider's output and metadata.

        Raises:
            ValueError: If the prompt is invalid.
            MissingCredentialsError: If the provider lacks required credentials.
            ProviderFailureError: If the provider returns an error
                and fail_on_provider_error is True.
            ProviderTimeoutError: If the request times out.
        """
        # Input validation
        self._validate_prompt(prompt)

        # Use default timeout if none given
        effective_timeout = timeout if timeout is not None else self.default_timeout

        # Execute with timeout
        start = time.time()
        try:
            response = self.provider.generate(
                prompt=prompt,
                system=system,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=effective_timeout,
            )
        except ProviderTimeoutError:
            raise  # re-raise as-is
        except TimeoutError as exc:
            raise ProviderTimeoutError(
                provider_name=self.provider.name, timeout=effective_timeout
            ) from exc
        except MissingCredentialsError as exc:
            raise  # re-raise as-is
        except Exception as exc:
            # Wrap any unexpected provider error
            raise ProviderFailureError(
                provider_name=self.provider.name,
                message=str(exc),
            ) from exc

        elapsed = time.time() - start

        # Post-generation validation
        if self.validate_output and not self.provider.validate(response):
            if self.fail_on_provider_error:
                raise ProviderFailureError(
                    provider_name=self.provider.name,
                    message="Provider returned malformed response",
                )
            # Return degraded response if not failing
            response = AIResponse(
                content="",
                role="assistant",
                model=response.model,
                usage={},
                finish_reason="stop",
                raw=response.raw,
            )

        # Attach latency metadata
        if hasattr(response, "usage"):
            response.raw["latency_seconds"] = round(elapsed, 3)

        return response

    # -----------------------------------------------------------------
    # Convenience methods
    # -----------------------------------------------------------------

    def health_check(self) -> Dict[str, Any]:
        """Check provider health.

        Returns:
            Dict with health status information.
        """
        return self.provider.health()

    def get_provider_config(self) -> Dict[str, Any]:
        """Get provider configuration (non-sensitive info).

        Returns:
            Dict with configuration metadata.
        """
        return self.provider.get_config()

    def list_recent(self, n: int = 5) -> List[AIResponse]:
        """Return n recent responses (no-op for fake provider).

        Args:
            n: Number of recent responses to return.

        Returns:
            List of AIResponse objects.
        """
        # Default implementation — fake provider doesn't track history
        return []


# ---------------------------------------------------------------------------
# Service factory / configuration helpers
# ---------------------------------------------------------------------------

def make_service(
    provider_name: str = "fake",
    default_timeout: float = 30.0,
    validate_output: bool = True,
    fail_on_provider_error: bool = True,
    **provider_kwargs: Any,
) -> AIService:
    """Create an AIService with the named provider.

    Args:
        provider_name: Name of the provider to use ("fake", "gemini", or a registered name).
        default_timeout: Default request timeout in seconds.
        validate_output: Whether to validate provider responses.
        fail_on_provider_error: Whether to raise on provider errors.
        **provider_kwargs: Configuration overrides for the provider.

    Returns:
        AIService instance configured with the named provider.

    Raises:
        ValueError: If the provider name is not recognized.
    """
    from .fake_provider import FakeProvider
    from .gemini_provider import GeminiProvider

    if provider_name == "fake":
        provider = FakeProvider(**provider_kwargs)
    elif provider_name == "gemini":
        provider = GeminiProvider(**provider_kwargs)
    else:
        raise ValueError(f"Unknown provider: {provider_name}")

    return AIService(
        provider=provider,
        default_timeout=default_timeout,
        validate_output=validate_output,
        fail_on_provider_error=fail_on_provider_error,
    )