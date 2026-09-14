"""Tests for application state management (Person 3)."""

from __future__ import annotations

import pytest

from backend.application_state import (
    LoadingState,
    AIState,
    ScientificState,
    VisualState,
    AIStatus,
    ApplicationState,
    get_app_state,
    reset_app_state,
)


class TestScientificState:
    """Test ScientificState."""

    def test_default_state(self):
        state = ScientificState()
        assert state.object_id is None
        assert state.status == "unavailable"
        assert state.frame == "ECEF"

    def test_from_state_response(self):
        data = {
            "object_id": 25544,
            "position": [1.0, 2.0, 3.0],
            "velocity": [0.1, 0.2, 0.3],
            "altitude": 400.0,
            "epoch": "2026-08-13T03:34:14",
            "frame": "ECEF",
            "source": "Space-Track",
            "age_hours": 1.5,
            "status": "fresh",
        }
        state = ScientificState.from_state_response(data)
        assert state.object_id == 25544
        assert state.position == [1.0, 2.0, 3.0]
        assert state.altitude == 400.0
        assert state.status == "fresh"

    def test_to_dict(self):
        state = ScientificState(
            object_id=1,
            position=[1.0, 2.0, 3.0],
            status="fresh",
        )
        d = state.to_dict()
        assert d["object_id"] == 1
        assert d["position"] == [1.0, 2.0, 3.0]
        assert d["status"] == "fresh"


class TestVisualState:
    """Test VisualState."""

    def test_default_state(self):
        state = VisualState()
        assert state.selected_object_id is None
        assert state.hovered_object_id is None
        assert state.show_orbit is False
        assert state.follow_enabled is False
        assert state.info_panel_open is False
        assert state.selected_categories == []
        assert state.search_query == ""
        assert state.search_loading == LoadingState.IDLE

    def test_state_independence(self):
        """Visual state should be independent of scientific state."""
        state = VisualState()
        state.selected_object_id = 25544
        state.show_orbit = True
        assert state.selected_object_id == 25544
        assert state.show_orbit is True


class TestAIStatus:
    """Test AIStatus."""

    def test_default_state(self):
        status = AIStatus()
        assert status.state == AIState.IDLE
        assert status.provider is None
        assert status.request_count == 0

    def test_record_request(self):
        status = AIStatus()
        status.record_request("gemini", "gemini-1.5-flash")
        assert status.state == AIState.PROCESSING
        assert status.provider == "gemini"
        assert status.model == "gemini-1.5-flash"
        assert status.request_count == 1

    def test_record_success(self):
        status = AIStatus()
        status.record_success("response text", {"input": 10, "output": 20, "total": 30})
        assert status.state == AIState.SUCCESS
        assert status.last_response == "response text"
        assert status.usage["total"] == 30

    def test_record_error(self):
        status = AIStatus()
        status.record_error("API timeout")
        assert status.state == AIState.ERROR
        assert status.error == "API timeout"


class TestApplicationState:
    """Test ApplicationState integration."""

    def test_default_state(self):
        state = ApplicationState()
        assert state.scientific.status == "unavailable"
        assert state.visual.selected_object_id is None
        assert state.ai.state == AIState.IDLE
        assert state.loading == LoadingState.IDLE

    def test_set_selected_object(self):
        state = ApplicationState()
        state.set_selected_object(25544)
        assert state.visual.selected_object_id == 25544
        assert state.visual.hovered_object_id is None

    def test_set_hovered_object(self):
        state = ApplicationState()
        state.set_hovered_object(12345)
        assert state.visual.hovered_object_id == 12345

    def test_set_follow_mode(self):
        state = ApplicationState()
        state.set_follow_mode(25544, True)
        assert state.visual.follow_object_id == 25544
        assert state.visual.follow_enabled is True

        state.set_follow_mode(None, False)
        assert state.visual.follow_object_id is None
        assert state.visual.follow_enabled is False

    def test_set_orbit_visibility(self):
        state = ApplicationState()
        state.set_orbit_visibility(25544, True, 120)
        assert state.visual.show_orbit is True
        assert state.visual.orbit_object_id == 25544
        assert state.visual.orbit_duration_minutes == 120

        state.set_orbit_visibility(None, False)
        assert state.visual.show_orbit is False
        assert state.visual.orbit_object_id is None

    def test_toggle_info_panel(self):
        state = ApplicationState()
        state.toggle_info_panel(25544)
        assert state.visual.info_panel_open is True
        assert state.visual.info_panel_object_id == 25544

        state.toggle_info_panel()
        assert state.visual.info_panel_open is False
        assert state.visual.info_panel_object_id is None

    def test_category_management(self):
        state = ApplicationState()
        state.set_categories([1, 2, 3])
        assert state.visual.selected_categories == [1, 2, 3]

        state.toggle_category(4)
        assert state.visual.selected_categories == [1, 2, 3, 4]

        state.toggle_category(2)
        assert state.visual.selected_categories == [1, 3, 4]

        # Invalid categories ignored
        state.toggle_category(0)
        state.toggle_category(8)
        assert state.visual.selected_categories == [1, 3, 4]

    def test_search_management(self):
        state = ApplicationState()
        state.set_search_query("ISS")
        assert state.visual.search_query == "ISS"

        state.set_search_results([{"object_id": 25544, "name": "ISS"}])
        assert len(state.visual.search_results) == 1
        assert state.visual.search_loading == LoadingState.SUCCESS

    def test_object_details_cache(self):
        state = ApplicationState()
        state.cache_object_details(25544, {"name": "ISS", "norad_id": 25544})
        cached = state.get_cached_object_details(25544)
        assert cached is not None
        assert cached["name"] == "ISS"

        assert state.get_cached_object_details(99999) is None

        state.clear_cache()
        assert state.get_cached_object_details(25544) is None

    def test_update_scientific(self):
        state = ApplicationState()
        data = {
            "object_id": 25544,
            "position": [1.0, 2.0, 3.0],
            "status": "fresh",
        }
        state.update_scientific(data)
        assert state.scientific.object_id == 25544
        assert state.scientific.status == "fresh"

    def test_to_dict_serialization(self):
        state = ApplicationState()
        state.set_selected_object(25544)
        state.set_follow_mode(25544, True)
        state.ai.record_request("gemini", "gemini-1.5-flash")

        d = state.to_dict()
        assert d["visual"]["selected_object_id"] == 25544
        assert d["visual"]["follow_enabled"] is True
        assert d["ai"]["state"] == "processing"
        assert d["ai"]["provider"] == "gemini"


class TestGlobalState:
    """Test global state functions."""

    def test_get_app_state_returns_instance(self):
        reset_app_state()
        state = get_app_state()
        assert isinstance(state, ApplicationState)

    def test_reset_creates_new_instance(self):
        state1 = get_app_state()
        state1.set_selected_object(1)
        reset_app_state()
        state2 = get_app_state()
        assert state2.visual.selected_object_id is None
        assert state1 is not state2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])