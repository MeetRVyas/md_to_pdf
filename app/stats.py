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
from pathlib import Path


STAR_COUNTS_FILE = "data/user_counts.json"

class ConversionCounter:
    """Track conversion counts in memory and persist updates asynchronously."""

    def __init__(self, file_path = STAR_COUNTS_FILE) -> None:
        self._count = 0
        self._lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._data_file = Path(STAR_COUNTS_FILE)

        count = self._read_count_sync()
        if count:
            self._count = count

    async def increment(self) -> int:
        async with self._lock:
            self._count += 1
            count = self._count

        # Schedule the file write without blocking the caller.
        asyncio.create_task(self._write_count(count))

        return count

    async def _write_count(self, count: int) -> None:
        async with self._write_lock:
            self._data_file.parent.mkdir(parents=True, exist_ok=True)

            # File I/O is synchronous, so move it off the event loop.
            await asyncio.to_thread(self._write_count_sync, count)

    def _read_count_sync(self) -> int | None:
        try:
            # Read lock not required.
            # Lock is required if any change is being done.
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
