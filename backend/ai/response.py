"""AI response model — shared between provider interface and service layer.

This module defines the AIResponse shape that all providers return and that
the AIService consumes. It is deliberately independent so that neither the
provider interface nor the service layer creates a circular import.
"""

from __future__ import annotations

from typing import Any


class AIResponse:
    """Normalized AI response returned by the AI service.

    All provider-specific details are stripped away. The application
    always works with this shape.
    """

    def __init__(
        self,
        content: str,
        role: str = "assistant",
        model: str | None = None,
        usage: dict[str, int] | None = None,
        finish_reason: str | None = None,
        raw: dict[str, Any] | None = None,
    ):
        self.content = content
        self.role = role
        self.model = model
        self.usage = usage or {}
        self.finish_reason = finish_reason
        self.raw = raw or {}

    @property
    def word_count(self) -> int:
        return len(self.content.split())

    @property
    def token_count(self) -> int:
        return self.usage.get("total", 0)

    def model_dump(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "role": self.role,
            "model": self.model,
            "usage": self.usage,
            "finish_reason": self.finish_reason,
        }