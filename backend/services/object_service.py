"""Object-level service layer.

Application-level orchestration for object operations: search, listing,
detail retrieval, and media. Reuses Pydantic schemas and re-exports
helpful types. Database access is abstracted behind this service so
both FastAPI routes and CLI commands can share the same logic.

Do NOT duplicate scientific algorithms — delegate to Person 2 foundation
where appropriate.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import psycopg2
from fastapi import HTTPException



def _validate_object_id(object_id: int) -> None:
    """Validate that object_id is a positive integer.

    Raises ValueError if invalid.
    """
    if not isinstance(object_id, int) or object_id < 1:
        raise ValueError(f"object_id must be a positive integer, got {object_id}")


def search_objects(
    q: str = "",
    category: Optional[int] = None,
    limit: int = 20,
    offset: int = 0,
) -> Dict[str, Any]:
    """Search objects with optional query and category filter.

    Application-level orchestration for GET /api/v1/objects/search.
    Calls the service layer rather than containing raw SQL.

    Args:
        q: Case-insensitive match against object name (default: "")
        category: Optional filter by category_id (1-7)
        limit: Max 100 results per page (default: 20)
        offset: Pagination offset (default: 0)

    Returns:
        Dict with paginated search results matching the PaginatedResponse schema.
    """
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    base_where = "WHERE o.name ILIKE %s"
    params = [f"%{q}%"]
    if category is not None:
        base_where += " AND o.category_id = %s"
        params.append(category)

    conn = connect()
    cur = conn.cursor()

    # total count (for has_more / pagination metadata)
    cur.execute(f"SELECT COUNT(*) FROM objects o {base_where};", params)
    total_count = cur.fetchone()[0]

    query = f"""
        SELECT o.object_id, o.name, o.norad_id, o.category_id
        FROM objects o
        {base_where}
        ORDER BY o.object_id
        LIMIT %s OFFSET %s;
    """
    cur.execute(query, params + [limit, offset])
    rows = cur.fetchall()
    cur.close()
    conn.close()

    results = [
        {"object_id": r[0], "name": r[1], "norad_id": r[2], "category_id": r[3]}
        for r in rows
    ]
    return {
        "results": results,
        "count": len(results),
        "total_count": total_count,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(results) < total_count,
    }


def list_objects(
    category: Optional[int] = None,
    limit: int = 20,
    offset: int = 0,
) -> Dict[str, Any]:
    """List objects with optional category filter.

    Application-level orchestration for GET /api/v1/objects.
    Calls the service layer rather than containing raw SQL.

    Args:
        category: Optional category_id filter (1-7)
        limit: Max 100 results per page (default: 20)
        offset: Pagination offset (default: 0)

    Returns:
        Dict with paginated results matching the PaginatedResponse schema.
    """
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    base_where = ""
    params: List[Any] = []
    if category is not None:
        base_where = "WHERE category_id = %s"
        params.append(category)

    conn = connect()
    cur = conn.cursor()

    cur.execute(f"SELECT COUNT(*) FROM objects {base_where};", params)
    total_count = cur.fetchone()[0]

    query = f"""
        SELECT object_id, name, norad_id, category_id
        FROM objects
        {base_where}
        ORDER BY object_id
        LIMIT %s OFFSET %s;
    """
    cur.execute(query, params + [limit, offset])
    rows = cur.fetchall()
    cur.close()
    conn.close()

    results = [
        {"object_id": r[0], "name": r[1], "norad_id": r[2], "category_id": r[3]}
        for r in rows
    ]
    return {
        "results": results,
        "count": len(results),
        "total_count": total_count,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(results) < total_count,
    }


def get_object(object_id: int) -> Dict[str, Any]:
    """Get a single object's full details.

    Application-level orchestration for GET /api/v1/objects/{object_id}.
    Validates the object_id, delegates to database access, and constructs
    the ObjectDetails response using the shared build_object_details_from_row helper.

    Args:
        object_id: Positive object identifier

    Returns:
        Dict with object details matching the ObjectDetails schema.

    Raises:
        ValueError: If object_id is not a positive integer
        HTTPException: If object not found (404)
    """
    _validate_object_id(object_id)

    conn = connect()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT o.object_id, o.name, c.name AS category, o.norad_id
        FROM objects o
        LEFT JOIN categories c ON o.category_id = c.category_id
        WHERE o.object_id = %s;
        """,
        (object_id,),
    )
    row = cur.fetchone()
    if row is None:
        cur.close()
        conn.close()
        raise HTTPException(status_code=404, detail="object not found")

    obj_id, name, category, norad_id = row

    cur.execute(
        "SELECT field_name, field_value FROM resolved_metadata WHERE object_id = %s;",
        (object_id,),
    )
    metadata = {field_name: field_value for field_name, field_value in cur.fetchall()}

    cur.execute(
        "SELECT url, media_type, source_id FROM media WHERE object_id = %s;",
        (object_id,),
    )
    media_rows = cur.fetchall()
    cur.close()
    conn.close()

    od = build_object_details_from_row(
        object_id=obj_id,
        name=name,
        category_id=category_id if isinstance(category, int) else None,  # type: ignore
        category=category,
        norad_id=norad_id,
        resolved_metadata=metadata,
        media_rows=media_rows,
    )

    return od.model_dump()


def get_object_media(object_id: int) -> Dict[str, Any]:
    """Get media attachments for a single object.

    Application-level orchestration for GET /api/v1/objects/{object_id}/media.

    Args:
        object_id: Positive object identifier

    Returns:
        Dict with media list matching the MediaResponse schema.

    Raises:
        ValueError: If object_id is not a positive integer
    """
    _validate_object_id(object_id)

    conn = connect()
    cur = conn.cursor()
    cur.execute(
        "SELECT url, media_type, source_id FROM media WHERE object_id = %s;",
        (object_id,),
    )
    media_rows = cur.fetchall()
    cur.close()
    conn.close()

    media_items = [
        {"url": row.get("url", ""), "media_type": row.get("media_type", "image"), "source_id": row.get("source_id")}
        for row in media_rows
    ]

    return {"object_id": object_id, "media": media_items}