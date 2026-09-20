"""Typed API client for the Space-website frozen API contract.

This client consumes the frozen API contract defined in schemas.py and
provides strongly-typed methods for all endpoints. No authentication or
rate limiting is included (both deferred per the contract freeze).

Typical usage:

    client = APIClient(base_url="http://localhost:8000")
    response = client.health()
    objects = client.search(q="ISS", limit=10)
"""

from __future__ import annotations

from typing import Any

import httpx

from .schemas import (
    DiagnosticsResponse,
    HealthResponse,
    MediaResponse,
    ObjectDetails,
    PaginatedResponse,
    StateResponse,
)


class APIClient:
    """Typed HTTP client for the Space-website API.

    Args:
        base_url: Base URL for the API (e.g. "http://localhost:8000")
        timeout: Request timeout in seconds (default 30)
    """

    def __init__(self, base_url: str = "http://localhost:8000", timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._client = httpx.Client(timeout=timeout)

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json: Any | None = None,
    ) -> httpx.Response:
        """Make an HTTP request and return the raw response."""
        url = f"{self.base_url}{path}"
        return self._client.request(method, url, params=params, json=json)

    def _handle_response(self, response: httpx.Response) -> Any:
        """Handle the HTTP response, raising on 4xx/5xx and parsing JSON.

        Uses the frozen error convention (FastAPI {"detail": "..."} shape).
        """
        if response.is_error:
            try:
                error_data = response.json()
            except ValueError:
                error_data = {"detail": response.text}
            raise APIError(
                status_code=response.status_code,
                detail=error_data.get("detail", response.text),
                response=error_data,
            )
        return response.json()

    # -----------------------------------------------------------------
    # Health
    # -----------------------------------------------------------------

    def health(self) -> HealthResponse:
        """GET /api/v1/health

        Returns:
            HealthResponse with status "ok"
        """
        data = self._request("GET", "/api/v1/health")
        return self._handle_response_data(HealthResponse, data)

    # -----------------------------------------------------------------
    # Search
    # -----------------------------------------------------------------

    def search(self, q: str = "", category: int | None = None, limit: int = 20, offset: int = 0) -> PaginatedResponse:
        """GET /api/v1/objects/search

        Args:
            q: Case-insensitive match against object name
            category: Optional filter by category_id (1-7)
            limit: Max 100 results per page (default 20)
            offset: Pagination offset (default 0)

        Returns:
            PaginatedResponse with ObjectSummary results
        """
        params = {
            "q": q,
            "category": category,
            "limit": limit,
            "offset": offset,
        }
        data = self._request("GET", "/api/v1/objects/search", params=params)
        return self._handle_response_data(PaginatedResponse, data)

    # -----------------------------------------------------------------
    # List
    # -----------------------------------------------------------------

    def list(self, category: int | None = None, limit: int = 20, offset: int = 0) -> PaginatedResponse:
        """GET /api/v1/objects

        Args:
            category: Optional filter by category_id (1-7)
            limit: Max 100 results per page (default 20)
            offset: Pagination offset (default 0)

        Returns:
            PaginatedResponse with ObjectSummary results
        """
        params = {
            "category": category,
            "limit": limit,
            "offset": offset,
        }
        data = self._request("GET", "/api/v1/objects", params=params)
        return self._handle_response_data(PaginatedResponse, data)

    # -----------------------------------------------------------------
    # Object detail
    # -----------------------------------------------------------------

    def get(self, object_id: int) -> ObjectDetails:
        """GET /api/v1/objects/{object_id}

        Args:
            object_id: Positive object identifier

        Returns:
            ObjectDetails with full object information
        """
        path = f"/api/v1/objects/{object_id}"
        data = self._request("GET", path)
        return self._handle_response_data(ObjectDetails, data)

    # -----------------------------------------------------------------
    # Orbital state
    # -----------------------------------------------------------------

    def state(self, object_id: int) -> StateResponse:
        """GET /api/v1/objects/{object_id}/state

        Args:
            object_id: Positive object identifier

        Returns:
            StateResponse with orbital state (Contract C)
        """
        path = f"/api/v1/objects/{object_id}/state"
        data = self._request("GET", path)
        return self._handle_response_data(StateResponse, data)

    # -----------------------------------------------------------------
    # Diagnostics
    # -----------------------------------------------------------------

    def diagnostics(self, object_id: int) -> DiagnosticsResponse:
        """GET /api/v1/objects/{object_id}/diagnostics

        Args:
            object_id: Positive object identifier

        Returns:
            DiagnosticsResponse with dev-only debug values
        """
        path = f"/api/v1/objects/{object_id}/diagnostics"
        data = self._request("GET", path)
        return self._handle_response_data(DiagnosticsResponse, data)

    # -----------------------------------------------------------------
    # Media
    # -----------------------------------------------------------------

    def media(self, object_id: int) -> MediaResponse:
        """GET /api/v1/objects/{object_id}/media

        Args:
            object_id: Positive object identifier

        Returns:
            MediaResponse with media attachments for the object
        """
        path = f"/api/v1/objects/{object_id}/media"
        data = self._request("GET", path)
        return self._handle_response_data(MediaResponse, data)

    # -----------------------------------------------------------------
    # Private: deserialize response data into a Pydantic model
    # -----------------------------------------------------------------

    def _handle_response_data(self, model: type, data: dict) -> Any:
        """Validate raw JSON data into a Pydantic model instance.

        Args:
            model: Pydantic BaseModel subclass
            data: Raw JSON dict from the API

        Returns:
            Validated model instance

        Raises:
            APIError: If the HTTP response was an error (handled by
                      _handle_response already, so this should not raise
                      for validation errors unless the data is truly
                      malformed).
        """
        # FastAPI may return extra fields; Pydantic v2 default is to ignore
        # extra fields, but we explicitly allow it here.
        return model.model_validate(data)


class APIError(Exception):
    """Raised when the API returns a non-2xx status code."""

    def __init__(
        self,
        status_code: int,
        detail: str,
        response: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.detail = detail
        self.response = response
        super().__init__(f"API request failed [{status_code}]: {detail}")

    def __str__(self) -> str:
        return f"APIError {self.status_code}: {self.detail}"


# ---------------------------------------------------------------------------
# Convenience: close the underlying HTTP client
# ---------------------------------------------------------------------------

def close_client(client: APIClient) -> None:
    """Close the underlying httpx.Client.

    Should be called when the client is no longer needed, e.g. at the
    end of a script or program.
    """
    client._client.close()