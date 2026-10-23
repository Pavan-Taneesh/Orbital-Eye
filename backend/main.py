"""
FastAPI app entrypoint (P2-M9).
Run with: python -m uvicorn main:app --reload --port 8000
"""

import os
import sys
from pathlib import Path
from typing import Any

import psycopg2
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent / "logic"))

# Repo root, so the `backend` package (used by the AI pipeline) is importable
# when the server is started from inside backend/.
_REPO_ROOT = str(Path(__file__).resolve().parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.append(_REPO_ROOT)

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi import Path as PathParam
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from rate_limit import SlidingWindowRateLimiter
from schemas import (
    BulkStateResponse,
    DiagnosticsResponse,
    HealthResponse,
    MediaResponse,
    ObjectDetails,
    PaginatedResponse,
    StateResponse,
)
from services.catalog_service import CatalogUnavailableError, get_catalog_snapshot
from services.diagnostics_service import diagnostics_service as diagnostics_service_svc
from services.health_service import health_service as health_service_svc
from services.object_service import get_object as get_object_svc
from services.object_service import get_object_media as get_object_media_svc
from services.object_service import list_objects as list_objects_svc
from services.state_service import bulk_state_service as bulk_state_service_svc
from services.state_service import state_service as state_service_svc


app = FastAPI(title="Space-website API", version="0.1.0")

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    # If-None-Match lets the browser revalidate the cached catalog (304, no body).
    allow_headers=["Content-Type", "Accept", "If-None-Match"],
    expose_headers=["ETag"],
)


DETAIL_CACHE_CONTROL = "public, max-age=3600"
CATALOG_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400"

# Shared parameter bounds
MAX_OBJECT_ID = 2**31 - 1  # Postgres INTEGER upper bound
ObjectIdParam = PathParam(..., ge=1, le=MAX_OBJECT_ID)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


# Per-IP sliding-window limiter for the AI endpoint (0 disables it).
ai_rate_limiter = SlidingWindowRateLimiter(
    limit=_env_int("AI_RATE_LIMIT_PER_MIN", 10),
    window_seconds=60.0,
)


def connect():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


class AIExploreRequest(BaseModel):
    request: str = Field(..., min_length=1, max_length=500)


class AIExploreResponse(BaseModel):
    success: bool
    command: str | None = None
    result: dict | None = None
    ai_response: str | None = None
    error: str | None = None
    error_type: str | None = None
    latency_ms: float = 0.0
    tokens_used: dict = {}


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/v1/health", response_model=HealthResponse)
def health_check():
    """GET /api/v1/health

    Returns:
        HealthResponse with status "ok"
    """
    return health_service_svc()


# ---------------------------------------------------------------------------
# Catalog (single cached snapshot of all on-orbit objects)
# ---------------------------------------------------------------------------

def _etag_candidates(if_none_match: str | None) -> set[str]:
    if not if_none_match:
        return set()

    return {
        c.strip().removeprefix("W/").strip().strip('"')
        for c in if_none_match.split(",")
    }


def _accepts_gzip(accept_encoding: str | None) -> bool:
    """True if Accept-Encoding allows gzip (q=0 means refused; * counts)."""
    if not accept_encoding:
        return False

    star: float | None = None

    for part in accept_encoding.split(","):
        coding, _, params = part.strip().partition(";")
        q = 1.0

        for p in params.split(";"):
            k, _, v = p.strip().partition("=")

            if k.strip().lower() == "q":
                try:
                    q = float(v)
                except ValueError:
                    q = 0.0

        coding = coding.strip().lower()

        if coding in ("gzip", "x-gzip"):
            return q > 0

        if coding == "*":
            star = q

    return bool(star and star > 0)


