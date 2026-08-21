# Markdown → PDF

Convert Markdown revision notes into polished A4 PDFs in the browser — no
Pandoc, no local Python, no installs.

```
Upload / paste Markdown  →  live preview  →  Download PDF
```

A single FastAPI service serves the frontend and renders PDFs server-side
with headless Chromium (via Playwright), so the PDF always matches what's
on screen. See **[DEPLOY.md](./DEPLOY.md)** for deploying this to Render.

## How it's built

```
Markdown
   │
   ▼
markdown-it-py (GFM: tables, strikethrough, autolink)
   │
   ▼
sanitize (bleach allowlist — strips scripts, unsafe attrs/protocols)
   │
   ▼
HTML fragment ── inlined into document.css ──▶ Chromium ──▶ A4 PDF
```

The **same** `app/static/document.css` stylesheet styles both the
in-browser live preview and the server-rendered PDF, so what you see in
the preview pane is what you get in the download.

## Project structure

```
markdown-to-pdf/
├── app/
│   ├── main.py           FastAPI app: routes, validation, size limits
│   ├── markdown.py       GFM parsing, HTML sanitization, filename logic
│   ├── pdf.py            Playwright/Chromium PDF rendering (reused browser)
│   ├── templates/
│   │   └── index.html    Single-page frontend shell
│   └── static/
│       ├── app.js        Upload/drag-drop, live preview, download
│       ├── styles.css    App UI chrome (header, panels, buttons)
│       ├── document.css  Shared preview+PDF stylesheet (the "look")
│       └── vendor/
│           └── markdown-it.min.js   Vendored — no CDN dependency
├── requirements.txt
├── Dockerfile
├── render.yaml
├── DEPLOY.md
└── README.md
```

This deviates slightly from a fully generic template in one place worth
calling out: `static/document.css` (the notes' visual style — colors,
heading hierarchy, table striping, page margins) is split out from
`static/styles.css` (the tool's own UI chrome). Both are plain CSS files
in the same `static/` directory; the split just keeps "what the PDF looks
like" and "what the app looks like" from tangling together, while keeping
them in exactly one place each so preview and PDF can't drift apart.

## Running locally

Requires Python 3.11+.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

pip install -r requirements.txt
python -m playwright install --with-deps chromium

uvicorn app.main:app --reload --port 8000
```

Then open <http://127.0.0.1:8000>.

`playwright install --with-deps chromium` downloads a browser binary from
Playwright's CDN and installs its OS-level dependencies — it needs network
access and (on Linux) usually `sudo` for the `--with-deps` half. If you
only want the browser binary itself, drop `--with-deps` and install the
system libraries Chromium needs yourself (Playwright will tell you exactly
which ones are missing the first time it fails to launch).

## API

### `POST /api/pdf`

```json
{
  "markdown": "# Notes\n\nBody text...",
  "filename": "IR_Numericals_Revision_Notes.md"
}
```

`filename` is optional — pass the originally uploaded filename if you have
one; otherwise the PDF is named from the document's first `# H1`, or
`document.pdf` if neither is available.

Returns `application/pdf` with `Content-Disposition: attachment`, or a
JSON `{"detail": "..."}` error body on failure:

| Status | When |
|---|---|
| 400 | Markdown is empty/whitespace-only |
| 413 | Markdown exceeds 5 MB, or the request body exceeds 8 MB |
| 502 | Chromium failed to render the document |
| 500 | Unhandled server error |

### `GET /health`

`{"status": "ok"}` — used as Render's health check.

## Security & privacy

- Markdown is parsed with raw HTML passthrough **disabled**, and the
  resulting HTML is run through an explicit `bleach` allowlist before it
  ever reaches Chromium — no `<script>`, no `javascript:` links, no
  event-handler attributes.
- Nothing is written to a database or disk beyond the request's lifetime:
  upload → convert → return the PDF → discard. There are no user accounts
  and no persistence layer by design (see the spec's non-goals).
- Request size is capped (5 MB of Markdown / 8 MB of request body) to
  bound memory use per request.
- The request-size guard reads the `Content-Length` header up front; it
  does **not** defend against a client that omits `Content-Length` and
  streams an unbounded chunked body. That's an acceptable trade-off for a
  personal/small-team utility, but worth hardening (e.g. with a streaming
  byte-counting wrapper, or a reverse-proxy body-size limit) before
  exposing this to the general public at scale.
- Server logs record request lifecycle events (received / started /
  completed / failed) but never the Markdown content itself.

## Known limitations / possible follow-ups

- No CSS-counter auto-numbering of `##` sections (e.g. turning `## Boolean
  Retrieval` into "2. Boolean Retrieval" automatically) — the spec's mock
  numbering is treated as content the author typed, not a generated
  feature. Straightforward to add later as a `counter-reset`/`counter-
  increment` pair in `document.css` if wanted.
- Live preview and the PDF use the same *parser family* (`markdown-it` in
  JS for the browser, `markdown-it-py` — a faithful Python port — on the
  server) rather than one literal shared implementation, since one runs in
  the browser and the other server-side. In practice their GFM output is
  effectively identical for the elements this app supports; the PDF is
  always the source of truth.
- No syntax highlighting in code blocks (spec doesn't require it — code
  blocks are styled as clean monospace blocks).
