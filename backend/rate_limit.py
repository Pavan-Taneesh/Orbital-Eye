"""Small thread-safe, in-memory sliding-window rate limiter.

Used to protect expensive endpoints (e.g. /api/v1/ai/explore) without an
extra dependency. State is per-process: with several uvicorn workers each
worker enforces its own window.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable


class SlidingWindowRateLimiter:
    """Allow at most ``limit`` hits per ``window_seconds`` for each key.

    Args:
        limit: Max requests per window per key. ``limit <= 0`` disables limiting.
        window_seconds: Window length in seconds.
        clock: Monotonic time source (injectable for tests).
        max_keys: When this many keys are tracked, idle keys are swept.
    """

    def __init__(
        self,
        limit: int,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = 10_000,
    ) -> None:
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._max_keys = max_keys
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> tuple[bool, int]:
        """Record a request for ``key``.

        Returns:
            (allowed, retry_after_seconds). ``retry_after_seconds`` is 0 when
            the request is allowed.
        """
        if self.limit <= 0:
            return True, 0

        now = self._clock()
        cutoff = now - self.window
        with self._lock:
            if len(self._hits) >= self._max_keys:
                self._sweep(cutoff)

            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= cutoff:
                hits.popleft()

            if len(hits) >= self.limit:
                retry_after = max(1, math.ceil(hits[0] + self.window - now))
                return False, retry_after

            hits.append(now)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()

    def _sweep(self, cutoff: float) -> None:
        stale = [k for k, q in self._hits.items() if not q or q[-1] <= cutoff]
        for k in stale:
            del self._hits[k]
