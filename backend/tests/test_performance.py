"""Performance tests for Person 3 components.

These tests measure latency and throughput of the application layer
without requiring external dependencies.
"""

from __future__ import annotations

import statistics
import time

import pytest
from backend.ai import FakeProvider, make_service
from backend.ai_exploration import AIExplorationService
from backend.application_state import get_app_state, reset_app_state
from backend.command_system import (
    AICommandBridge,
    ApplicationCommand,
    CommandExecutor,
    CommandName,
    CommandValidator,
)


class TestCommandSystemPerformance:
    """Performance tests for command system."""

    def test_command_validation_latency(self):
        """Measure command validation latency."""
        validator = CommandValidator()
        ai_output = '{"command": "focus_object", "params": {"object_id": 25544}}'

        # Warm up
        for _ in range(10):
            validator.validate_ai_output(ai_output)

        # Measure
        latencies = []
        for _ in range(100):
            start = time.perf_counter()
            validator.validate_ai_output(ai_output)
            latencies.append((time.perf_counter() - start) * 1000)

        avg_ms = statistics.mean(latencies)
        p99_ms = sorted(latencies)[98]

        print(f"\nCommand validation: avg={avg_ms:.2f}ms, p99={p99_ms:.2f}ms")
        assert avg_ms < 5.0  # Should be very fast
        assert p99_ms < 10.0

    def test_command_execution_latency(self):
        """Measure command execution latency with mock callback."""
        executor = CommandExecutor()

        def mock_callback(params):
            return {"success": True, "data": {"object_id": params.object_id}}

        executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        cmd = ApplicationCommand(
            command=CommandName.FOCUS_OBJECT,
            params={"object_id": 25544},
        )

        # Warm up
        for _ in range(10):
            executor.execute(cmd)

        # Measure
        latencies = []
        for _ in range(100):
            start = time.perf_counter()
            executor.execute(cmd)
            latencies.append((time.perf_counter() - start) * 1000)

        avg_ms = statistics.mean(latencies)
        p99_ms = sorted(latencies)[98]

        print(f"\nCommand execution: avg={avg_ms:.2f}ms, p99={p99_ms:.2f}ms")
        assert avg_ms < 5.0
        assert p99_ms < 10.0

    def test_bridge_latency(self):
        """Measure AI command bridge latency."""
        bridge = AICommandBridge()

        def mock_callback(params):
            return {"success": True, "data": {}}

        bridge.executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)
        bridge.executor.register_callback(CommandName.FIND_OBJECT, mock_callback)
        bridge.executor.register_callback(CommandName.FILTER_OBJECTS, mock_callback)

        ai_output = '{"command": "focus_object", "params": {"object_id": 25544}}'

        # Warm up
        for _ in range(10):
            bridge.process_ai_output(ai_output)

        # Measure
        latencies = []
        for _ in range(100):
            start = time.perf_counter()
            bridge.process_ai_output(ai_output)
            latencies.append((time.perf_counter() - start) * 1000)

        avg_ms = statistics.mean(latencies)
        p99_ms = sorted(latencies)[98]

        print(f"\nBridge processing: avg={avg_ms:.2f}ms, p99={p99_ms:.2f}ms")
        assert avg_ms < 10.0
        assert p99_ms < 20.0