@app.get("/api/v1/catalog")
def get_catalog(request: Request):
    """GET /api/v1/catalog

    Every on-orbit object with its latest SGP4 mean elements and SATCAT
    metadata (shape: frontend/src/engine/contract.ts CatalogResponseWire).
    Served from an in-process cache, pre-gzipped once per snapshot. ETags are
    per representation ("<v>" identity, "<v>-gz" gzip); If-None-Match matching
    either yields 304.
    """
    try:
        snap = get_catalog_snapshot()
    except CatalogUnavailableError:
        return JSONResponse(
            status_code=503,
            content={"detail": "catalog temporarily unavailable"},
            headers={"Retry-After": "10", "Cache-Control": "no-store"},
        )

    gz = _accepts_gzip(request.headers.get("accept-encoding"))
    etag = f"{snap.version}-gz" if gz else snap.version

    headers = {
        "ETag": f'"{etag}"',
        "Cache-Control": CATALOG_CACHE_CONTROL,
        "Vary": "Accept-Encoding",
    }

    inm = request.headers.get("if-none-match")

    if inm is not None and (
        inm.strip() == "*"
        or _etag_candidates(inm) & {snap.version, f"{snap.version}-gz"}
    ):
        return Response(status_code=304, headers=headers)

    if gz:
        headers["Content-Encoding"] = "gzip"
        return Response(
            content=snap.gz_body,
            media_type="application/json",
            headers=headers,
        )

    # Explicit identity stops GZipMiddleware (which ignores q-values) from
    # re-compressing for clients that refused gzip.
    headers["Content-Encoding"] = "identity"

    return Response(
        content=snap.body,
        media_type="application/json",
        headers=headers,
    )


# ---------------------------------------------------------------------------
# Object search / listing
# ---------------------------------------------------------------------------

@app.get("/api/v1/objects/search")
def search_objects(
    q: str = Query("", max_length=100),
    category: int | None = None,
    object_type: str | None = None,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100_000),
):
    """Search objects by name, category, or object type."""
    conn = connect()
    cur = conn.cursor()

    try:
        base_where = "WHERE o.name ILIKE %s"
        params: list[Any] = [f"%{q}%"]

        if category is not None:
            base_where += " AND o.category_id = %s"
            params.append(category)

        if object_type is not None:
            base_where += " AND o.object_type = %s"
            params.append(object_type)

        cur.execute(
            f"SELECT COUNT(*) FROM objects o {base_where};",
            params,
        )
        total_count = cur.fetchone()[0]

        query = f"""
            SELECT o.object_id, o.name, o.norad_id, o.category_id, o.object_type
            FROM objects o
            {base_where}
            ORDER BY o.object_id
            LIMIT %s OFFSET %s;
        """

        cur.execute(query, params + [limit, offset])
        rows = cur.fetchall()

    finally:
        cur.close()
        conn.close()

    results = [
        {
            "object_id": r[0],
            "name": r[1],
            "norad_id": r[2],
            "category_id": r[3],
            "object_type": r[4],
        }
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


@app.get("/api/v1/objects", response_model=PaginatedResponse)
def list_objects(
    category: int | None = None,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0, le=100_000),
):
    """GET /api/v1/objects

    Application-level orchestration delegated to
    object_service.list_objects.

    Args:
        category: Optional filter by category_id (1-7)
        limit: Max 100 results per page (default 20)
        offset: Pagination offset (default 0)

    Returns:
        PaginatedResponse with ObjectSummary results
    """
    return list_objects_svc(
        category=category,
        limit=limit,
        offset=offset,
    )


# ---------------------------------------------------------------------------
# Bulk orbital state (must come before /objects/{object_id})
# ---------------------------------------------------------------------------

@app.get(
    "/api/v1/objects/states",
    response_model=BulkStateResponse,
)
def get_bulk_states(
    category: int | None = None,
    limit: int = Query(250, ge=1, le=250),
    offset: int = Query(0, ge=0, le=100_000),
):
    """GET /api/v1/objects/states

    Bulk orbital state retrieval for a category.

    Args:
        category: Optional filter by category_id (1-7)
        limit: Max 250 results per page (default: 250)
        offset: Pagination offset (default: 0)

    Returns:
        BulkStateResponse with StateResponse results
    """
    return bulk_state_service_svc(
        category=category,
        limit=limit,
        offset=offset,
    )


# ---------------------------------------------------------------------------
# Object detail
# ---------------------------------------------------------------------------

@app.get("/api/v1/objects/{object_id}", response_model=ObjectDetails)
def get_object(response: Response, object_id: int = ObjectIdParam):
    """GET /api/v1/objects/{object_id}

    Application-level orchestration delegated to
    object_service.get_object.

    Args:
        object_id: Positive object identifier

    Returns:
        ObjectDetails with full object information

    Raises:
        HTTPException 400: If object_id is not positive
        HTTPException 404: If object not found
    """
    try:
        result = get_object_svc(object_id=object_id)
        response.headers["Cache-Control"] = DETAIL_CACHE_CONTROL
        return result
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc


