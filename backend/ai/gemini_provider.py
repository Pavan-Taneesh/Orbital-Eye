"""Gemini AI provider implementation.

Implements the ProviderInterface using Google's Generative AI SDK.
Credentials are loaded from environment variables only.
"""

from __future__ import annotations

import os
import time
from typing import Any

from .exceptions import (
    MissingCredentialsError,
    ProviderFailureError,
    ProviderTimeoutError,
)
from .provider import ProviderInterface
from .response import AIResponse


class GeminiProvider(ProviderInterface):
    """Google Gemini provider implementation.

    Requires GOOGLE_API_KEY or GEMINI_API_KEY environment variable.
    Uses google-generativeai SDK.
    """

    name: str = "gemini"

    def __init__(
        self,
        model: str = "gemini-1.5-flash",
        api_key: str | None = None,
        default_temperature: float = 0.1,
        default_max_tokens: int = 1024,
    ) -> None:
        self.model_name = model
        self.default_temperature = default_temperature
        self.default_max_tokens = default_max_tokens

        # Load API key from env if not provided
        self.api_key = api_key or os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")

        self._client = None
        self._init_client()

    def _init_client(self) -> None:
        """Initialize the Gemini client."""
        if not self.api_key:
            return

        try:
            import google.generativeai as genai
            genai.configure(api_key=self.api_key)
            self._client = genai.GenerativeModel(self.model_name)
        except ImportError:
            raise MissingCredentialsError(
                provider_name=self.name,
                missing=["google-generativeai package not installed"]
            )

    def generate(
        self,
        prompt: str,
        system: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout: float | None = None,
    ) -> AIResponse:
        """Generate a response using Gemini.

        Args:
            prompt: The user prompt/question.
            system: Optional system/instruction prompt.
            temperature: Sampling temperature (0-2+).
            max_tokens: Maximum tokens to generate.
            timeout: Request timeout in seconds.

        Returns:
            AIResponse with the provider's output and metadata.

        Raises:
            MissingCredentialsError: If API key is not configured.
            ProviderFailureError: If the provider returns an error.
            ProviderTimeoutError: If the request times out.
        """
        if not self.api_key:
            raise MissingCredentialsError(
                provider_name=self.name,
                missing=["GOOGLE_API_KEY or GEMINI_API_KEY environment variable"]
            )

        if self._client is None:
            self._init_client()
            if self._client is None:
                raise ProviderFailureError(
                    provider_name=self.name,
                    message="Failed to initialize Gemini client"
                )

        effective_temp = temperature if temperature is not None else self.default_temperature
        effective_max = max_tokens if max_tokens is not None else self.default_max_tokens

        # Build combined prompt with system instruction
        full_prompt = prompt
        if system:
            full_prompt = f"System: {system}\n\nUser: {prompt}"

        start = time.time()
        try:
            from google.generativeai.types import GenerationConfig

            generation_config = GenerationConfig(
                temperature=effective_temp,
                max_output_tokens=effective_max,
            )

            # Apply timeout if supported (SDK may not support direct timeout)
            response = self._client.generate_content(
                full_prompt,
                generation_config=generation_config,
            )

            elapsed = time.time() - start

            if not response.text:
                raise ProviderFailureError(
                    provider_name=self.name,
                    message="Empty response from Gemini"
                )

            # Extract usage metadata if available
            usage = {}
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                usage = {
                    "input": getattr(response.usage_metadata, 'prompt_token_count', 0),
                    "output": getattr(response.usage_metadata, 'candidates_token_count', 0),
                }
                usage["total"] = usage.get("input", 0) + usage.get("output", 0)

            return AIResponse(
                content=response.text.strip(),
                role="assistant",
                model=self.model_name,
                usage=usage,
                finish_reason="stop",
                raw={
                    "provider": "gemini",
                    "prompt": prompt,
                    "system": system,
                    "latency_seconds": round(elapsed, 3),
                    "raw_response": response.text,
                },
            )

        except MissingCredentialsError:
            raise
        except ProviderFailureError:
            raise
        except ProviderTimeoutError:
            raise
        except Exception as exc:
            elapsed = time.time() - start
            error_msg = str(exc)
            if "timeout" in error_msg.lower() or "timed out" in error_msg.lower():
                raise ProviderTimeoutError(
                    provider_name=self.name,
                    timeout=timeout or 30.0
                ) from exc
            raise ProviderFailureError(
                provider_name=self.name,
                message=f"Gemini generation failed: {error_msg}"
            ) from exc

    def validate(self, response: AIResponse) -> bool:
        """Validate a Gemini response for correct structure."""
        return (
            isinstance(response.content, str)
            and isinstance(response.role, str)
            and response.content.strip() != ""
        )

    def health(self) -> dict[str, Any]:
        """Check Gemini connectivity and credentials."""
        if not self.api_key:
            return {
                "status": "unhealthy",
                "provider": self.name,
                "model": self.model_name,
                "configured": False,
                "error": "API key not configured"
            }

        try:
            self._init_client()
            if self._client is None:
                return {
                    "status": "unhealthy",
                    "provider": self.name,
                    "model": self.model_name,
                    "configured": False,
                    "error": "Failed to initialize client"
                }

            # Quick test generation
            test_response = self._client.generate_content("test")
            if test_response and test_response.text:
                return {
                    "status": "healthy",
                    "provider": self.name,
                    "model": self.model_name,
                    "configured": True,
                }
            else:
                return {
                    "status": "unhealthy",
                    "provider": self.name,
                    "model": self.model_name,
                    "configured": True,
                    "error": "Empty test response"
                }
        except Exception as exc:
            return {
                "status": "unhealthy",
                "provider": self.name,
                "model": self.model_name,
                "configured": True,
                "error": str(exc)
            }

    def get_config(self) -> dict[str, Any]:
        """Return provider configuration (non-sensitive info only)."""
        return {
            "provider": self.name,
            "model": self.model_name,
            "configured": bool(self.api_key),
            "default_temperature": self.default_temperature,
            "default_max_tokens": self.default_max_tokens,
        }