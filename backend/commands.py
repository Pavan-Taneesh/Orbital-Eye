"""Application command layer (Person 3).

Minimal reusable command functions that wrap existing backend services
rather than reimplementing scientific logic. Designed for application-level
orchestration, not ingestion (that's run_all.py's role).

Typical usage:
    from backend.commands import state_command, diagnose_command
    result = state_command(object_id=1)
"""

from __future__ import annotations

import sys
from typing import Any


def _setup_paths():
    """Set up import paths for logic and services modules."""
    import os
    import sys as _sys
    # Add backend/ directory
    _sys.path.insert(0, os.path.dirname(__file__))
    # Add backend/logic/ directory
    _sys.path.insert(0, os.path.join(os.path.dirname(__file__), "logic"))
    # Add backend/services/ directory
    _sys.path.insert(0, os.path.join(os.path.dirname(__file__), "services"))


# ---------------------------------------------------------------------------
# Command: state
# ---------------------------------------------------------------------------

def state_command(object_id: int, when: Any | None = None) -> dict[str, Any]:
    """Get orbital state for an object as a command-side operation.

    Wraps backend.services.state_service into a command-style interface
    with predictable success/failure behavior.

    Args:
        object_id: Positive object identifier
        when: UTC datetime for state evaluation (defaults to now)

    Returns:
        Dict with orbital state information including status key.
        Status is one of: "fresh", "stale", "error", "unavailable".

    Raises:
        ValueError: If object_id is not a positive integer
    """
    _setup_paths()

    if not isinstance(object_id, int) or object_id < 1:
        raise ValueError(f"object_id must be a positive integer, got {object_id}")

    from backend.services.state_service import state_service as _state_service

    state = _state_service(object_id=object_id, when=when)
    return {
        "object_id": state["object_id"],
        "position": state["position"],
        "velocity": state["velocity"],
        "altitude": state["altitude"],
        "epoch": state["epoch"],
        "frame": state["frame"],
        "source": state["source"],
        "age_hours": state["age_hours"],
        "status": state["status"],
    }


# ---------------------------------------------------------------------------
# Command: diagnostics
# ---------------------------------------------------------------------------

def diagnose_command(object_id: int) -> dict[str, Any]:
    """Get diagnostics for an object as a command-side operation.

    Wraps backend.services.diagnostics_service into a command-style interface
    with predictable success/failure behavior.

    Args:
        object_id: Positive object identifier

    Returns:
        Dict with diagnostics information including status key.
        Status is one of: "ok", "error", or missing data indicators.

    Raises:
        ValueError: If object_id is not a positive integer
    """
    _setup_paths()

    if not isinstance(object_id, int) or object_id < 1:
        raise ValueError(f"object_id must be a positive integer, got {object_id}")

    from backend.services.diagnostics_service import (
        diagnostics_service as _diag_service,
    )

    diag = _diag_service(object_id=object_id)
    return {
        "object_id": diag["object_id"],
        "raw_latest_row": diag["raw_latest_row"],
        "sgp4_error_code": diag["sgp4_error_code"],
        "staleness": diag["staleness"],
        "ingestion_history": diag["ingestion_history"],
        "ingestion_row_count": diag["ingestion_row_count"],
    }


# ---------------------------------------------------------------------------
# Command: health
# ---------------------------------------------------------------------------

def health_command() -> dict[str, str]:
    """Return API health status as a command-side operation.

    Returns:
        Dict with health status
    """
    _setup_paths()

    from backend.services.health_service import health_service as _health_service

    return _health_service()


# ---------------------------------------------------------------------------
# Convenience: orchestration integration
# ---------------------------------------------------------------------------

def ingest_run() -> dict[str, Any]:
    """Invoke the existing ingestion orchestration.

    Runs the Person 2 ingestion scripts through the orchestration boundary.
    Does NOT duplicate ingestion logic — it invokes the existing scripts.

    Returns:
        Dict with execution results for each script
    """
    import os
    import subprocess

    scripts = [
        "ingestion/celestrak.py",
        "ingestion/satnogs.py",
        "ingestion/spacetrack.py",
        "ingestion/discos.py",
    ]

    results = []
    for script in scripts:
        script_path = os.path.join(os.path.dirname(__file__), script)
        result = subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
        )
        results.append({
            "script": script,
            "exit_code": result.returncode,
            "stdout": result.stdout[:500] if result.stdout else "",
            "stderr": result.stderr[:500] if result.stderr else "",
        })

    return {"scripts": results, "overall_exit_code": max((r["exit_code"] for r in results), default=0)}


# ---------------------------------------------------------------------------
# Convenience: CLI entry point
# ---------------------------------------------------------------------------

def main() -> int:
    """Minimal CLI entry point for the command layer.

    Supported subcommands:
        state <object_id>
        diagnose <object_id>
        health
        ingest

    Returns:
        Exit code (0 for success, 1 for usage error, 2 for command failure)
    """
    if len(sys.argv) < 2:
        print("Usage: python -m backend.commands <command> [args...]")
        print("Commands: state, diagnose, health, ingest")
        return 1

    command = sys.argv[1]

    try:
        if command == "state":
            if len(sys.argv) < 3:
                print("Error: state command requires object_id argument")
                print("Usage: python -m backend.commands state <object_id>")
                return 1
            try:
                object_id = int(sys.argv[2])
            except ValueError:
                print(f"Error: object_id must be an integer, got '{sys.argv[2]}'")
                return 1
            result = state_command(object_id)
            print(result)
            return 0

        elif command == "diagnose":
            if len(sys.argv) < 3:
                print("Error: diagnose command requires object_id argument")
                print("Usage: python -m backend.commands diagnose <object_id>")
                return 1
            try:
                object_id = int(sys.argv[2])
            except ValueError:
                print(f"Error: object_id must be an integer, got '{sys.argv[2]}'")
                return 1
            result = diagnose_command(object_id)
            print(result)
            return 0

        elif command == "health":
            result = health_command()
            print(result)
            return 0

        elif command == "ingest":
            result = ingest_run()
            for r in result["scripts"]:
                status = "SUCCESS" if r["exit_code"] == 0 else "FAILED"
                print(f"{r['script']}: {status}")
                if r["stderr"]:
                    print(f"  stderr: {r['stderr'][:200]}")
            return result["overall_exit_code"]

        else:
            print(f"Unknown command: {command}")
            print("Commands: state, diagnose, health, ingest")
            return 1
    except ValueError as exc:
        print(f"Error: {exc}")
        print("Usage: python -m backend.commands <command> [args...]")
        print("Commands: state, diagnose, health, ingest")
        return 1
    except Exception as exc:
        print(f"Error: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())