# ---------------------------------------------------------------------------
# Orbital state
# ---------------------------------------------------------------------------

@app.get(
    "/api/v1/objects/{object_id}/state",
    response_model=StateResponse,
)
def get_object_state(object_id: int = ObjectIdParam):
    """GET /api/v1/objects/{object_id}/state

    Application-level orchestration delegated to
    state_service.state_service.

    Args:
        object_id: Positive object identifier

    Returns:
        StateResponse with orbital state (Contract C)

    Raises:
        HTTPException 404: If no orbital data for this object
    """
    try:
        return state_service_svc(object_id=object_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

@app.get(
    "/api/v1/objects/{object_id}/diagnostics",
    response_model=DiagnosticsResponse,
)
def get_object_diagnostics(object_id: int = ObjectIdParam):
    """GET /api/v1/objects/{object_id}/diagnostics

    Application-level orchestration delegated to
    diagnostics_service.diagnostics_service.

    Args:
        object_id: Positive object identifier

    Returns:
        DiagnosticsResponse with dev-only debug values

    Raises:
        HTTPException 404: If no orbital data for this object
    """
    try:
        return diagnostics_service_svc(object_id=object_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

@app.get(
    "/api/v1/objects/{object_id}/media",
    response_model=MediaResponse,
)
def get_object_media(response: Response, object_id: int = ObjectIdParam):
    """GET /api/v1/objects/{object_id}/media

    Application-level orchestration delegated to
    object_service.get_object_media.

    Args:
        object_id: Positive object identifier

    Returns:
        MediaResponse with media attachments for the object

    Raises:
        HTTPException 400: If object_id is not positive
    """
    try:
        result = get_object_media_svc(object_id=object_id)
        response.headers["Cache-Control"] = DETAIL_CACHE_CONTROL
        return result
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc


# ---------------------------------------------------------------------------
# AI Exploration
# ---------------------------------------------------------------------------

def _run_exploration(text: str):
    """Build the AI exploration pipeline for one request and run it.

    The API client is closed when the request finishes.
    """
    # The AI pipeline is written as the `backend` package (relative and
    # `backend.*` imports), so load it through that package, never via the
    # top-level module names, or its classes would be duplicated.
    from backend.ai_exploration import AIExplorationService, make_service
    from backend.client import APIClient
    from backend.command_system import AICommandBridge, CommandExecutor

    # Use fake provider by default; can be overridden via env var
    provider_name = os.getenv("AI_PROVIDER", "fake")
    ai_service = make_service(provider_name)

    base_url = os.getenv("API_BASE_URL", "http://localhost:8000")

    with APIClient(base_url=base_url) as api_client:
        executor = CommandExecutor(api_client=api_client)
        bridge = AICommandBridge(executor=executor)
        service = AIExplorationService(
            ai_service=ai_service,
            command_bridge=bridge,
        )
        return service.explore(text)


@app.post("/api/v1/ai/explore", response_model=AIExploreResponse)
def ai_explore(req: AIExploreRequest, request: Request):
    """POST /api/v1/ai/explore

    Accepts a natural language request and processes it through the AI
    exploration pipeline (AI provider → validation → command execution).
    Rate-limited per client IP (AI_RATE_LIMIT_PER_MIN, default 10/min).

    Args:
        req: AIExploreRequest with natural language "request" field

    Returns:
        AIExploreResponse with command execution result

    Raises:
        HTTPException 429: If the client exceeded the rate limit
    """
    client_ip = request.client.host if request.client else "unknown"
    allowed, retry_after = ai_rate_limiter.hit(client_ip)

    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many AI requests. Please slow down.",
            headers={"Retry-After": str(retry_after)},
        )

    result = _run_exploration(req.request)

    return AIExploreResponse(
        success=result.success,
        command=result.command,
        result=result.result,
        ai_response=result.ai_response,
        error=result.error,
        error_type=result.error_type,
        latency_ms=result.latency_ms,
        tokens_used=result.tokens_used,
    )