"""
PDF page-setup options: size, margins, font size, page numbers.
"""

from __future__ import annotations

import math

# name -> (width_mm, height_mm), portrait, millimetres
PAGE_SIZES_MM: dict[str, tuple[float, float]] = {
    # ISO 216 — A Series
    "A0": (841, 1189),
    "A1": (594, 841),
    "A2": (420, 594),
    "A3": (297, 420),
    "A4": (210, 297),
    "A5": (148, 210),
    "A6": (105, 148),
    "A7": (74, 105),
    "A8": (52, 74),
    "A9": (37, 52),
    "A10": (26, 37),

    # ISO 216 — B Series
    "B0": (1000, 1414),
    "B1": (707, 1000),
    "B2": (500, 707),
    "B3": (353, 500),
    "B4": (250, 353),
    "B5": (176, 250),
    "B6": (125, 176),
    "B7": (88, 125),
    "B8": (62, 88),
    "B9": (44, 62),
    "B10": (31, 44),

    # ISO 269 — C Series (mostly envelopes)
    "C0": (917, 1297),
    "C1": (648, 917),
    "C2": (458, 648),
    "C3": (324, 458),
    "C4": (229, 324),
    "C5": (162, 229),
    "C6": (114, 162),
    "C7": (81, 114),
    "C8": (57, 81),
    "C9": (40, 57),
    "C10": (28, 40),

    # Common international / legacy sizes
    "Letter": (215.9, 279.4),
    "Legal": (215.9, 355.6),
    "Executive": (184.15, 266.7),
    "Tabloid": (279.4, 431.8),
    "Ledger": (431.8, 279.4),
}

# Display/selection order for page sizes, grouped the way a person actually
# thinks about them. PAGE_SIZES_MM.keys() (or a naive `sorted()` over it) is
# NOT used for this: plain string sorting puts "A10" before "A2" (lexical,
# not numeric), and it interleaves the A/B/C series together. This is the
# single source of truth for both the frontend dropdown (via
# /api/page-options) and any future CLI/help text.
PAGE_SIZE_GROUPS: dict[str, list[str]] = {
    "ISO A": ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"],
    "ISO B": ["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10"],
    "ISO C (envelopes)": [
        "C0", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10",
    ],
    "Common": ["Letter", "Legal", "Executive", "Tabloid", "Ledger"],
}

# name -> (top, right, bottom, left) in mm
MARGIN_PRESETS_MM: dict[str, tuple[float, float, float, float]] = {
    "compact": (12, 10, 12, 10),
    "normal": (20, 16, 18, 16),
    "wide": (28, 24, 26, 24),
}

# Font size is a plain number interpolated straight into the generated CSS
# (see page_override_css below), not a string like page_size/margins are, so
# it doesn't carry the same CSS-injection risk — a bounded numeric *range*
# is enough validation, rather than an exact-match allowlist. That's what
# lets this be "pick anything from 8pt to 24pt in 0.1pt steps" on the
# frontend instead of a short hardcoded list of presets. 0.1 (rather than a
# rounder 0.5) is chosen deliberately so the existing 10.3pt default still
# lands exactly on the grid.
FONT_SIZE_MIN_PT = 8.0
FONT_SIZE_MAX_PT = 24.0
FONT_SIZE_STEP_PT = 0.1

DEFAULT_PAGE_SIZE = "A4"
DEFAULT_MARGINS = "normal"
DEFAULT_FONT_SIZE = 10.3


def is_valid_font_size(value: float) -> bool:
    """Whether `value` is an in-range, finite, on-the-grid font size.

    "On-the-grid" means it lands on one of the FONT_SIZE_STEP_PT increments
    starting at FONT_SIZE_MIN_PT (8, 8.5, 9, ... 24) — this keeps
    server-rendered PDFs limited to the same values the frontend stepper can
    ever produce, without needing to enumerate them all as an allowlist.
    """
    if not math.isfinite(value):
        return False
    if value < FONT_SIZE_MIN_PT or value > FONT_SIZE_MAX_PT:
        return False
    steps = (value - FONT_SIZE_MIN_PT) / FONT_SIZE_STEP_PT
    return math.isclose(steps, round(steps), abs_tol=1e-6)


def page_override_css(page_size: str, margins: str, font_size: float) -> str:
    """CSS overriding document.css's fixed @page rule and base font size.

    Appended *after* document.css in the generated HTML so the cascade
    (same specificity, later source order wins) picks this up without
    needing !important anywhere.
    """
    width, height = PAGE_SIZES_MM[page_size]
    top, right, bottom, left = MARGIN_PRESETS_MM[margins]
    return (
        "@page {"
        f"size: {width}mm {height}mm;"
        f"margin: {top}mm {right}mm {bottom}mm {left}mm;"
        "}"
        ".doc {"
        f"font-size: {font_size}pt;"
        "}"
    )


# Chromium renders header/footer templates in their own isolated document,
# so they get their own inline styles rather than inheriting document.css.
# pageNumber/totalPages are special classes Chromium replaces at print time.
FOOTER_TEMPLATE = """
<div style="width:100%; font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;
            font-size:8px; color:#8a8f98; text-align:center; padding:0;">
  Page <span class="pageNumber"></span> of <span class="totalPages"></span>
</div>
"""