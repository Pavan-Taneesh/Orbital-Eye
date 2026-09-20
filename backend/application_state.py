"""Application state management (Person 3).

Manages application-level state, keeping scientific state and visual state
conceptually separate.

Scientific state includes:
- position, velocity, altitude, epoch, reference frame, orbital elements
- source, data age/status

Visual state includes:
- camera, highlight, labels, orbit visibility, animation, transitions, UI state
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class LoadingState(str, Enum):
    """Loading state for async operations."""

    IDLE = "idle"
    LOADING = "loading"
    SUCCESS = "success"
    ERROR = "error"


class AIState(str, Enum):
    """AI provider state."""

    IDLE = "idle"
    PROCESSING = "processing"
    SUCCESS = "success"
    ERROR = "error"
    UNAVAILABLE = "unavailable"


@dataclass
class ScientificState:
    """Scientific/orbital state for an object.

    This is the authoritative scientific data from Person 2's backend.
    NEVER modified by visual/camera state.
    """

    object_id: int | None = None
    position: list[float] | None = None  # ECEF [x, y, z] km
    velocity: list[float] | None = None  # ECEF [vx, vy, vz] km/s
    altitude: float | None = None  # km
    epoch: str | None = None  # ISO-8601
    frame: str = "ECEF"
    source: str | None = None
    age_hours: float | None = None
    status: str = "unavailable"  # fresh, stale, error, unavailable
    orbital_elements: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "object_id": self.object_id,
            "position": self.position,
            "velocity": self.velocity,
            "altitude": self.altitude,
            "epoch": self.epoch,
            "frame": self.frame,
            "source": self.source,
            "age_hours": self.age_hours,
            "status": self.status,
            "orbital_elements": self.orbital_elements,
        }

    @classmethod
    def from_state_response(cls, data: dict[str, Any]) -> ScientificState:
        """Create from backend StateResponse."""
        return cls(
            object_id=data.get("object_id"),
            position=data.get("position"),
            velocity=data.get("velocity"),
            altitude=data.get("altitude"),
            epoch=data.get("epoch"),
            frame=data.get("frame", "ECEF"),
            source=data.get("source"),
            age_hours=data.get("age_hours"),
            status=data.get("status", "unavailable"),
        )


@dataclass
class VisualState:
    """Visual/UI state.

    This is purely frontend/camera state. NEVER modifies scientific state.
    """

    # Camera
    camera_position: list[float] | None = None
    camera_target: list[float] | None = None
    camera_distance: float | None = None

    # Selection/highlight
    selected_object_id: int | None = None
    hovered_object_id: int | None = None

    # Orbit visualization
    show_orbit: bool = False
    orbit_object_id: int | None = None
    orbit_duration_minutes: int = 90

    # Follow mode
    follow_object_id: int | None = None
    follow_enabled: bool = False

    # Information panel
    info_panel_open: bool = False
    info_panel_object_id: int | None = None

    # Categories
    selected_categories: list[int] = field(default_factory=list)  # category_ids 1-7

    # Search
    search_query: str = ""
    search_results: list[dict[str, Any]] = field(default_factory=list)
    search_loading: LoadingState = LoadingState.IDLE

    # Animation
    animating: bool = False
    animation_target: str | None = None


@dataclass
class AIStatus:
    """AI provider status and usage tracking."""

    state: AIState = AIState.IDLE
    provider: str | None = None
    model: str | None = None
    last_request: datetime | None = None
    last_response: str | None = None
    error: str | None = None
    usage: dict[str, int] = field(default_factory=dict)  # input_tokens, output_tokens, total_tokens
    request_count: int = 0

    def record_request(self, provider: str, model: str, usage: dict[str, int] = None):
        self.state = AIState.PROCESSING
        self.provider = provider
        self.model = model
        self.last_request = datetime.utcnow()
        self.request_count += 1

    def record_success(self, response: str, usage: dict[str, int] = None):
        self.state = AIState.SUCCESS
        self.last_response = response
        if usage:
            self.usage = usage
            # Accumulate totals
            self.usage["total_requests"] = self.request_count

    def record_error(self, error: str):
        self.state = AIState.ERROR
        self.error = error


@dataclass
class ApplicationState:
    """Complete application state.

    Single source of truth for application-level state.
    Scientific and visual state are kept separate.
    """

    # Scientific state (from Person 2 backend)
    scientific: ScientificState = field(default_factory=ScientificState)

    # Visual state (frontend/camera)
    visual: VisualState = field(default_factory=VisualState)

    # AI status
    ai: AIStatus = field(default_factory=AIStatus)

    # Global loading/error
    loading: LoadingState = LoadingState.IDLE
    error: str | None = None

    # Diagnostics (dev-only)
    diagnostics: dict[str, Any] | None = None

    # Object details cache
    object_details_cache: dict[int, dict[str, Any]] = field(default_factory=dict)

    def reset_scientific(self):
        """Reset scientific state (e.g., when changing objects)."""
        self.scientific = ScientificState()

    def update_scientific(self, data: dict[str, Any]):
        """Update scientific state from backend response."""
        self.scientific = ScientificState.from_state_response(data)

    def set_selected_object(self, object_id: int | None):
        """Set selected object (updates both scientific and visual)."""
        self.visual.selected_object_id = object_id
        if object_id is not None:
            self.visual.hovered_object_id = None

    def set_hovered_object(self, object_id: int | None):
        """Set hovered object (visual only)."""
        self.visual.hovered_object_id = object_id

    def set_follow_mode(self, object_id: int | None, enabled: bool = True):
        """Set follow mode for an object."""
        self.visual.follow_object_id = object_id if enabled else None
        self.visual.follow_enabled = enabled

    def set_orbit_visibility(self, object_id: int | None, show: bool, duration_minutes: int = 90):
        """Set orbit path visibility."""
        self.visual.show_orbit = show
        self.visual.orbit_object_id = object_id if show else None
        self.visual.orbit_duration_minutes = duration_minutes

    def toggle_info_panel(self, object_id: int | None = None):
        """Toggle information panel."""
        if object_id is not None:
            self.visual.info_panel_object_id = object_id
        self.visual.info_panel_open = not self.visual.info_panel_open
        if not self.visual.info_panel_open:
            self.visual.info_panel_object_id = None

    def set_categories(self, category_ids: list[int]):
        """Set selected category filters."""
        self.visual.selected_categories = [c for c in category_ids if 1 <= c <= 7]

    def toggle_category(self, category_id: int):
        """Toggle a category filter."""
        if 1 <= category_id <= 7:
            if category_id in self.visual.selected_categories:
                self.visual.selected_categories.remove(category_id)
            else:
                self.visual.selected_categories.append(category_id)

    def set_search_query(self, query: str):
        """Set search query."""
        self.visual.search_query = query.strip()

    def set_search_results(self, results: list[dict[str, Any]], loading: LoadingState = LoadingState.SUCCESS):
        """Set search results."""
        self.visual.search_results = results
        self.visual.search_loading = loading

    def cache_object_details(self, object_id: int, details: dict[str, Any]):
        """Cache object details."""
        self.object_details_cache[object_id] = details

    def get_cached_object_details(self, object_id: int) -> dict[str, Any] | None:
        """Get cached object details."""
        return self.object_details_cache.get(object_id)

    def clear_cache(self):
        """Clear object details cache."""
        self.object_details_cache.clear()

    def set_diagnostics(self, data: dict[str, Any] | None):
        """Set diagnostics data (dev-only)."""
        self.diagnostics = data

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict for frontend synchronization."""
        return {
            "scientific": self.scientific.to_dict(),
            "visual": {
                "camera_position": self.visual.camera_position,
                "camera_target": self.visual.camera_target,
                "camera_distance": self.visual.camera_distance,
                "selected_object_id": self.visual.selected_object_id,
                "hovered_object_id": self.visual.hovered_object_id,
                "show_orbit": self.visual.show_orbit,
                "orbit_object_id": self.visual.orbit_object_id,
                "orbit_duration_minutes": self.visual.orbit_duration_minutes,
                "follow_object_id": self.visual.follow_object_id,
                "follow_enabled": self.visual.follow_enabled,
                "info_panel_open": self.visual.info_panel_open,
                "info_panel_object_id": self.visual.info_panel_object_id,
                "selected_categories": self.visual.selected_categories,
                "search_query": self.visual.search_query,
                "search_loading": self.visual.search_loading.value,
                "animating": self.visual.animating,
                "animation_target": self.visual.animation_target,
            },
            "ai": {
                "state": self.ai.state.value,
                "provider": self.ai.provider,
                "model": self.ai.model,
                "last_request": self.ai.last_request.isoformat() if self.ai.last_request else None,
                "error": self.ai.error,
                "usage": self.ai.usage,
                "request_count": self.ai.request_count,
            },
            "loading": self.loading.value,
            "error": self.error,
            "diagnostics": self.diagnostics,
        }


# Global application state instance
_app_state: ApplicationState | None = None


def get_app_state() -> ApplicationState:
    """Get the global application state instance."""
    global _app_state
    if _app_state is None:
        _app_state = ApplicationState()
    return _app_state


def reset_app_state() -> ApplicationState:
    """Reset the global application state."""
    global _app_state
    _app_state = ApplicationState()
    return _app_state