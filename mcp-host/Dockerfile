# syntax=docker/dockerfile:1
# The MCP host: where local ("stdio") MCP servers run, away from the worker and its
# secrets. Optional: only started with `docker compose --profile mcp up -d`.
FROM python:3.13-slim

# What MCP servers are usually started with: npx (Node) and uvx (Python).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git nodejs npm tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /uvx /usr/local/bin/

# hostd lives in its own virtualenv, out of the way of anything the servers install.
RUN python -m venv /opt/hostd && /opt/hostd/bin/pip install --no-cache-dir \
        "mcp>=2.2,<3" "fastapi>=0.115" "uvicorn>=0.32"
COPY hostd/app.py /opt/hostd/app.py

ARG PUID=1000
ARG PGID=1000
RUN groupadd -g ${PGID} mcp && useradd -u ${PUID} -g mcp -m -d /home/mcp -s /bin/bash mcp \
    && mkdir -p /run/hostd && chown mcp:mcp /run/hostd /home/mcp

USER mcp
ENV HOME=/home/mcp PYTHONDONTWRITEBYTECODE=1
WORKDIR /home/mcp
EXPOSE 7080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/hostd/bin/uvicorn", "--app-dir", "/opt/hostd", "app:app", "--host", "0.0.0.0", "--port", "7080", "--no-access-log"]
