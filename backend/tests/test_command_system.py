"""Tests for the application command system (Person 3)."""

from __future__ import annotations

import pytest
from backend.command_system import (
    AICommandBridge,
    ApplicationCommand,
    CommandExecutor,
    CommandName,
    CommandValidationError,
    CommandValidator,
    FilterObjectsParams,
    FindObjectParams,
    FocusObjectParams,
    FollowObjectParams,
    OpenInformationPanelParams,
    ShowOrbitParams,
)
from pydantic import ValidationError


class TestCommandParams:
    """Test command parameter models."""

    def test_find_object_params(self):
        params = FindObjectParams(query="ISS", category=1)
        assert params.query == "ISS"
        assert params.category == 1

    def test_find_object_params_defaults(self):
        params = FindObjectParams(query="satellite")
        assert params.query == "satellite"
        assert params.category is None

    def test_filter_objects_params(self):
        params = FilterObjectsParams(category=2, limit=50, offset=10)
        assert params.category == 2
        assert params.limit == 50
        assert params.offset == 10

    def test_focus_object_params(self):
        params = FocusObjectParams(object_id=25544, animate=False)
        assert params.object_id == 25544
        assert params.animate is False

    def test_show_orbit_params(self):
        params = ShowOrbitParams(object_id=25544, duration_minutes=120)
        assert params.object_id == 25544
        assert params.duration_minutes == 120

    def test_follow_object_params(self):
        params = FollowObjectParams(object_id=25544, enable=True)
        assert params.object_id == 25544
        assert params.enable is True

    def test_open_information_panel_params(self):
        params = OpenInformationPanelParams(object_id=25544)
        assert params.object_id == 25544


class TestApplicationCommand:
    """Test ApplicationCommand model."""

    def test_valid_focus_object_command(self):
        cmd = ApplicationCommand(
            command=CommandName.FOCUS_OBJECT,
            params={"object_id": 25544, "animate": True},
        )
        assert cmd.command == CommandName.FOCUS_OBJECT
        assert cmd.params.object_id == 25544

    def test_valid_find_object_command(self):
        cmd = ApplicationCommand(
            command=CommandName.FIND_OBJECT,
            params={"query": "ISS", "category": 1},
        )
        assert cmd.command == CommandName.FIND_OBJECT
        assert cmd.params.query == "ISS"

    def test_invalid_command_rejected(self):
        with pytest.raises(ValidationError):
            ApplicationCommand(
                command="invalid_command",
                params={"object_id": 1},
            )

    def test_wrong_params_for_command_rejected(self):
        with pytest.raises(ValidationError):
            ApplicationCommand(
                command=CommandName.FOCUS_OBJECT,
                params={"query": "ISS"},  # wrong params for focus_object
            )


