"""Application command system with validation (Person 3).

Provides a controlled, allowlisted command interface that can be invoked by:
- UI (Person 1)
- Search
- AI (Gemini)
- Other application actions

Commands are validated before execution. AI output is NEVER trusted directly.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, validator


class CommandName(str, Enum):
    """Allowlisted command names."""

    FIND_OBJECT = "find_object"
    FILTER_OBJECTS = "filter_objects"
    FOCUS_OBJECT = "focus_object"
    SHOW_ORBIT = "show_orbit"
    FOLLOW_OBJECT = "follow_object"
    OPEN_INFORMATION_PANEL = "open_information_panel"


class FindObjectParams(BaseModel):
    """Parameters for find_object command."""

    query: str = Field(..., min_length=1, max_length=200, description="Search query")
    category: int | None = Field(default=None, ge=1, le=7, description="Optional category filter")


class FilterObjectsParams(BaseModel):
    """Parameters for filter_objects command."""

    category: int | None = Field(default=None, ge=1, le=7, description="Category filter (1-7)")
    limit: int = Field(default=20, ge=1, le=100, description="Max results")
    offset: int = Field(default=0, ge=0, description="Pagination offset")


class FocusObjectParams(BaseModel):
    """Parameters for focus_object command."""

    object_id: int = Field(..., gt=0, description="Object identifier")
    animate: bool = Field(default=True, description="Whether to animate camera")


class ShowOrbitParams(BaseModel):
    """Parameters for show_orbit command."""

    object_id: int = Field(..., gt=0, description="Object identifier")
    duration_minutes: int | None = Field(default=90, ge=1, le=1440, description="Orbit duration in minutes")


class FollowObjectParams(BaseModel):
    """Parameters for follow_object command."""

    object_id: int = Field(..., gt=0, description="Object identifier")
    enable: bool = Field(default=True, description="Enable or disable follow mode")


class OpenInformationPanelParams(BaseModel):
    """Parameters for open_information_panel command."""

    object_id: int = Field(..., gt=0, description="Object identifier")


# Union of all parameter types
CommandParams = (
    FindObjectParams
    | FilterObjectsParams
    | FocusObjectParams
    | ShowOrbitParams
    | FollowObjectParams
    | OpenInformationPanelParams
)


class ApplicationCommand(BaseModel):
    """Validated application command.

    This is the canonical command format used throughout the application.
    AI output MUST be validated into this format before execution.
    """

    command: CommandName
    params: CommandParams
    request_id: str | None = Field(default=None, description="Optional request tracking ID")
    timestamp: datetime = Field(default_factory=datetime.utcnow)

    @validator("params", pre=True)
    def validate_params_for_command(cls, v, values):
        """Validate params match the command type."""
        command = values.get("command")
        if command is None:
            return v

        param_map = {
            CommandName.FIND_OBJECT: FindObjectParams,
            CommandName.FILTER_OBJECTS: FilterObjectsParams,
            CommandName.FOCUS_OBJECT: FocusObjectParams,
            CommandName.SHOW_ORBIT: ShowOrbitParams,
            CommandName.FOLLOW_OBJECT: FollowObjectParams,
            CommandName.OPEN_INFORMATION_PANEL: OpenInformationPanelParams,
        }

        expected_type = param_map.get(command)
        if expected_type is None:
            raise ValueError(f"Unknown command: {command}")

        if isinstance(v, dict):
            return expected_type(**v)
        if not isinstance(v, expected_type):
            raise TypeError(f"Params must be {expected_type.__name__} for command {command}")
        return v


class CommandValidationError(Exception):
    """Raised when command validation fails."""

    def __init__(self, message: str, command: str | None = None, errors: list[str] | None = None):
        self.command = command
        self.errors = errors or []
        super().__init__(message)


class CommandExecutionError(Exception):
    """Raised when command execution fails."""

    def __init__(self, message: str, command: str | None = None):
        self.command = command
        super().__init__(message)


# ---------------------------------------------------------------------------
# Command Validator
# ---------------------------------------------------------------------------

class CommandValidator:
    """Validates AI output into ApplicationCommand.

    Strict validation - no trust of AI output. All commands must match
    the allowlist exactly with correct parameter types.
    """

    # Allowlisted commands that AI can invoke
    ALLOWED_COMMANDS: frozenset[CommandName] = frozenset({
        CommandName.FIND_OBJECT,
        CommandName.FILTER_OBJECTS,
        CommandName.FOCUS_OBJECT,
        CommandName.SHOW_ORBIT,
        CommandName.FOLLOW_OBJECT,
        CommandName.OPEN_INFORMATION_PANEL,
    })

    def __init__(self, strict: bool = True):
        self.strict = strict

    def validate_ai_output(self, ai_content: str) -> ApplicationCommand:
        """Parse and validate AI output into an ApplicationCommand.

        Expected AI output format (JSON):
        {
            "command": "focus_object",
            "params": {"object_id": 25544}
        }

        Args:
            ai_content: Raw string output from AI provider.

        Returns:
            Validated ApplicationCommand.

        Raises:
            CommandValidationError: If output is malformed or invalid.
        """
        if not ai_content or not ai_content.strip():
            raise CommandValidationError("AI output is empty")

        # Try to extract JSON from the response
        content = ai_content.strip()

        # Handle markdown code blocks
        content = content.removeprefix("```json")
        content = content.removeprefix("```")
        content = content.removesuffix("```")
        content = content.strip()

        # Parse JSON
        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            raise CommandValidationError(f"AI output is not valid JSON: {exc}") from exc

        return self.validate_dict(data)

    def validate_dict(self, data: dict[str, Any]) -> ApplicationCommand:
        """Validate a dict into an ApplicationCommand.

        Args:
            data: Dict with command and params.

        Returns:
            Validated ApplicationCommand.

        Raises:
            CommandValidationError: If validation fails.
        """
        # Check required fields
        if "command" not in data:
            raise CommandValidationError("Missing required field: 'command'")

        if "params" not in data:
            raise CommandValidationError("Missing required field: 'params'")

        command_str = data["command"]

        # Validate command is allowlisted
        try:
            command = CommandName(command_str)
        except ValueError:
            allowed = [c.value for c in self.ALLOWED_COMMANDS]
            raise CommandValidationError(
                f"Command '{command_str}' is not allowed. Allowed: {allowed}",
                command=command_str,
            )

        if command not in self.ALLOWED_COMMANDS:
            allowed = [c.value for c in self.ALLOWED_COMMANDS]
            raise CommandValidationError(
                f"Command '{command_str}' is not in allowlist. Allowed: {allowed}",
                command=command_str,
            )

        # Validate params using Pydantic
        try:
            cmd = ApplicationCommand(command=command, params=data["params"])
            return cmd
        except Exception as exc:
            raise CommandValidationError(
                f"Parameter validation failed for command '{command_str}': {exc}",
                command=command_str,
                errors=[str(exc)],
            ) from exc


# ---------------------------------------------------------------------------
# Command Executor
# ---------------------------------------------------------------------------

class CommandExecutor:
    """Executes validated application commands.

    Bridges validated commands to the actual application/backend services.
    This is the integration point for Person 1's frontend.
    """

    def __init__(self, api_client=None):
        """Initialize with optional API client for backend calls."""
        self.api_client = api_client
        self._callbacks: dict[CommandName, Callable[[CommandParams], dict[str, Any]]] = {}

    def register_callback(self, command: CommandName, callback: Callable[[CommandParams], dict[str, Any]]) -> None:
        """Register a callback for a command (for frontend integration)."""
        self._callbacks[command] = callback

    def execute(self, command: ApplicationCommand) -> dict[str, Any]:
        """Execute a validated command.

        Args:
            command: Validated ApplicationCommand.

        Returns:
            Dict with execution result.

        Raises:
            CommandExecutionError: If execution fails.
        """
        # First check for registered callbacks (frontend integration)
        if command.command in self._callbacks:
            try:
                return self._callbacks[command.command](command.params)
            except Exception as exc:
                raise CommandExecutionError(
                    f"Callback execution failed for {command.command}: {exc}",
                    command=command.command.value,
                ) from exc

        # Fallback to backend API execution
        if self.api_client:
            return self._execute_via_api(command)

        # No execution path available
        raise CommandExecutionError(
            f"No execution path for command {command.command}",
            command=command.command.value,
        )

    def _execute_via_api(self, command: ApplicationCommand) -> dict[str, Any]:
        """Execute command via backend API client."""
        from backend.client import APIError

        if not self.api_client:
            raise CommandExecutionError("No API client configured")

        params = command.params

        try:
            if command.command == CommandName.FIND_OBJECT:
                if isinstance(params, FindObjectParams):
                    result = self.api_client.search(q=params.query, category=params.category)
                    return {"success": True, "data": result.model_dump()}
                raise CommandExecutionError(f"Invalid params for {command.command}")

            elif command.command == CommandName.FILTER_OBJECTS:
                if isinstance(params, FilterObjectsParams):
                    result = self.api_client.list(category=params.category, limit=params.limit, offset=params.offset)
                    return {"success": True, "data": result.model_dump()}
                raise CommandExecutionError(f"Invalid params for {command.command}")

            elif command.command == CommandName.FOCUS_OBJECT:
                if isinstance(params, FocusObjectParams):
                    result = self.api_client.get(object_id=params.object_id)
                    state = self.api_client.state(object_id=params.object_id)
                    return {
                        "success": True,
                        "data": {
                            "object": result.model_dump(),
                            "state": state.model_dump(),
                        },
                    }
                raise CommandExecutionError(f"Invalid params for {command.command}")

            elif command.command == CommandName.SHOW_ORBIT:
                if isinstance(params, ShowOrbitParams):
                    result = self.api_client.get(object_id=params.object_id)
                    state = self.api_client.state(object_id=params.object_id)
                    return {
                        "success": True,
                        "data": {
                            "object": result.model_dump(),
                            "state": state.model_dump(),
                            "orbit_duration_minutes": params.duration_minutes,
                        },
                    }
                raise CommandExecutionError(f"Invalid params for {command.command}")

            elif command.command == CommandName.FOLLOW_OBJECT:
                if isinstance(params, FollowObjectParams):
                    result = self.api_client.get(object_id=params.object_id)
                    state = self.api_client.state(object_id=params.object_id)
                    return {
                        "success": True,
                        "data": {
                            "object": result.model_dump(),
                            "state": state.model_dump(),
                            "follow_enabled": params.enable,
                        },
                    }
                raise CommandExecutionError(f"Invalid params for {command.command}")

            elif command.command == CommandName.OPEN_INFORMATION_PANEL:
                if isinstance(params, OpenInformationPanelParams):
                    result = self.api_client.get(object_id=params.object_id)
                    media = self.api_client.media(object_id=params.object_id)
                    return {
                        "success": True,
                        "data": {
                            "object": result.model_dump(),
                            "media": media.model_dump(),
                        },
                    }
                raise CommandExecutionError(f"Invalid params for {command.command}")

        except APIError as exc:
            raise CommandExecutionError(
                f"API error for {command.command}: {exc.detail}",
                command=command.command.value,
            ) from exc
        except Exception as exc:
            raise CommandExecutionError(
                f"Execution failed for {command.command}: {exc}",
                command=command.command.value,
            ) from exc

        raise CommandExecutionError(f"Unhandled command: {command.command}")


# ---------------------------------------------------------------------------
# AI Command Bridge
# ---------------------------------------------------------------------------

class AICommandBridge:
    """Bridge between AI provider and application command system.

    Flow:
    1. AI generates structured output
    2. Validator validates output into ApplicationCommand
    3. Executor executes the command
    4. Result returned to caller
    """

    def __init__(
        self,
        validator: CommandValidator | None = None,
        executor: CommandExecutor | None = None,
    ):
        self.validator = validator or CommandValidator()
        self.executor = executor or CommandExecutor()

    def process_ai_output(self, ai_content: str) -> dict[str, Any]:
        """Process AI output through validation and execution.

        Args:
            ai_content: Raw output from AI provider.

        Returns:
            Dict with execution result or error.
        """
        # Validate
        try:
            command = self.validator.validate_ai_output(ai_content)
        except CommandValidationError as exc:
            return {
                "success": False,
                "error": "validation_failed",
                "message": str(exc),
                "command": exc.command,
                "errors": exc.errors,
            }

        # Execute
        try:
            result = self.executor.execute(command)
            return {
                "success": True,
                "command": command.command.value,
                "result": result,
            }
        except CommandExecutionError as exc:
            return {
                "success": False,
                "error": "execution_failed",
                "message": str(exc),
                "command": exc.command,
            }

    def process_ai_dict(self, ai_data: dict[str, Any]) -> dict[str, Any]:
        """Process AI output dict through validation and execution."""
        try:
            command = self.validator.validate_dict(ai_data)
        except CommandValidationError as exc:
            return {
                "success": False,
                "error": "validation_failed",
                "message": str(exc),
                "command": exc.command,
                "errors": exc.errors,
            }

        try:
            result = self.executor.execute(command)
            return {
                "success": True,
                "command": command.command.value,
                "result": result,
            }
        except CommandExecutionError as exc:
            return {
                "success": False,
                "error": "execution_failed",
                "message": str(exc),
                "command": exc.command,
            }


import json