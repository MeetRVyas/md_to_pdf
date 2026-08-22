"""
Random footer quote.

Quotes live in `app/data/quotes.json` rather than in this module, so adding,
removing, or editing quotes never requires touching Python — just the
data file. Add as many as you like; nothing here assumes exactly three.
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import TypedDict
import warnings

DATA_PATH = Path(__file__).parent / "data" / "quotes.json"


class Quote(TypedDict):
    text: str
    author: str | None


_quotes_cache: list[Quote] | None = None


def _load_quotes() -> list[Quote]:
    global _quotes_cache
    if _quotes_cache is None:
        raw = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        if not raw:
            warnings.warn(f"{DATA_PATH} is empty — add at least one quote.", ValueError)
            raw = None
        _quotes_cache = raw
    return _quotes_cache


def random_quote() -> Quote | None:
    _quotes = _load_quotes()
    if _quotes:
        return random.choice(_quotes)