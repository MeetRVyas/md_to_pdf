"""
Markdown -> sanitized HTML conversion.

This module is used by both the PDF-generation path (pdf.py) and could be
reused by a server-side preview endpoint if one is ever added. Keeping the
parser configuration in one place is what guarantees the preview and the
PDF are built from "the same document representation" (see spec section 11).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import bleach
from markdown_it import MarkdownIt

# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------
# "gfm-like" enables GitHub-Flavored-Markdown-ish behaviour out of the box:
# tables, strikethrough and autolinking, on top of CommonMark. `html=False`
# is deliberate: raw HTML typed/pasted into the Markdown source is treated
# as plain text rather than being passed through, which is the first line
# of defence against script injection (see security notes below).
_md = MarkdownIt("gfm-like", {"html": False, "linkify": True, "typographer": False})


# ---------------------------------------------------------------------------
# Sanitization
# ---------------------------------------------------------------------------
# Even though the parser won't emit raw HTML from the input, we still run
# everything through an explicit allowlist. This is defence in depth against
# parser bugs and keeps behaviour identical if `html` is ever re-enabled.
_ALLOWED_TAGS = {
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "strong", "b", "em", "i", "s", "del", "code", "pre",
    "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td",
    "a", "blockquote", "span",
}

_ALLOWED_ATTRS = {
    "a": ["href", "title", "rel", "target"],
    "code": ["class"],  # markdown-it emits language-xxx classes on code blocks
    "th": ["align"],
    "td": ["align"],
}

_ALLOWED_PROTOCOLS = ["http", "https", "mailto"]


def _sanitize(html: str) -> str:
    return bleach.clean(
        html,
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRS,
        protocols=_ALLOWED_PROTOCOLS,
        strip=True,
        strip_comments=True,
    )


def _harden_links(html: str) -> str:
    """Add rel=noopener/nofollow + target=_blank to external links.

    Done as a lightweight regex pass on already-sanitized, well-formed
    output (produced by markdown-it, not hand-written HTML), rather than
    a full HTML parse, to keep this module dependency-light.
    """
    def add_attrs(match: re.Match) -> str:
        tag = match.group(0)
        if "href=\"http" not in tag and "href='http" not in tag:
            return tag
        if "rel=" in tag:
            return tag
        return tag[:-1] + ' rel="noopener noreferrer" target="_blank">'

    return re.sub(r"<a\s[^>]*>", add_attrs, html)


def render_html(markdown_text: str) -> str:
    """Convert Markdown source to sanitized, hardened HTML fragment."""
    raw_html = _md.render(markdown_text)
    safe_html = _sanitize(raw_html)
    return _harden_links(safe_html)


# ---------------------------------------------------------------------------
# Filename derivation (spec section 16)
# ---------------------------------------------------------------------------
_H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_INLINE_MD_RE = re.compile(r"[*_`~]|\[([^\]]*)\]\([^)]*\)")
_NON_SLUG_RE = re.compile(r"[^A-Za-z0-9]+")


def _strip_inline_markdown(text: str) -> str:
    # Collapse [label](url) -> label, then drop remaining emphasis markers.
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[*_`~]", "", text)


def slugify_filename(text: str, fallback: str = "document") -> str:
    """Turn arbitrary text into a Word_Separated_With_Underscores filename stem.

    Note: this does NOT strip markdown emphasis markers, because it is also
    used on plain (already clean) filename strings where a literal
    underscore, like in "IR_Numericals_Revision_Notes", must be preserved
    rather than treated as an emphasis marker. Callers deriving a stem from
    Markdown heading text should pre-process with `_strip_inline_markdown`.
    """
    stem = _NON_SLUG_RE.sub("_", text).strip("_")
    return stem or fallback


def derive_filename_stem(markdown_text: str, original_filename: str | None) -> str:
    """
    Priority:
      1. Original uploaded filename (spec section 16, first example), sanitized.
      2. First H1 in the document, sanitized.
      3. Generic fallback.
    """
    if original_filename:
        base = original_filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        base = re.sub(r"\.(md|markdown|txt)$", "", base, flags=re.IGNORECASE)
        base = base.strip()
        if base:
            stem = slugify_filename(base)
            if stem and stem != "document":
                return stem

    match = _H1_RE.search(markdown_text)
    if match:
        heading_text = _strip_inline_markdown(match.group(1))
        return slugify_filename(heading_text)

    return "document"


@dataclass
class RenderedDocument:
    html: str
    filename_stem: str


def render_document(markdown_text: str, original_filename: str | None = None) -> RenderedDocument:
    return RenderedDocument(
        html=render_html(markdown_text),
        filename_stem=derive_filename_stem(markdown_text, original_filename),
    )
