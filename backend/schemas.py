"""Pydantic API models for the Space-website frozen API contract.

All models are explicit and typed. Public API boundary uses these models
instead of raw dicts. Database-layer models remain as-is.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field, validator


# ---------------------------------------------------------------------------
# Request / query models
# ---------------------------------------------------------------------------


class HealthCheckRequest(BaseModel):
    """Request model for GET /api/v1/health.

    No fields — health check is always public, no parameters.
    """

    pass


class SearchParams(BaseModel):
    """Request model for GET /api/v1/objects/search.

    q: case-insensitive match against object name (default: "")
    category: optional filter by category_id (1-7)
    limit: max 100, min 1 (default: 20)
    offset: pagination offset (default: 0)
    """

    q: str = Field(default="", description="Case-insensitive match against object name")
    category: Optional[int] = Field(default=None, ge=1, le=7, description="Filter by category_id (1-7)")
    limit: int = Field(default=20, ge=1, le=100, description="Max 100 results per page")
    offset: int = Field(default=0, ge=0, description="Pagination offset")

    @validator("q")
    def q_normalize(cls, v: str) -> str:
        return v.strip()


class ListParams(BaseModel):
    """Request model for GET /api/v1/objects.

    category: optional filter by category_id (1-7)
    limit: max 100, min 1 (default: 20)
    offset: pagination offset (default: 0)
    """

    category: Optional[int] = Field(default=None, ge=1, le=7, description="Filter by category_id (1-7)")
    limit: int = Field(default=20, ge=1, le=100, description="Max 100 results per page")
    offset: int = Field(default=0, ge=0, description="Pagination offset")


class ObjectIdPath(BaseModel):
    """Path parameter model for object_id across all object endpoints.

    Used by /objects/{object_id}, /state, /diagnostics, /media.
    """

    object_id: int = Field(..., gt=0, description="Positive object identifier")


class MediaQuery(BaseModel):
    """Query model for GET /api/v1/objects/{object_id}/media.

    object_id is a path parameter, validated via ObjectIdPath.
    """

    pass


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    """Response model for GET /api/v1/health.

    Always {"status": "ok"}.
    """

    status: str = Field(default="ok", description="API health status")


class ObjectSummary(BaseModel):
    """Summary of an object, used in search/list paginated responses.

    Appears in results array of PaginatedResponse.
    """

    object_id: int = Field(..., description="Primary key")
    name: str = Field(..., description="Common name")
    norad_id: int = Field(..., description="NORAD catalog number")
    category_id: int = Field(..., description="Category identifier (1-7)")


class PaginatedResponse(BaseModel):
    """Paginated response wrapping object summaries.

    Used by /objects/search and /objects listing endpoints.
    """

    results: list[ObjectSummary] = Field(default_factory=list, description="Page of object summaries")
    count: int = Field(default=0, description="Number of results in this page")
    total_count: int = Field(..., description="Total available objects across all pages")
    limit: int = Field(..., description="Limit parameter used for this page")
    offset: int = Field(..., description="Offset parameter used for this page")
    has_more: bool = Field(..., description="Whether more results are available beyond this page")


class ObjectDetails(BaseModel):
    """Full details for a single object.

    Response model for GET /api/v1/objects/{object_id}.

    Note: category_id is the canonical integer identifier (1-7).
    category is included for backward compatibility with the existing
    /objects/{object_id} response, which returns the category name from
    the categories table JOIN.
    """

    object_id: int = Field(..., description="Primary key")
    name: str = Field(..., description="Common name")
    category_id: Optional[int] = Field(
        default=None,
        description="Category identifier (1-7), may be null if unresolved",
    )
    category: Optional[str] = Field(
        default=None,
        description="Category name from categories table (backward compat)",
    )
    norad_id: Optional[int] = Field(
        default=None, description="NORAD catalog number, may be null"
    )
    metadata: dict[str, str] = Field(
        default_factory=dict,
        description="Resolved metadata key-value pairs from resolved_metadata table",
    )
    media: list[MediaResponseItem] = Field(
        default_factory=list,
        description="Media attachments (images/links) for this object",
    )


class MediaResponseItem(BaseModel):
    """One media entry in an object's media list.

    Appears in ObjectDetails.media and MediaResponse.media.
    """

    url: str = Field(..., description="URL to the media resource")
    media_type: str = Field(
        default="image",
        description="MIME type or category (image, video, link, etc.)",
    )
    source_id: Optional[int] = Field(
        default=None,
        description="Source identifier referencing the sources table, may be null",
    )


class StateResponse(BaseModel):
    """Orbital state response model for GET /api/v1/objects/{object_id}/state.

    Exact output of state_model.get_state() — Contract C.
    """

    object_id: int = Field(..., description="Object identifier")
    position: list[float] | None = Field(
        default=None,
        description="ECEF position [x, y, z] in km, or null if unavailable",
    )
    velocity: list[float] | None = Field(
        default=None,
        description="ECEF velocity [vx, vy, vz] in km/s, or null if unavailable",
    )
    altitude: float | None = Field(
        default=None,
        description="Altitude in km above mean sea level, or null if unavailable",
    )
    epoch: str | None = Field(
        default=None,
        description="ISO-8601 epoch timestamp, or null if unavailable",
    )
    frame: str = Field(default="ECEF", description="Reference frame, always 'ECEF' per state_model")
    source: str | None = Field(
        default=None,
        description="Data source name (CelesTrak, Space-Track, SatNOGS, ESA DISCOS), or null",
    )
    age_hours: float | None = Field(
        default=None,
        description="Age of orbital data in hours, or null if unavailable",
    )
    status: str = Field(
        ...,
        description="Fresh / stale / error / unavailable status from state_model",
    )


class DiagnosticsResponse(BaseModel):
    """Diagnostics response model for GET /api/v1/objects/{object_id}/diagnostics.

    Dev-only debug values for Person 3's diagnostics UI.
    """

    object_id: int = Field(..., description="Object identifier")
    raw_latest_row: dict | None = Field(
        default=None,
        description="Full raw orbital_elements row, or null if no data",
    )
    sgp4_error_code: int | None = Field(
        default=None,
        description="Direct SGP4 propagation error code (0 = success), or null",
    )
    staleness: StalenessInfo = Field(
        description="Staleness assessment: age_hours, threshold_hours, is_stale",
    )
    ingestion_history: list[IngestionHistoryItem] = Field(
        default_factory=list,
        description="All historical orbital_elements rows, oldest to newest",
    )
    ingestion_row_count: int = Field(
        default=0,
        description="Total number of rows in ingestion_history",
    )


class StalenessInfo(BaseModel):
    """Staleness assessment details."""

    age_hours: float = Field(..., description="Age of latest data in hours")
    threshold_hours: int = Field(
        default=24,
        description="Staleness threshold in hours (default 24)",
    )
    is_stale: bool = Field(..., description="True if age_hours > threshold_hours")


class IngestionHistoryItem(BaseModel):
    """One entry in the ingestion history list."""

    element_id: int = Field(..., description="Primary key of orbital_elements row")
    source_id: int = Field(..., description="Source identifier")
    epoch: str = Field(..., description="Epoch timestamp as ISO string")
    fetched_at: str = Field(..., description="When the row was fetched, ISO format")


class MediaResponse(BaseModel):
    """Response model for GET /api/v1/objects/{object_id}/media.

    Single-object media listing.
    """

    object_id: int = Field(..., description="Object identifier")
    media: list[MediaResponseItem] = Field(
        default_factory=list,
        description="Media attachments for this object",
    )


class ErrorResponse(BaseModel):
    """Standardized error response model.

    Used across all endpoints for consistent error shapes.
    FastAPI HTTPException uses {"detail": "..."} convention — this model
    documents the shape for typed clients.
    """

    detail: str = Field(..., description="Human-readable error description")


# -------------------------------------------------------------------------
# Helper: build ObjectDetails from database row data
# -------------------------------------------------------------------------


def build_object_details_from_row(
    object_id: int,
    name: str,
    category_id: int,
    category: Optional[str],
    norad_id: int | None,
    resolved_metadata: dict[str, str],
    media_rows: list[dict],
) -> ObjectDetails:
    """Construct an ObjectDetails Pydantic model from raw DB row data.

    This keeps the model construction logic in one place and avoids
    duplicating the dict-assembly pattern that exists in main.py.

    Args:
        object_id: The object primary key.
        name: Object name string.
        category_id: Category integer ID.
        category: Category name string (may be None if LEFT JOIN produces no match).
        norad_id: NORAD ID integer or None.
        resolved_metadata: Dict of field_name -> field_value from resolved_metadata table.
        media_rows: List of dicts from media table with url, media_type, source_id.

    Returns:
        Validated ObjectDetails instance.
    """

    media_items = [
        MediaResponseItem(
            url=row.get("url", ""),
            media_type=row.get("media_type", "image"),
            source_id=row.get("source_id"),
        )
        for row in media_rows
    ]

    return ObjectDetails(
        object_id=object_id,
        name=name,
        category_id=category_id,
        category=category,
        norad_id=norad_id,
        metadata=resolved_metadata,
        media=media_items,
    )