"""Tests for GET /api/v1/catalog (shape, decay filter, ETag/304, gzip).

Uses the local PostgreSQL database (same as the rest of the API tests);
skipped when the DB or app is unavailable.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg2
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
LOGIC_DIR = BACKEND_DIR / "logic"
if str(LOGIC_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIC_DIR))

fastapi_testclient = pytest.importorskip("fastapi.testclient")

ENTRY_KEYS = {"id", "norad", "name", "cospar", "cat", "type", "owner", "launch", "site", "rcs", "omm"}
OMM_KEYS = {
    "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT",
}
TOP_KEYS = {"version", "generated_at", "total_objects", "decayed_objects", "objects"}


@pytest.fixture(scope="module")
def client():
    # main.py calls load_dotenv() on import; keep that from leaking API keys
    # into the process env, which would change other tests (e.g. AI provider
    # missing-credentials checks).
    env_before = dict(os.environ)
    try:
        import main
        from services import catalog_service
    except ImportError as exc:  # pragma: no cover - environment-dependent
        pytest.skip(f"main.py not importable here: {exc}")
    finally:
        for key in set(os.environ) - set(env_before):
            if key not in ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"):
                del os.environ[key]
    catalog_service.reset_cache()
    try:
        c = fastapi_testclient.TestClient(main.app)
        resp = c.get("/api/v1/catalog")
    except psycopg2.OperationalError as exc:  # DB unavailable
        pytest.skip(f"database unavailable: {exc}")
    if resp.status_code != 200:
        pytest.skip(f"catalog unavailable: {resp.status_code}")
    return c


def test_shape_matches_contract(client):
    body = client.get("/api/v1/catalog").json()
    assert set(body) == TOP_KEYS
    assert body["total_objects"] >= len(body["objects"])
    assert len(body["objects"]) > 0
    for e in body["objects"][:200]:
        assert set(e) == ENTRY_KEYS
        assert set(e["omm"]) == OMM_KEYS
        assert e["type"] in {"PAY", "R/B", "DEB", "UNK"}
        assert 1 <= e["cat"] <= 7
        assert isinstance(e["omm"]["MEAN_MOTION"], float)
        assert not e["omm"]["EPOCH"].endswith("Z") and "+" not in e["omm"]["EPOCH"]
        assert e["rcs"] is None or isinstance(e["rcs"], float)


def test_decayed_objects_excluded(client):
    from logic.state_model import connect

    body = client.get("/api/v1/catalog").json()
    ids = {e["id"] for e in body["objects"]}
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT object_id FROM resolved_metadata WHERE field_name = 'decay_date' AND field_value <> ''"
            )
            decayed = {r[0] for r in cur.fetchall()}
    finally:
        conn.close()
    assert ids.isdisjoint(decayed)
    assert body["decayed_objects"] == len(decayed)


def test_etag_and_304(client):
    ident = client.get("/api/v1/catalog", headers={"Accept-Encoding": "identity"})
    version = ident.json()["version"]
    etag = ident.headers["etag"]
    assert etag == f'"{version}"'
    assert ident.headers["cache-control"] == "public, max-age=300, stale-while-revalidate=86400"
    assert "accept-encoding" in ident.headers["vary"].lower()

    second = client.get("/api/v1/catalog", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""
    assert "etag" in second.headers

    weak = client.get("/api/v1/catalog", headers={"If-None-Match": f"W/{etag}"})
    assert weak.status_code == 304

    # A client that switches encodings still gets 304 with either form.
    gz_etag = f'"{version}-gz"'
    switched = client.get(
        "/api/v1/catalog", headers={"Accept-Encoding": "gzip", "If-None-Match": etag}
    )
    assert switched.status_code == 304
    assert client.get("/api/v1/catalog", headers={"If-None-Match": gz_etag}).status_code == 304

    stale = client.get("/api/v1/catalog", headers={"If-None-Match": '"nope"'})
    assert stale.status_code == 200


def test_gzip_is_precompressed_and_stable(client):
    from services import catalog_service

    snap = catalog_service.get_catalog_snapshot()
    a = client.get("/api/v1/catalog", headers={"Accept-Encoding": "gzip"})
    b = client.get("/api/v1/catalog", headers={"Accept-Encoding": "gzip, br;q=0.5"})
    assert a.headers["content-encoding"] == "gzip"
    assert a.headers["etag"] == f'"{snap.version}-gz"'
    # Stored bytes served verbatim (not re-compressed by middleware).
    assert int(a.headers["content-length"]) == len(snap.gz_body)
    assert a.headers["content-length"] == b.headers["content-length"]
    assert a.json() == b.json()

    plain = client.get("/api/v1/catalog", headers={"Accept-Encoding": "identity"})
    assert plain.headers.get("content-encoding", "identity") == "identity"
    assert int(plain.headers["content-length"]) == len(snap.body)
    assert plain.headers["etag"] == f'"{snap.version}"'
    refused = client.get("/api/v1/catalog", headers={"Accept-Encoding": "gzip;q=0"})
    assert refused.headers.get("content-encoding", "identity") == "identity"
    assert int(refused.headers["content-length"]) == len(snap.body)
    assert a.json() == plain.json()


def test_db_down_serves_stale_snapshot(client, monkeypatch):
    from services import catalog_service

    good = catalog_service.get_catalog_snapshot()

    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(catalog_service, "connect", boom)
    catalog_service._version_checked_at = 0.0  # force a version re-check
    resp = client.get("/api/v1/catalog", headers={"Accept-Encoding": "identity"})
    assert resp.status_code == 200
    assert resp.content == good.body
    # Backed off: next call does not retry connect immediately.
    assert catalog_service._version_checked_at > 0


def test_db_down_without_snapshot_is_503(client, monkeypatch):
    from services import catalog_service

    saved = catalog_service._snapshot
    catalog_service.reset_cache()
    monkeypatch.setattr(catalog_service, "connect", lambda: (_ for _ in ()).throw(RuntimeError("secret dsn")))
    try:
        resp = client.get("/api/v1/catalog")
        assert resp.status_code == 503
        assert resp.json() == {"detail": "catalog temporarily unavailable"}
        assert "secret" not in resp.text
    finally:
        catalog_service._snapshot = saved
        catalog_service._version_checked_at = 0.0


def test_to_float_rejects_non_finite():
    from services.catalog_service import _to_float

    assert _to_float("1.5") == 1.5
    for bad in ("nan", "inf", "-inf", float("nan"), float("inf"), "", None, "x"):
        assert _to_float(bad) is None


def test_object_detail_and_media_cache_headers(client):
    cat = client.get("/api/v1/catalog").json()
    oid = cat["objects"][0]["id"]
    detail = client.get(f"/api/v1/objects/{oid}")
    assert detail.status_code == 200
    assert detail.headers["cache-control"] == "public, max-age=3600"
    assert "metadata" in detail.json()
    media = client.get(f"/api/v1/objects/{oid}/media")
    assert media.status_code == 200
    assert media.headers["cache-control"] == "public, max-age=3600"
