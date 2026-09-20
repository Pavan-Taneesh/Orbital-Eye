"""Diagnostics service layer.

Application-level orchestration for diagnostics retrieval.
Wraps logic.diagnostics.get_diagnostics() into a consistent interface
used by both FastAPI routes and CLI commands.

Do NOT duplicate diagnostic calculations — delegate to Person 2 foundation.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from logic import diagnostics  # type: ignore


def diagnostics_service(object_id: int) -> dict[str, Any]:
    """Get diagnostics for an object.

    Application-level orchestration for GET /api/v1/objects/{object_id}/diagnostics.
    Delegates to logic.diagnostics.get_diagnostics() and translates
    the result into appropriate HTTP behavior.

    Args:
        object_id: Positive object identifier

    Returns:
        Dict with diagnostics information including status key.

    Raises:
        ValueError: If object_id is not a positive integer
        HTTPException: If no orbital data for this object (404)
    """

    if not isinstance(object_id, int) or object_id < 1:
        raise ValueError(f"object_id must be a positive integer, got {object_id}")

    diag = diagnostics.get_diagnostics(object_id)
    if diag["raw_latest_row"] is None:
        raise HTTPException(status_code=404, detail="no orbital data for this object")
    return diag