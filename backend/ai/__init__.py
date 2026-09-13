"""AI provider abstraction for the Space-website application layer.

This package provides a clean abstraction layer between the application/service
tier and AI providers. The application depends only on the interface, not on
any vendor-specific SDK.

Typical usage:
    from backend.ai import AIService, FakeProvider, GeminiProvider, make_service
    service = AIService(FakeProvider())
    result = service.generate("some prompt")

Or using the factory:
    service = make_service("gemini")
    result = service.generate("some prompt")
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .provider import ProviderInterface
from .response import AIResponse
from .exceptions import MissingCredentialsError, ProviderFailureError, ProviderTimeoutError
from .fake_provider import FakeProvider
from .gemini_provider import GeminiProvider
from .service import AIService, make_service

__all__ = [
    "ProviderInterface",
    "AIResponse",
    "MissingCredentialsError",
    "ProviderFailureError",
    "ProviderTimeoutError",
    "FakeProvider",
    "GeminiProvider",
    "AIService",
    "make_service",
]