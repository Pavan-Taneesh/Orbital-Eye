"""State service layer.

Application-level orchestration for orbital state retrieval.
Wraps logic.state_model.get_state() into a consistent interface
used by both FastAPI routes and CLI commands.

Do NOT rewrite propagation or scientific algorithms.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from db import get_connection
from logic.state_model import get_state


def state_service(object_id: int, when: Any | None = None) -> dict[str, Any]:
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
    return dict(state)


def bulk_state_service(
    category: int | None = None,
    limit: int = 250,
    offset: int = 0,
    when: Any | None = None,
) -> dict[str, Any]:
    """Get orbital states for multiple objects in a category.

    Application-level orchestration for GET /api/v1/objects/states.
    Fetches object IDs for the category, then retrieves state for each.

    Args:
        category: Optional category_id filter (1-7)
        limit: Max 250 results per page (default: 250)
        offset: Pagination offset (default: 0)
        when: UTC datetime for state evaluation (defaults to now)

    Returns:
        Dict with paginated state results.
    """
    limit = max(1, min(limit, 250))
    offset = max(0, offset)

    base_where = ""
    params: list[Any] = []
    if category is not None:
        base_where = "WHERE category_id = %s"
        params.append(category)

    conn = get_connection()
    cur = conn.cursor()

    # Get total count
    cur.execute(f"SELECT COUNT(*) FROM objects {base_where};", params)
    total_count = cur.fetchone()[0]

    # Get object IDs for this page
    query = f"""
        SELECT object_id
        FROM objects
        {base_where}
        ORDER BY object_id
        LIMIT %s OFFSET %s;
    """
    cur.execute(query, params + [limit, offset])
    rows = cur.fetchall()
    cur.close()
    conn.close()

    object_ids = [r[0] for r in rows]

    # Fetch state for each object
    results = []
    for obj_id in object_ids:
        state = get_state(obj_id, when)
        # Include all states, even unavailable (frontend will handle)
        results.append(state)

    return {
        "results": results,
        "count": len(results),
        "total_count": total_count,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(results) < total_count,
    }