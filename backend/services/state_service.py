"""State service layer.

Application-level orchestration for orbital state retrieval.
Wraps logic.state_model.get_state() into a consistent interface
used by both FastAPI routes and CLI commands.

Do NOT rewrite propagation or scientific algorithms.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from logic.state_model import get_state  # type: ignore
from fastapi import HTTPException


def state_service(object_id: int, when: Optional[Any] = None) -> Dict[str, Any]:
    """Get orbital state for an object.

    Application-level orchestration for GET /api/v1/objects/{object_id}/state.
    Delegates to logic.state_model.get_state() and translates the
    resulting status into appropriate HTTP behavior.

    Args:
        object_id: Positive object identifier
        when: UTC datetime for state evaluation (defaults to now)

    Returns:
        Dict with orbital state information including status key.
        Status is one of: "fresh", "stale", "error", "unavailable".

    Raises:
        ValueError: If object_id is not a positive integer
        HTTPException: If object state is unavailable (404)
    """

    if not isinstance(object_id, int) or object_id < 1:
        raise ValueError(f"object_id must be a positive integer, got {object_id}")

    state = get_state(object_id, when)
    if state["status"] == "unavailable":
        raise HTTPException(status_code=404, detail="no orbital data for this object")
    return state