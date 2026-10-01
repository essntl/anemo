# syntax=docker/dockerfile:1
# The agents' browser: headless Chromium driven by Playwright, in its own container.
# Optional: only started with `docker compose --profile browser up -d`.
FROM python:3.13-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends tini fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/browserd && /opt/browserd/bin/pip install --no-cache-dir \
        "playwright==1.63.0" "fastapi>=0.115" "uvicorn>=0.32" \
    # Chromium (the headless build only) and the system libraries it needs.
    && /opt/browserd/bin/playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*
COPY browserd/ /opt/browserd/app/

ARG PUID=1000
ARG PGID=1000
RUN groupadd -g ${PGID} browser && useradd -u ${PUID} -g browser -m -d /home/browser -s /usr/sbin/nologin browser \
    && mkdir -p /run/browserd && chown browser:browser /run/browserd

USER browser
ENV HOME=/home/browser
WORKDIR /home/browser
EXPOSE 7090
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/browserd/bin/uvicorn", "--app-dir", "/opt/browserd/app", "app:app", "--host", "0.0.0.0", "--port", "7090", "--no-access-log"]
