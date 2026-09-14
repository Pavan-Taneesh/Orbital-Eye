"""AI Provider interface.

Defines the contract that all AI providers must satisfy. The application
service layer depends only on this interface, not on concrete provider
implementations.

Concrete providers (e.g., OpenAI, Anthropic, Gemini, or a fake test
provider) implement this interface.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, List, Sequence, Tuple

from .response import AIResponse  # noqa: F401

from .exceptions import MissingCredentialsError, ProviderFailureError


class ProviderInterface:
    """Abstract base class for AI providers.

    Subclasses must implement the core operations: generate, validate,
    and health check. The application AIService depends on this interface,
    not on concrete subclasses.
    """

    name: str = "abstract_provider"

    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        timeout: Optional[float] = None,
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
            MissingCredentialsError: If the provider lacks required credentials.
            ProviderFailureError: If the provider returns an error.
            TimeoutError: If the request times out.
        """
        raise NotImplementedError(
            f"{self.name}.generate() not implemented"
        )

    def validate(self, response: AIResponse) -> bool:
        """Validate a provider response for correct structure.

        Args:
            response: The AIResponse to validate.

        Returns:
            True if the response is structurally valid.
        """
        raise NotImplementedError(
            f"{self.name}.validate() not implemented"
        )

    def health(self) -> Dict[str, Any]:
        """Check provider connectivity and credentials.

        Returns:
            Dict with health status information.
        """
        raise NotImplementedError(
            f"{self.name}.health() not implemented"
        )

    def get_config(self) -> Dict[str, Any]:
        """Return provider configuration (non-sensitive info only).

        Returns:
            Dict with configuration metadata suitable for logging/monitoring.
        """
        raise NotImplementedError(
            f"{self.name}.get_config() not implemented"
        )