class TestCommandValidator:
    """Test CommandValidator."""

    def test_validator_allows_valid_commands(self):
        validator = CommandValidator()
        for cmd in CommandName:
            assert cmd in validator.ALLOWED_COMMANDS

    def test_validate_valid_json_output(self):
        validator = CommandValidator()
        ai_output = '{"command": "focus_object", "params": {"object_id": 25544}}'
        cmd = validator.validate_ai_output(ai_output)
        assert cmd.command == CommandName.FOCUS_OBJECT
        assert cmd.params.object_id == 25544

    def test_validate_json_with_markdown_code_block(self):
        validator = CommandValidator()
        ai_output = '''```json
{"command": "find_object", "params": {"query": "ISS"}}
```'''
        cmd = validator.validate_ai_output(ai_output)
        assert cmd.command == CommandName.FIND_OBJECT
        assert cmd.params.query == "ISS"

    def test_validate_rejects_empty_output(self):
        validator = CommandValidator()
        with pytest.raises(CommandValidationError):
            validator.validate_ai_output("")

    def test_validate_rejects_invalid_json(self):
        validator = CommandValidator()
        with pytest.raises(CommandValidationError):
            validator.validate_ai_output("not valid json")

    def test_validate_rejects_missing_command(self):
        validator = CommandValidator()
        with pytest.raises(CommandValidationError):
            validator.validate_ai_output('{"params": {"object_id": 1}}')

    def test_validate_rejects_missing_params(self):
        validator = CommandValidator()
        with pytest.raises(CommandValidationError):
            validator.validate_ai_output('{"command": "focus_object"}')

    def test_validate_rejects_disallowed_command(self):
        validator = CommandValidator()
        with pytest.raises(CommandValidationError) as exc_info:
            validator.validate_ai_output('{"command": "delete_database", "params": {}}')
        assert "not allowed" in str(exc_info.value)

    def test_validate_rejects_wrong_param_type(self):
        validator = CommandValidator()
        with pytest.raises(CommandValidationError):
            validator.validate_ai_output('{"command": "focus_object", "params": {"object_id": "not_a_number"}}')

    def test_validate_dict_direct(self):
        validator = CommandValidator()
        data = {"command": "filter_objects", "params": {"category": 3, "limit": 10}}
        cmd = validator.validate_dict(data)
        assert cmd.command == CommandName.FILTER_OBJECTS
        assert cmd.params.category == 3


class TestCommandExecutor:
    """Test CommandExecutor (with mock API client)."""

    def test_executor_with_callback(self):
        executor = CommandExecutor()
        results = {}

        def mock_callback(params):
            results["called"] = True
            results["params"] = params
            return {"success": True, "data": "mock"}

        executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        from backend.command_system import ApplicationCommand
        cmd = ApplicationCommand(
            command=CommandName.FOCUS_OBJECT,
            params={"object_id": 25544},
        )

        result = executor.execute(cmd)
        assert result["success"] is True
        assert results["called"] is True
        assert results["params"].object_id == 25544

    def test_executor_no_callback_no_client_raises(self):
        executor = CommandExecutor()
        from backend.command_system import ApplicationCommand
        cmd = ApplicationCommand(
            command=CommandName.FOCUS_OBJECT,
            params={"object_id": 25544},
        )
        with pytest.raises(Exception) as exc_info:
            executor.execute(cmd)
        assert "No execution path" in str(exc_info.value)


class TestAICommandBridge:
    """Test AICommandBridge integration."""

    def test_bridge_validates_and_executes(self):
        bridge = AICommandBridge()
        results = {}

        def mock_callback(params):
            results["executed"] = True
            return {"success": True, "data": "ok"}

        bridge.executor.register_callback(CommandName.FOLLOW_OBJECT, mock_callback)

        ai_output = '{"command": "follow_object", "params": {"object_id": 25544, "enable": true}}'
        result = bridge.process_ai_output(ai_output)

        assert result["success"] is True
        assert result["command"] == "follow_object"
        assert results["executed"] is True

    def test_bridge_reports_validation_failure(self):
        bridge = AICommandBridge()
        ai_output = '{"command": "invalid_cmd", "params": {}}'
        result = bridge.process_ai_output(ai_output)

        assert result["success"] is False
        assert result["error"] == "validation_failed"

    def test_bridge_reports_execution_failure(self):
        bridge = AICommandBridge()
        ai_output = '{"command": "focus_object", "params": {"object_id": 25544}}'
        result = bridge.process_ai_output(ai_output)

        assert result["success"] is False
        assert result["error"] == "execution_failed"

    def test_bridge_processes_dict_input(self):
        bridge = AICommandBridge()
        results = {}

        def mock_callback(params):
            results["executed"] = True
            return {"success": True, "data": "ok"}

        bridge.executor.register_callback(CommandName.SHOW_ORBIT, mock_callback)

        ai_data = {"command": "show_orbit", "params": {"object_id": 25544, "duration_minutes": 90}}
        result = bridge.process_ai_dict(ai_data)

        assert result["success"] is True
        assert result["command"] == "show_orbit"
        assert results["executed"] is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])