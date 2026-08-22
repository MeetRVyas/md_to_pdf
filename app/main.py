"""
Markdown -> A4 PDF web application.

Single FastAPI app that serves the frontend and exposes the conversion API,
per the "V1" recommendation in the project spec (section 21/28): one
service, one deployable unit, minimal moving parts.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.github import GITHUB_REPO, star_count
from app.markdown import render_document
from app.pdf import browser_manager
from app.quotes import random_quote
from app.stats import counter

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("markdown_to_pdf")

# ---------------------------------------------------------------------------
# Limits (spec section 17)
# ---------------------------------------------------------------------------
MAX_MARKDOWN_BYTES = 5 * 1024 * 1024  # 5 MB of actual Markdown content
# The raw HTTP request is allowed a bit more headroom than the content limit
# above to account for JSON string-escaping overhead (e.g. every newline in
# the Markdown becomes the two characters \n).
MAX_REQUEST_BYTES = 8 * 1024 * 1024

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start the shared Chromium instance once, up front, so the first real
    # request isn't the one that pays the browser-launch cost.
    await browser_manager.start()
    try:
        yield
    finally:
        await browser_manager.stop()


app = FastAPI(title="Markdown to PDF", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Request size guard
# ---------------------------------------------------------------------------
@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
        except ValueError:
            length = None
        if length is not None and length > MAX_REQUEST_BYTES:
            return JSONResponse(
                status_code=413,
                content={"detail": "The Markdown document is too large."},
            )
    return await call_next(request)


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(str(TEMPLATES_DIR / "index.html"))


# ---------------------------------------------------------------------------
# Health check (spec section 23)
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Conversion API (spec section 14)
# ---------------------------------------------------------------------------
class PdfRequest(BaseModel):
    markdown: str = Field(..., description="Markdown source to convert.")
    filename: str | None = Field(
        default=None,
        description="Original uploaded filename, if any, used to name the PDF.",
    )


@app.post("/api/pdf")
async def convert_to_pdf(payload: PdfRequest) -> Response:
    logger.info("PDF request received")

    markdown_text = payload.markdown
    if not markdown_text.strip():
        raise HTTPException(status_code=400, detail="The Markdown document is empty.")

    if len(markdown_text.encode("utf-8")) > MAX_MARKDOWN_BYTES:
        raise HTTPException(
            status_code=413, detail="The Markdown document is too large."
        )

    started_at = time.monotonic()
    logger.info("PDF generation started")
    try:
        document = render_document(markdown_text, payload.filename)
        title = document.filename_stem.replace("_", " ")
        pdf_bytes = await browser_manager.render_pdf(document.html, title=title)
    except Exception:  # noqa: BLE001 - convert any renderer failure to a clean 502
        logger.exception("PDF generation failed")
        raise HTTPException(
            status_code=502, detail="PDF generation failed. Please try again."
        )

    elapsed = time.monotonic() - started_at
    logger.info("PDF generation completed in %.2fs", elapsed)
    await counter.increment()

    filename = f"{document.filename_stem}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# Header stats: conversion count + GitHub star badge
# ---------------------------------------------------------------------------
@app.get("/api/stats")
async def stats() -> dict:
    return {
        "conversions": counter.count,
        "github_stars": await star_count.get(),
        "github_repo_url": f"https://github.com/{GITHUB_REPO}",
    }


# ---------------------------------------------------------------------------
# Footer quote
# ---------------------------------------------------------------------------
@app.get("/api/quote")
async def quote() -> dict:
    return random_quote() or {
        "text": "Always look at the bigger picture. There is no comfort.",
        "author": "Loki S2 E6"
    }


# ---------------------------------------------------------------------------
# Generic error shape for unhandled exceptions (never leak stack traces)
# ---------------------------------------------------------------------------
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "The server is temporarily unavailable."},
    )