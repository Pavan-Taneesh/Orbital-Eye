"""AI Exploration Service (Person 3).

High-level service that connects natural language input to application commands.
Handles context minimization, AI failure handling, and usage optimization.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

from backend.ai import AIService, make_service
from backend.ai.exceptions import (
    MissingCredentialsError,
    ProviderFailureError,
    ProviderTimeoutError,
)
from backend.application_state import get_app_state
from backend.command_system import (
    AICommandBridge,
    CommandName,
)

# System prompt for Gemini to generate structured commands
SYSTEM_PROMPT = """You are an AI assistant for a satellite tracking application. Convert user requests into structured JSON commands.

Available commands (you MUST use exactly these names):
1. find_object - Search for objects by name
   Params: {"query": "string", "category": int|null}

2. filter_objects - List objects by category
   Params: {"category": int|null, "limit": int, "offset": int}

3. focus_object - Focus camera on an object (show details)
   Params: {"object_id": int, "animate": bool}

4. show_orbit - Show orbit path for an object
   Params: {"object_id": int, "duration_minutes": int}

5. follow_object - Enable/disable follow mode for an object
   Params: {"object_id": int, "enable": bool}

6. open_information_panel - Open detailed information panel
   Params: {"object_id": int}

Rules:
- Output ONLY valid JSON with "command" and "params" fields
- No markdown, no extra text, no explanations
- If request is ambiguous, pick the most likely command
- object_id must be a positive integer
- category must be 1-7 or null
- duration_minutes 1-1440, default 90
- limit 1-100, default 20
"""


@dataclass
class ExplorationContext:
    """Minimal context sent to AI for exploration."""

    selected_object_id: int | None = None
    hovered_object_id: int | None = None
    selected_categories: list[int] = field(default_factory=list)
    search_query: str = ""
    available_commands: list[str] = field(default_factory=lambda: [c.value for c in CommandName])
    diagnostics: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        base = {
            "selected_object_id": self.selected_object_id,
            "hovered_object_id": self.hovered_object_id,
            "selected_categories": self.selected_categories,
            "search_query": self.search_query,
            "available_commands": self.available_commands,
        }
        if self.diagnostics is not None:
            base["diagnostics"] = self.diagnostics
        return base


@dataclass
class ExplorationResult:
    """Result of an AI exploration request."""

    success: bool
    command: str | None = None
    result: dict[str, Any] | None = None
    ai_response: str | None = None
    error: str | None = None
    error_type: str | None = None  # validation_failed, execution_failed, provider_error, etc.
    latency_ms: float = 0.0
    tokens_used: dict[str, int] = field(default_factory=dict)


class AIExplorationService:
    """Service for AI-guided exploration.

    Coordinates:
    - Context gathering (minimal)
    - AI provider interaction
    - Response validation
    - Command execution
    - Usage tracking
    """

    def __init__(
        self,
        ai_service: AIService | None = None,
        command_bridge: AICommandBridge | None = None,
        max_context_chars: int = 2000,
        enable_usage_tracking: bool = True,
    ):
        self.ai_service = ai_service or make_service("fake")
        self.command_bridge = command_bridge or AICommandBridge()
        self.max_context_chars = max_context_chars
        self.enable_usage_tracking = enable_usage_tracking

        # Usage statistics
        self.total_requests = 0
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_errors = 0
        self.errors_by_type: dict[str, int] = {}

    def _build_context(self) -> ExplorationContext:
        """Build minimal context from application state."""
        app_state = get_app_state()
        diagnostics_data: dict[str, Any] | None = None
        if app_state.visual.selected_object_id is not None:
            # Include selected object as diagnostics context without API call
            # (full diagnostics fetched on-demand via client when needed)
            diagnostics_data = {
                "object_id": app_state.visual.selected_object_id,
                "status": app_state.scientific.status,
            }
        return ExplorationContext(
            selected_object_id=app_state.visual.selected_object_id,
            hovered_object_id=app_state.visual.hovered_object_id,
            selected_categories=app_state.visual.selected_categories,
            search_query=app_state.visual.search_query,
            available_commands=[c.value for c in CommandName],
            diagnostics=diagnostics_data,
        )

    def _build_prompt(self, user_request: str, context: ExplorationContext) -> str:
        """Build the prompt for the AI provider."""
        context_json = json.dumps(context.to_dict(), separators=(",", ":"))
        prompt = (
            f"Current context: {context_json}"
            f"\n\nUser request: \"{user_request}\""
            f"\n\nRespond with ONLY a JSON command object:"
        )
        if self.max_context_chars and len(prompt) > self.max_context_chars:
            truncated = prompt[: self.max_context_chars - 50] + "... [truncated]"
            # Re-append the user request and trailing text to keep the core request
            truncated += (
                f"\n\nUser request: \"{user_request}\""
                f"\n\nRespond with ONLY a JSON command object:"
            )
            if len(truncated) > self.max_context_chars:
                truncated = truncated[: self.max_context_chars]
            return truncated
        return prompt

    def explore(self, user_request: str) -> ExplorationResult:
        """Process a natural language exploration request.

        Args:
            user_request: User's natural language request (e.g., "Take me to the ISS")

        Returns:
            ExplorationResult with command execution outcome.
        """
        start_time = time.time()
        self.total_requests += 1

        # Record AI request start
        app_state = get_app_state()
        provider_name = getattr(self.ai_service.provider, 'name', 'unknown')
        model_name = getattr(self.ai_service.provider, 'model_name', None) or getattr(self.ai_service.provider, 'model', 'unknown')
        app_state.ai.record_request(provider_name, model_name)

        try:
            # Build minimal context
            context = self._build_context()

            # Build prompt
            prompt = self._build_prompt(user_request, context)

            # Call AI provider
            ai_response = self.ai_service.generate(
                prompt=prompt,
                system=SYSTEM_PROMPT,
                temperature=0.1,
                max_tokens=512,
                timeout=30.0,
            )

            latency_ms = (time.time() - start_time) * 1000
            ai_content = ai_response.content

            # Track usage
            if self.enable_usage_tracking and ai_response.usage:
                usage = ai_response.usage
                self.total_input_tokens += usage.get("input", 0)
                self.total_output_tokens += usage.get("output", 0)
                app_state.ai.record_success(ai_content, usage)

            # Process through command bridge
            bridge_result = self.command_bridge.process_ai_output(ai_content)

            latency_ms = (time.time() - start_time) * 1000

            if bridge_result["success"]:
                return ExplorationResult(
                    success=True,
                    command=bridge_result["command"],
                    result=bridge_result["result"],
                    ai_response=ai_content,
                    latency_ms=latency_ms,
                    tokens_used=ai_response.usage or {},
                )
            else:
                self.total_errors += 1
                error_type = bridge_result.get("error", "unknown")
                self.errors_by_type[error_type] = self.errors_by_type.get(error_type, 0) + 1
                app_state.ai.record_error(bridge_result.get("message", "Unknown error"))

                return ExplorationResult(
                    success=False,
                    command=bridge_result.get("command"),
                    ai_response=ai_content,
                    error=bridge_result.get("message"),
                    error_type=error_type,
                    latency_ms=latency_ms,
                    tokens_used=ai_response.usage or {},
                )

        except MissingCredentialsError:
            self.total_errors += 1
            self.errors_by_type["missing_credentials"] = self.errors_by_type.get("missing_credentials", 0) + 1
            latency_ms = (time.time() - start_time) * 1000
            app_state.ai.record_error("Missing API credentials")
            return ExplorationResult(
                success=False,
                error="AI provider not configured. Please set GOOGLE_API_KEY.",
                error_type="missing_credentials",
                latency_ms=latency_ms,
            )

        except ProviderTimeoutError as exc:
            self.total_errors += 1
            self.errors_by_type["timeout"] = self.errors_by_type.get("timeout", 0) + 1
            latency_ms = (time.time() - start_time) * 1000
            app_state.ai.record_error(f"AI request timeout: {exc}")
            return ExplorationResult(
                success=False,
                error="AI request timed out. Please try again.",
                error_type="timeout",
                latency_ms=latency_ms,
            )

        except ProviderFailureError as exc:
            self.total_errors += 1
            self.errors_by_type["provider_failure"] = self.errors_by_type.get("provider_failure", 0) + 1
            latency_ms = (time.time() - start_time) * 1000
            app_state.ai.record_error(f"AI provider error: {exc}")
            return ExplorationResult(
                success=False,
                error="AI provider error. Core application continues to work.",
                error_type="provider_failure",
                latency_ms=latency_ms,
            )

        except Exception as exc:
            self.total_errors += 1
            self.errors_by_type["unexpected"] = self.errors_by_type.get("unexpected", 0) + 1
            latency_ms = (time.time() - start_time) * 1000
            app_state.ai.record_error(f"Unexpected error: {exc}")
            return ExplorationResult(
                success=False,
                error=f"Unexpected error: {exc}",
                error_type="unexpected",
                latency_ms=latency_ms,
            )

    def get_usage_stats(self) -> dict[str, Any]:
        """Get AI usage statistics."""
        return {
            "total_requests": self.total_requests,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "total_tokens": self.total_input_tokens + self.total_output_tokens,
            "total_errors": self.total_errors,
            "errors_by_type": self.errors_by_type,
            "success_rate": (
                (self.total_requests - self.total_errors) / self.total_requests
                if self.total_requests > 0 else 0
            ),
        }

    def reset_stats(self) -> None:
        """Reset usage statistics."""
        self.total_requests = 0
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_errors = 0
        self.errors_by_type = {}


# Convenience function for simple usage
async def explore(user_request: str, provider: str = "fake") -> ExplorationResult:
    """Simple async explore function.

    Args:
        user_request: Natural language request
        provider: AI provider name ("fake" or "gemini")

    Returns:
        ExplorationResult
    """
    ai_service = make_service(provider)
    bridge = AICommandBridge()
    service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)
    return service.explore(user_request)