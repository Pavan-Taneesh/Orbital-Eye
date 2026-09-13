"""Service layer for the Space-website API.

Application-level orchestration shared between FastAPI routes and CLI commands.
Reuses existing Person 2 logic (state_model, diagnostics) and Pydantic schemas.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

__all__ = []