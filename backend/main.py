"""
FastAPI app entrypoint (P2-M9).
Run with: python -m uvicorn main:app --reload --port 8000
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent / "logic"))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from schemas import (
    DiagnosticsResponse,
    HealthResponse,
    MediaResponse,
    ObjectDetails,
    PaginatedResponse,
    StateResponse,
)

app = FastAPI(title="Space-website API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from services import diagnostics_service, health_service, state_service


class AIExploreRequest(BaseModel):
    request: str


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
    return health_service()


# ---------------------------------------------------------------------------
# Object search / listing
# ---------------------------------------------------------------------------

@app.get("/api/v1/objects/search", response_model=PaginatedResponse)
def search_objects(
    q: str = "",
    category: int = None,
    limit: int = 20,
    offset: int = 0,
):
    """GET /api/v1/objects/search

    Application-level orchestration delegated to
    object_service.search_objects.

    Args:
        q: Case-insensitive match against object name
        category: Optional filter by category_id (1-7)
        limit: Max 100 results per page (default 20)
        offset: Pagination offset (default 0)

    Returns:
        PaginatedResponse with ObjectSummary results
    """
    from services import search_objects as _search

    data = _search(
        q=q,
        category=category,
        limit=limit,
        offset=offset,
    )
    return data


@app.get("/api/v1/objects", response_model=PaginatedResponse)
def list_objects(
    category: int = None,
    limit: int = 20,
    offset: int = 0,
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
    from services import list_objects as _list

    data = _list(
        category=category,
        limit=limit,
        offset=offset,
    )
    return data


# ---------------------------------------------------------------------------
# Object detail
# ---------------------------------------------------------------------------

@app.get("/api/v1/objects/{object_id}", response_model=ObjectDetails)
def get_object(object_id: int):
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
    from services import get_object as _get_obj

    try:
        data = _get_obj(object_id=object_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    return data


# ---------------------------------------------------------------------------
# Orbital state
# ---------------------------------------------------------------------------

@app.get(
    "/api/v1/objects/{object_id}/state",
    response_model=StateResponse,
)
def get_object_state(object_id: int):
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
    data = state_service(object_id=object_id)
    return data


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

@app.get(
    "/api/v1/objects/{object_id}/diagnostics",
    response_model=DiagnosticsResponse,
)
def get_object_diagnostics(object_id: int):
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
    data = diagnostics_service(object_id=object_id)
    return data


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

@app.get(
    "/api/v1/objects/{object_id}/media",
    response_model=MediaResponse,
)
def get_object_media(object_id: int):
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
    from services import get_object_media as _get_media

    try:
        data = _get_media(object_id=object_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        ) from exc

    return data


# ---------------------------------------------------------------------------
# AI Exploration
# ---------------------------------------------------------------------------

@app.post("/api/v1/ai/explore", response_model=AIExploreResponse)
def ai_explore(req: AIExploreRequest):
    """POST /api/v1/ai/explore

    Accepts a natural language request and processes it through the AI
    exploration pipeline (AI provider → validation → command execution).

    Args:
        req: AIExploreRequest with natural language "request" field

    Returns:
        AIExploreResponse with command execution result
    """
    from ai_exploration import AIExplorationService, make_service
    from command_system import AICommandBridge, CommandExecutor
    from client import APIClient

    # Use fake provider by default; can be overridden via env var
    import os
    provider_name = os.getenv("AI_PROVIDER", "fake")
    ai_service = make_service(provider_name)

    base_url = os.getenv("API_BASE_URL", "http://localhost:8000")
    api_client = APIClient(base_url=base_url)
    executor = CommandExecutor(api_client=api_client)
    bridge = AICommandBridge(executor=executor)
    service = AIExplorationService(ai_service=ai_service, command_bridge=bridge)

    result = service.explore(req.request)

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