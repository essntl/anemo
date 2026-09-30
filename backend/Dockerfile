# syntax=docker/dockerfile:1

# ---- 1. Build the React frontend ------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 2. Python dependencies -------------------------------------------------
FROM python:3.13-slim AS deps
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
ARG INSTALL_DEV=false
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ "$INSTALL_DEV" = "true" ]; then uv sync --frozen --no-install-project; \
    else uv sync --frozen --no-install-project --no-dev; fi

# ---- 3. Runtime image (used by both `app` and `worker`) --------------------
FROM python:3.13-slim AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH="/opt/venv/bin:$PATH"
RUN apt-get update && apt-get install -y --no-install-recommends curl tini \
    && rm -rf /var/lib/apt/lists/*
ARG PUID=1000
ARG PGID=1000
RUN groupadd -g ${PGID} app && useradd -u ${PUID} -g app -m -s /usr/sbin/nologin app \
    && mkdir -p /data /workspace && chown app:app /data /workspace
COPY --from=deps /opt/venv /opt/venv
WORKDIR /app
COPY backend/ ./
COPY --from=frontend /frontend/dist /app/static
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
# Proxy headers are trusted only from FORWARDED_ALLOW_IPS (set from TRUSTED_PROXIES in compose).
CMD ["uvicorn", "app.main_api:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
