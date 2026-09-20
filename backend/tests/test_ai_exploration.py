"""Tests for AI Exploration Service (Person 3)."""

from __future__ import annotations

import pytest
from backend.ai import FakeProvider, make_service
from backend.ai_exploration import (
    SYSTEM_PROMPT,
    AIExplorationService,
    ExplorationContext,
)
from backend.command_system import AICommandBridge, CommandName


class TestExplorationContext:
    """Test ExplorationContext."""

    def test_to_dict(self):
        ctx = ExplorationContext(
            selected_object_id=25544,
            hovered_object_id=12345,
            selected_categories=[1, 2],
            search_query="ISS",
        )
        d = ctx.to_dict()
        assert d["selected_object_id"] == 25544
        assert d["hovered_object_id"] == 12345
        assert d["selected_categories"] == [1, 2]
        assert d["search_query"] == "ISS"
        assert "find_object" in d["available_commands"]


class TestAIExplorationService:
    """Test AIExplorationService."""

    def test_service_creation(self):
        service = AIExplorationService()
        assert service.ai_service is not None
        assert service.command_bridge is not None

    def test_explore_with_fake_provider_success(self):
        """Test explore with fake provider returning valid command."""
        fake_provider = FakeProvider(respond_with='{"command": "focus_object", "params": {"object_id": 25544}}')
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        # Register mock callback
        def mock_callback(params):
            return {"success": True, "data": {"object_id": 25544}}
        bridge.executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Take me to the ISS")

        assert result.success is True
        assert result.command == "focus_object"
        assert result.ai_response is not None
        assert result.latency_ms > 0

    def test_explore_with_fake_provider_validation_failure(self):
        """Test explore with fake provider returning invalid command."""
        fake_provider = FakeProvider(respond_with='{"command": "invalid_cmd", "params": {}}')
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Do something bad")

        assert result.success is False
        assert result.error_type == "validation_failed"
        assert "not allowed" in result.error.lower()

    def test_explore_with_fake_provider_malformed_json(self):
        """Test explore with fake provider returning malformed JSON."""
        fake_provider = FakeProvider(respond_with="not valid json")
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "validation_failed"

    def test_explore_missing_credentials(self):
        """Test explore with missing credentials."""
        from backend.ai import GeminiProvider

        # Create service with gemini provider but no API key
        provider = GeminiProvider(api_key=None)
        ai_service = make_service("fake")  # Use fake as base
        ai_service.provider = provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "missing_credentials"
        assert "not configured" in result.error.lower()

    def test_explore_provider_timeout(self):
        """Test explore with provider timeout."""
        fake_provider = FakeProvider(respond_with="timeout")
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "timeout"

    def test_explore_provider_failure(self):
        """Test explore with provider failure."""
        fake_provider = FakeProvider(respond_with="error")
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        result = service.explore("Test")

        assert result.success is False
        assert result.error_type == "provider_failure"

    def test_usage_stats(self):
        """Test usage statistics tracking."""
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
        assert stats["total_tokens"] == 60
        assert stats["success_rate"] == 1.0

    def test_usage_stats_with_errors(self):
        """Test usage statistics with errors."""
        fake_provider = FakeProvider(respond_with='{"command": "invalid", "params": {}}')
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        service.explore("Test 1")
        service.explore("Test 2")

        stats = service.get_usage_stats()
        assert stats["total_requests"] == 2
        assert stats["total_errors"] == 2
        assert stats["success_rate"] == 0.0

    def test_reset_stats(self):
        """Test statistics reset."""
        fake_provider = FakeProvider(respond_with='{"command": "focus_object", "params": {"object_id": 25544}}')
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()
        def mock_callback(params):
            return {"success": True, "data": {}}
        bridge.executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)
        service.explore("Test")
        service.reset_stats()

        stats = service.get_usage_stats()
        assert stats["total_requests"] == 0
        assert stats["total_errors"] == 0

    def test_build_prompt_includes_context(self):
        """Test prompt building includes relevant context."""
        service = AIExplorationService()
        context = ExplorationContext(
            selected_object_id=25544,
            selected_categories=[1],
            search_query="satellite",
        )
        prompt = service._build_prompt("Show me this", context)

        assert "25544" in prompt
        assert "satellite" in prompt
        assert "focus_object" in prompt


class TestSystemPrompt:
    """Test system prompt contains required commands."""

    def test_all_commands_documented(self):
        for cmd in CommandName:
            assert cmd.value in SYSTEM_PROMPT

    def test_params_documented(self):
        assert "object_id" in SYSTEM_PROMPT
        assert "query" in SYSTEM_PROMPT
        assert "category" in SYSTEM_PROMPT


if __name__ == "__main__":
    pytest.main([__file__, "-v"])