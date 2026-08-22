"""
Cached GitHub star count, for the "Star" button in the app header.

Why this exists as a server-side cache rather than the browser calling
GitHub directly: GitHub's unauthenticated REST API allows 60 requests per
hour *per IP*. If every visitor's browser called it directly, a Render
instance behind any real traffic would blow through that in minutes and
every visitor after that would see the call fail. Instead, this process
calls GitHub at most once every CACHE_SECONDS and hands the cached number
to every visitor who asks — one instance, one quota, shared.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

import httpx

logger = logging.getLogger("markdown_to_pdf.github")

CACHE_SECONDS = 15 * 60  # refresh at most every 15 minutes
REQUEST_TIMEOUT = 5.0

# Override with the GITHUB_REPO env var
GITHUB_REPO = os.environ.get("GITHUB_REPO", "your-username/markdown-to-pdf")


class StarCount:
    """Lazily-refreshed, single-flight-ish cache of a repo's star count."""

    def __init__(self, repo: str) -> None:
        self._repo = repo
        self._count: int | None = None
        
        # Time of the last *attempt*, not the last success.
        self._last_attempt: float = 0.0
        self._lock = asyncio.Lock()

    def _within_cache_window(self, now: float) -> bool:
        return self._last_attempt > 0 and (now - self._last_attempt) < CACHE_SECONDS

    async def get(self) -> int | None:
        async with self._lock:
            now = time.monotonic()
            if self._within_cache_window(now):
                return self._count

            self._last_attempt = now
            try:
                async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
                    response = await client.get(
                        f"https://api.github.com/repos/{self._repo}",
                        headers={"Accept": "application/vnd.github+json"},
                    )
                    response.raise_for_status()
                    self._count = response.json().get("stargazers_count")
            except Exception:
                # Rate-limited, repo doesn't exist yet, network hiccup, whatever.
                logger.warning("Could not refresh GitHub star count for %s", self._repo, exc_info=True)

            return self._count


star_count = StarCount(GITHUB_REPO)