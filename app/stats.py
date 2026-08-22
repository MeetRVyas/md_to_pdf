"""
Asynchronous conversion counter with background persistence.

This module provides a concurrency-safe counter for tracking conversions.
The counter is initialized from `data/user_counts.json` when the server
starts, allowing the in-memory count to survive process restarts.
Each increment is performed atomically and schedules the updated count for
asynchronous persistence.

File writes are serialized to prevent concurrent background tasks from
overwriting one another. Persistence is intentionally decoupled from the
increment operation so callers do not have to wait for disk I/O.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

logger = logging.getLogger("markdown_to_pdf.stats")

DEFAULT_STATS_FILE = "/var/data/user_counts.json"
STATS_FILE = os.environ.get("STATS_FILE", DEFAULT_STATS_FILE)


class ConversionCounter:
    """Track conversion counts in memory and persist updates asynchronously."""

    def __init__(self, file_path: str = STATS_FILE) -> None:
        self._count = 0
        self._lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._data_file = Path(file_path)

        # In-flight background write tasks. Tracked so `flush()` can wait for them
        self._pending: set[asyncio.Task] = set()

        count = self._read_count_sync()
        if count is not None:
            self._count = count

    async def increment(self) -> int:
        async with self._lock:
            self._count += 1
            count = self._count

        # Schedule the file write without blocking the caller.
        task = asyncio.create_task(self._write_count(count))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

        return count

    async def flush(self) -> None:
        """Wait for any in-flight background writes to finish."""
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)

    async def _write_count(self, count: int) -> None:
        async with self._write_lock:
            self._data_file.parent.mkdir(parents=True, exist_ok=True)
            try:
                await asyncio.to_thread(self._write_count_sync, count)
            except OSError:
                logger.warning("Failed to persist conversion count", exc_info=True)

    def _read_count_sync(self) -> int | None:
        try:
            with self._data_file.open("r", encoding="utf-8") as f:
                data = json.load(f)
            count = data.get("count")
            return count if isinstance(count, int) else None
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

    def _write_count_sync(self, count: int) -> None:
        with self._data_file.open("w", encoding="utf-8") as f:
            json.dump({"count": count}, f)

    @property
    def count(self) -> int:
        return self._count


counter = ConversionCounter()
