"""
HTML -> A4 PDF rendering via a headless, persistent Chromium instance.

A single Chromium process is launched once at application startup and reused
for every request (spec section 25: "avoid launching a new browser
installation for every request"). Each request gets its own Page, which is
cheap and keeps requests isolated from one another.
"""

from __future__ import annotations

import asyncio
import logging
import os
from html import escape
from pathlib import Path

from playwright.async_api import Browser, Playwright, async_playwright

logger = logging.getLogger("markdown_to_pdf.pdf")

STATIC_DIR = Path(__file__).parent / "static"
_DOCUMENT_CSS_PATH = STATIC_DIR / "document.css"

# Cap how many PDF renders run at once so a burst of requests can't exhaust
# memory on a small Render instance. Configurable via env var.
_MAX_CONCURRENT_RENDERS = int(os.environ.get("MAX_CONCURRENT_RENDERS", "3"))

# Sandbox flags matter in most container environments (Docker on Render
# included): the default Chromium sandbox needs privileges that aren't
# available there, and /dev/shm is often too small for Chromium's defaults.
_CHROMIUM_LAUNCH_ARGS = [
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-gpu",
]


class BrowserManager:
    """Owns a single lazily-started, reusable Chromium instance."""

    def __init__(self) -> None:
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._lock = asyncio.Lock()
        self._semaphore = asyncio.Semaphore(_MAX_CONCURRENT_RENDERS)

    async def start(self) -> None:
        async with self._lock:
            if self._browser is not None:
                return
            logger.info("Launching Chromium for PDF rendering")
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                args=_CHROMIUM_LAUNCH_ARGS
            )

    async def stop(self) -> None:
        async with self._lock:
            if self._browser is not None:
                await self._browser.close()
                self._browser = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None

    async def _get_browser(self) -> Browser:
        if self._browser is None:
            await self.start()
        assert self._browser is not None
        return self._browser

    async def render_pdf(self, html_fragment: str, title: str = "Document") -> bytes:
        async with self._semaphore:
            browser = await self._get_browser()
            page = await browser.new_page()
            try:
                full_html = _build_html_document(title, html_fragment)
                # Markdown notes are self-contained: no external images/fonts
                # to wait on, so "load" is sufficient and keeps things fast.
                await page.set_content(full_html, wait_until="load")
                pdf_bytes = await page.pdf(
                    print_background=True,
                    prefer_css_page_size=True,
                )
                return pdf_bytes
            finally:
                await page.close()


_document_css_cache: str | None = None


def _document_css() -> str:
    global _document_css_cache
    if _document_css_cache is None:
        _document_css_cache = _DOCUMENT_CSS_PATH.read_text(encoding="utf-8")
    return _document_css_cache


def _build_html_document(title: str, body_html: str) -> str:
    """Wrap a sanitized HTML fragment with the shared document stylesheet.

    This is intentionally the exact same CSS file (document.css) served to
    the browser preview, inlined here rather than fetched over the network
    so PDF generation has no external dependency.
    """
    css = _document_css()
    return (
        "<!doctype html>"
        '<html lang="en"><head><meta charset="utf-8" />'
        f"<title>{escape(title)}</title>"
        f"<style>{css}</style>"
        f'</head><body><div class="doc">{body_html}</div></body></html>'
    )


browser_manager = BrowserManager()
