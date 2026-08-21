# syntax=docker/dockerfile:1

# Playwright's official image ships Chromium plus every OS-level library it
# needs already installed. Building on a plain python:slim image works too,
# but you then have to apt-get install ~20 packages yourself (see DEPLOY.md
# troubleshooting section for that fallback) — this avoids that entirely.
#
# Keep this tag's version in lockstep with the `playwright` version pinned
# in requirements.txt. If you bump one, bump the other.
FROM mcr.microsoft.com/playwright/python:v1.56.0-noble

WORKDIR /app

# Install Python dependencies first so this layer is cached across builds
# that only change application code.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Belt-and-suspenders: make sure the Chromium build baked into the base
# image actually matches the `playwright` pip package we just installed.
# This is a no-op (fast) when they already match, and self-heals if they
# ever drift apart.
RUN python -m playwright install --with-deps chromium

COPY app ./app

# Render provides $PORT at runtime and routes traffic to it; 8000 here is
# just a documented default for running the image outside Render.
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