class TestAIExplorationPerformance:
    """Performance tests for AI exploration service."""

    def test_fake_provider_latency(self):
        """Measure fake provider response latency."""
        fake_provider = FakeProvider(
            respond_with='{"command": "focus_object", "params": {"object_id": 25544}}'
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()

        def mock_callback(params):
            return {"success": True, "data": {}}

        bridge.executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        # Warm up
        for _ in range(5):
            service.explore("Test")

        # Measure
        latencies = []
        for _ in range(50):
            start = time.perf_counter()
            service.explore("Test")
            latencies.append((time.perf_counter() - start) * 1000)

        avg_ms = statistics.mean(latencies)
        p99_ms = sorted(latencies)[48]

        print(f"\nAI exploration (fake): avg={avg_ms:.2f}ms, p99={p99_ms:.2f}ms")
        assert avg_ms < 50.0  # Fake provider should be very fast
        assert p99_ms < 100.0

    def test_exploration_with_context(self):
        """Measure exploration with context building."""
        reset_app_state()
        app_state = get_app_state()
        app_state.set_selected_object(25544)
        app_state.visual.selected_categories = [1, 2, 3]

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

        # Warm up
        for _ in range(5):
            service.explore("Show orbit")

        # Measure
        latencies = []
        for _ in range(50):
            start = time.perf_counter()
            service.explore("Show orbit")
            latencies.append((time.perf_counter() - start) * 1000)

        avg_ms = statistics.mean(latencies)
        p99_ms = sorted(latencies)[48]

        print(f"\nAI exploration with context: avg={avg_ms:.2f}ms, p99={p99_ms:.2f}ms")
        assert avg_ms < 50.0
        assert p99_ms < 100.0


class TestApplicationStatePerformance:
    """Performance tests for application state."""

    def test_state_update_latency(self):
        """Measure application state update latency."""
        reset_app_state()
        state = get_app_state()

        # Measure scientific state update
        latencies = []
        for i in range(1000):
            start = time.perf_counter()
            state.update_scientific({
                "object_id": i,
                "position": [1.0, 2.0, 3.0],
                "status": "fresh",
            })
            latencies.append((time.perf_counter() - start) * 1000)

        avg_ms = statistics.mean(latencies)
        print(f"\nScientific state update: avg={avg_ms:.4f}ms")
        assert avg_ms < 1.0

    def test_visual_state_update_latency(self):
        """Measure visual state update latency."""
        reset_app_state()
        state = get_app_state()

        latencies = []
        for i in range(1000):
            start = time.perf_counter()
            state.set_selected_object(i)
            state.set_follow_mode(i, True)
            state.set_orbit_visibility(i, True)
            state.toggle_category((i % 7) + 1)
            latencies.append((time.perf_counter() - start) * 1000)

        avg_ms = statistics.mean(latencies)
        print(f"\nVisual state updates (4 ops): avg={avg_ms:.4f}ms")
        assert avg_ms < 1.0

    def test_serialization_latency(self):
        """Measure state serialization latency."""
        reset_app_state()
        state = get_app_state()
        state.set_selected_object(25544)
        state.set_follow_mode(25544, True)
        state.visual.selected_categories = [1, 2, 3]
        state.ai.record_request("gemini", "gemini-1.5-flash")

        latencies = []
        for _ in range(1000):
            start = time.perf_counter()
            state.to_dict()
            latencies.append((time.perf_counter() - start) * 1000)

        avg_ms = statistics.mean(latencies)
        print(f"\nState serialization: avg={avg_ms:.4f}ms")
        assert avg_ms < 1.0


class TestMemoryUsage:
    """Basic memory usage checks."""

    def test_application_state_memory(self):
        """Verify application state doesn't grow unbounded."""
        reset_app_state()
        state = get_app_state()

        # Add many cached objects
        for i in range(1000):
            state.cache_object_details(i, {"name": f"Object {i}", "data": "x" * 100})

        # Check cache size
        assert len(state.object_details_cache) == 1000

        # Clear and verify
        state.clear_cache()
        assert len(state.object_details_cache) == 0

    def test_ai_usage_tracking(self):
        """Verify AI usage tracking doesn't leak."""
        fake_provider = FakeProvider(
            respond_with='{"command": "focus_object", "params": {"object_id": 25544}}',
            usage_input_tokens=100,
            usage_output_tokens=200,
        )
        ai_service = make_service("fake")
        ai_service.provider = fake_provider

        bridge = AICommandBridge()

        def mock_callback(params):
            return {"success": True, "data": {}}

        bridge.executor.register_callback(CommandName.FOCUS_OBJECT, mock_callback)

        service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

        for _ in range(100):
            service.explore("Test")

        stats = service.get_usage_stats()
        assert stats["total_requests"] == 100
        assert stats["total_input_tokens"] == 10000
        assert stats["total_output_tokens"] == 20000


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])