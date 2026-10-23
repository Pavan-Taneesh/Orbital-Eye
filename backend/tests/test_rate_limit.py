"""Tests for the in-memory AI rate limiter and its wiring in main.py."""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from rate_limit import SlidingWindowRateLimiter


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_allows_up_to_limit_then_blocks_with_retry_after():
    clock = FakeClock()
    limiter = SlidingWindowRateLimiter(limit=3, window_seconds=60, clock=clock)

    assert [limiter.hit("1.2.3.4")[0] for _ in range(3)] == [True, True, True]
    allowed, retry_after = limiter.hit("1.2.3.4")
    assert allowed is False
    assert retry_after == 60

    clock.now += 45
    allowed, retry_after = limiter.hit("1.2.3.4")
    assert allowed is False
    assert retry_after == 15


def test_window_slides_and_keys_are_independent():
    clock = FakeClock()
    limiter = SlidingWindowRateLimiter(limit=1, window_seconds=60, clock=clock)

    assert limiter.hit("a")[0] is True
    assert limiter.hit("a")[0] is False
    assert limiter.hit("b")[0] is True  # other IP unaffected

    clock.now += 60.1
    assert limiter.hit("a")[0] is True


def test_zero_limit_disables_limiting():
    limiter = SlidingWindowRateLimiter(limit=0)
    assert all(limiter.hit("x")[0] for _ in range(100))


def test_thread_safety_never_exceeds_limit():
    limiter = SlidingWindowRateLimiter(limit=50, window_seconds=60)
    results: list[bool] = []
    lock = threading.Lock()

    def worker() -> None:
        for _ in range(20):
            ok, _ = limiter.hit("same-ip")
            with lock:
                results.append(ok)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sum(results) == 50


def test_idle_keys_are_swept():
    clock = FakeClock()
    limiter = SlidingWindowRateLimiter(limit=5, window_seconds=10, clock=clock, max_keys=3)
    for ip in ("a", "b", "c"):
        limiter.hit(ip)
    clock.now += 11
    limiter.hit("d")
    assert set(limiter._hits) == {"d"}


@pytest.fixture
def api(monkeypatch):
    fastapi_testclient = pytest.importorskip("fastapi.testclient")
    # main.py calls load_dotenv() on import; keep the local .env (API keys)
    # out of os.environ so other tests' "missing credentials" paths still hold.
    monkeypatch.setattr("dotenv.load_dotenv", lambda *args, **kwargs: False)
    try:
        import main
    except ImportError as exc:  # pragma: no cover - environment-dependent import
        pytest.skip(f"main.py not importable here: {exc}")

    stub = SimpleNamespace(
        success=True,
        command="find_object",
        result={"ok": True},
        ai_response=None,
        error=None,
        error_type=None,
        latency_ms=1.0,
        tokens_used={},
    )
    monkeypatch.setattr(main, "_run_exploration", lambda text: stub)
    monkeypatch.setattr(main, "ai_rate_limiter", SlidingWindowRateLimiter(limit=2, window_seconds=60))
    return fastapi_testclient.TestClient(main.app)


def test_ai_explore_returns_429_with_retry_after(api):
    body = {"request": "take me to the ISS"}
    assert api.post("/api/v1/ai/explore", json=body).status_code == 200
    assert api.post("/api/v1/ai/explore", json=body).status_code == 200

    resp = api.post("/api/v1/ai/explore", json=body)
    assert resp.status_code == 429
    assert int(resp.headers["Retry-After"]) >= 1


@pytest.mark.parametrize("text", ["", "x" * 501])
def test_ai_explore_rejects_bad_request_length(api, text):
    assert api.post("/api/v1/ai/explore", json={"request": text}).status_code == 422


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/objects/0",
        f"/api/v1/objects/{2**31}/state",
        "/api/v1/objects?limit=101",
        "/api/v1/objects?offset=-1",
        "/api/v1/objects/search?q=" + "a" * 101,
    ],
)
def test_param_bounds_rejected_before_db(api, path):
    assert api.get(path).status_code == 422
