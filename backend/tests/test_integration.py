"""Integration tests for Person 3 end-to-end flows.

These tests verify the complete orchestration from user input through
AI interpretation, command validation, execution, and application state
updates. All use the fake AI provider so no external API is required.
The backend API calls are mocked / skipped when the server is unavailable.
"""

from __future__ import annotations

import pytest
from backend.ai import FakeProvider, make_service
from backend.ai_exploration import (
    AIExplorationService,
    ExplorationContext,
)
from backend.application_state import (
    get_app_state,
    reset_app_state,
)
from backend.command_system import (
    AICommandBridge,
    ApplicationCommand,
    CommandExecutor,
    CommandName,
)


class TestAICommandFlow:
    """AI flow: natural language → structured command → validation → execution."""

    def test_ai_explore_take_me_to_iss(self):
        """AI exploration: 'Take me to the ISS' → focus_object command."""
        reset_app_state()
        fake_provider = FakeProvider(
            respond_with='{"command": "focus_object", "params": {"object_id": 25544}}'
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()

        executed = {}

        def mock_callback(params):
            executed["object_id"] = params.object_id
            return {"success": True, "data": {"object_id": 25544}}

        bridge.executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Take me to the ISS")

        assert result.success is True
        assert result.command == "focus_object"
        assert executed["object_id"] == 25544

    def test_ai_explore_show_orbit(self):
        """AI exploration: 'Show its orbit' → show_orbit command."""
        reset_app_state()
        fake_provider = FakeProvider(
            respond_with='{"command": "show_orbit", "params": {"object_id": 25544, "duration_minutes": 90}}'
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()

        def mock_callback(params):
            return {"success": True, "data": {}}

        bridge.executor.register_callback(CommandName.SHOW_ORBIT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Show orbit for the satellite")

        assert result.success is True
        assert result.command == "show_orbit"

    def test_ai_explore_follow_object(self):
        """AI exploration: 'Follow this satellite' → follow_object command."""
        reset_app_state()
        fake_provider = FakeProvider(
            respond_with='{"command": "follow_object", "params": {"object_id": 25544, "enable": true}}'
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()

        def mock_callback(params):
            return {"success": True, "data": {}}

        bridge.executor.register_callback(CommandName.FOLLOW_OBJECT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Follow object 25544")

        assert result.success is True
        assert result.command == "follow_object"

    def test_ai_explore_open_info_panel(self):
        """AI exploration: 'Open information' → open_information_panel command."""
        reset_app_state()
        fake_provider = FakeProvider(
            respond_with='{"command": "open_information_panel", "params": {"object_id": 25544}}'
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()

        def mock_callback(params):
            return {"success": True, "data": {}}

        bridge.executor.register_callback(CommandName.OPEN_INFORMATION_PANEL, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Open the information panel")

        assert result.success is True
        assert result.command == "open_information_panel"


class TestInvalidAIOutput:
    """Invalid AI output flow: malformed/unsupported → validation failure → safe rejection."""

    def test_ai_invalid_command_rejected(self):
        """Unsupported command is rejected."""
        reset_app_state()
        fake_provider = FakeProvider(respond_with='{"command": "delete_database", "params": {}}')
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Do the thing")

        assert result.success is False
        assert result.error_type == "validation_failed"
        assert "not allowed" in result.error.lower()

    def test_ai_malformed_json_rejected(self):
        """Malformed JSON is rejected."""
        reset_app_state()
        fake_provider = FakeProvider(respond_with="not valid json")
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "validation_failed"

    def test_ai_missing_fields_rejected(self):
        """Missing required fields are rejected."""
        reset_app_state()
        fake_provider = FakeProvider(respond_with='{"command": "focus_object"}')
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "validation_failed"

    def test_ai_wrong_param_types_rejected(self):
        """Wrong parameter types are rejected."""
        reset_app_state()
        fake_provider = FakeProvider(
            respond_with='{"command": "focus_object", "params": {"object_id": "not_a_number"}}'
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "validation_failed"


class TestErrorFlows:
    """Error flow: backend unavailable, stale state, etc."""

    def test_ai_with_missing_credentials(self):
        """AI provider reports missing credentials."""
        from backend.ai import GeminiProvider

        provider = GeminiProvider(api_key=None)
        ai_service = make_service("fake")
        ai_service.provider = provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "missing_credentials"

    def test_ai_with_timeout(self):
        """AI request times out."""
        reset_app_state()
        fake_provider = FakeProvider(respond_with="timeout")
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "timeout"

    def test_ai_provider_failure(self):
        """AI provider reports an error."""
        reset_app_state()
        fake_provider = FakeProvider(respond_with="error")
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "provider_failure"

    def test_command_executor_no_path(self):
        """Command execution fails when no callback and no API client."""
        executor = CommandExecutor()

        cmd = ApplicationCommand(
            command=CommandName.FOCUS_OBJECT,
            params={"object_id": 25544},
        )

        with pytest.raises(Exception) as exc_info:
            executor.execute(cmd)

        assert "No execution path" in str(exc_info.value)


class TestApplicationStateIntegration:
    """Application state integration with AI exploration."""

    def test_state_persists_through_exploration(self):
        """Application state is updated correctly during exploration."""
        reset_app_state()
        app_state = get_app_state()

        fake_provider = FakeProvider(
            respond_with='{"command": "focus_object", "params": {"object_id": 25544}}'
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()

        def mock_callback(params):
            app_state.set_selected_object(params.object_id)
            return {"success": True, "data": {}}

        bridge.executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Take me to the ISS")

        assert result.success is True
        assert app_state.visual.selected_object_id == 25544
        assert app_state.visual.follow_object_id is None

    def test_ai_usage_tracking_persists(self):
        """AI usage tracking persists across explorations."""
        fake_provider = FakeProvider(
            respond_with='{"command": "focus_object", "params": {"object_id": 25544}}',
            usage_input_tokens=10,
            usage_output_tokens=20,
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        def mock_callback(params):
            return {"success": True, "data": {}}
        bridge.executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        service.explore("Test 1")
        service.explore("Test 2")

        stats = service.get_usage_stats()
        assert stats["total_requests"] == 2
        assert stats["total_input_tokens"] == 20
        assert stats["total_output_tokens"] == 40
        assert stats["success_rate"] == 1.0


class TestExplorationContext:
    """Exploration context construction and diagnostics inclusion."""

    def test_context_includes_selected_object(self):
        """Context includes the selected object ID."""
        reset_app_state()
        app_state = get_app_state()
        app_state.set_selected_object(25544)
        app_state.visual.selected_categories = [1, 2, 3]

        ctx = ExplorationContext(
            selected_object_id=app_state.visual.selected_object_id,
            hovered_object_id=app_state.visual.hovered_object_id,
            selected_categories=app_state.visual.selected_categories,
            search_query=app_state.visual.search_query,
        )
        assert ctx.selected_object_id == 25544
        assert ctx.selected_categories == [1, 2, 3]

    def test_context_with_diagnostics(self):
        """Context can include diagnostics data."""
        ctx = ExplorationContext(
            selected_object_id=25544,
            diagnostics={"object_id": 25544, "status": "fresh"},
        )
        assert ctx.diagnostics is not None
        assert ctx.diagnostics["object_id"] == 25544
        assert ctx.diagnostics["status"] == "fresh"

    def test_context_without_diagnostics(self):
        """Context works without diagnostics."""
        ctx = ExplorationContext(
            selected_object_id=25544,
            diagnostics=None,
        )
        assert ctx.diagnostics is None