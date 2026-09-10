"""
FastAPI app entrypoint (P2-M9).
Run with: python -m uvicorn main:app --reload --port 8000
"""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent / "logic"))

from fastapi import FastAPI, HTTPException
import psycopg2

from state_model import get_state
from diagnostics import get_diagnostics

app = FastAPI(title="Space-website API", version="0.1.0")

from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def connect():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        dbname=os.getenv("DB_NAME", "project_db"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", ""),
    )


@app.get("/api/v1/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/v1/objects/search")
def search_objects(q: str = "", category: int = None, limit: int = 20, offset: int = 0):
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    conn = connect()
    cur = conn.cursor()

    base_where = "WHERE o.name ILIKE %s"
    params = [f"%{q}%"]
    if category is not None:
        base_where += " AND o.category_id = %s"
        params.append(category)

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


@app.get("/api/v1/objects")
def list_objects(category: int = None, limit: int = 20, offset: int = 0):
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    conn = connect()
    cur = conn.cursor()

    base_where = ""
    params = []
    if category is not None:
        base_where = "WHERE category_id = %s"
        params.append(category)

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


@app.get("/api/v1/objects/{object_id}")
def get_object(object_id: int):
    if object_id < 1:
        raise HTTPException(status_code=400, detail="object_id must be positive")
    conn = connect()
    ...
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
    media = [{"url": u, "media_type": mt, "source_id": sid} for u, mt, sid in cur.fetchall()]

    cur.close()
    conn.close()

    return {
        "object_id": obj_id,
        "name": name,
        "category": category,
        "norad_id": norad_id,
        "metadata": metadata,
        "media": media,
    }


@app.get("/api/v1/objects/{object_id}/state")
def get_object_state(object_id: int):
    state = get_state(object_id)
    if state["status"] == "unavailable":
        raise HTTPException(status_code=404, detail="no orbital data for this object")
    return state


@app.get("/api/v1/objects/{object_id}/diagnostics")
def get_object_diagnostics(object_id: int):
    diag = get_diagnostics(object_id)
    if diag["raw_latest_row"] is None:
        raise HTTPException(status_code=404, detail="no orbital data for this object")
    return diag
