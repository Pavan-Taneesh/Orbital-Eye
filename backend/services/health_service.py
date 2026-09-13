"""Health service layer.

Application-level orchestration for health checks.
Shared between FastAPI routes and CLI commands.
"""

from __future__ import annotations

from typing import Any, Dict


def health_service() -> Dict[str, str]:
    """Return API health status.

    Returns:
        Dict with health status.
    """
    return {"status": "ok", "detail": "API is healthy"}