"""
PDF page-setup options: size, margins, font size, page numbers.
"""

from __future__ import annotations

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

# name -> (top, right, bottom, left) in mm
MARGIN_PRESETS_MM: dict[str, tuple[float, float, float, float]] = {
    "compact": (12, 10, 12, 10),
    "normal": (20, 16, 18, 16),
    "wide": (28, 24, 26, 24),
}

FONT_SIZES_PT: tuple[float, ...] = (9.5, 10, 10.3, 11)

DEFAULT_PAGE_SIZE = "A4"
DEFAULT_MARGINS = "normal"
DEFAULT_FONT_SIZE = 10.3


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