# syntax=docker/dockerfile:1
# The shell sandbox: where agent commands run. Used by two services in
# docker-compose.yml: `sandbox` (no network at all) and `sandbox-net` (internet).
FROM python:3.13-slim

# Common tools agents reach for. Keep this list modest; agents can `pip install --user`
# or `npm install` into the workspace/home when the network sandbox is allowed.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates coreutils curl file findutils git jq less make \
        nodejs npm openssh-client procps ripgrep rsync sqlite3 tree unzip wget xz-utils zip tini \
    && rm -rf /var/lib/apt/lists/*

# Libraries for reading and making files people ask for: spreadsheets, Word and
# PowerPoint files, PDFs and charts. Installed system-wide (not in the execd venv), so
# `python3` in the sandbox has them even without network access.
RUN pip install --no-cache-dir \
        "pandas>=2.2" "openpyxl>=3.1" "xlsxwriter>=3.2" "python-docx>=1.1" "python-pptx>=1.0" \
        "reportlab>=4.2" "pypdf>=5.1" "matplotlib>=3.9" "markdown>=3.7"

# execd lives in its own virtualenv, out of the way of anything agents install.
RUN python -m venv /opt/execd && /opt/execd/bin/pip install --no-cache-dir \
        "fastapi>=0.115" "uvicorn>=0.32"
COPY execd/app.py /opt/execd/app.py

ARG PUID=1000
ARG PGID=1000
RUN groupadd -g ${PGID} agent && useradd -u ${PUID} -g agent -m -d /home/agent -s /bin/bash agent \
    && mkdir -p /workspace /run/execd /home/agent/.ssh     && chown agent:agent /workspace /run/execd /home/agent /home/agent/.ssh && chmod 700 /home/agent/.ssh

USER agent
ENV HOME=/home/agent PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace
EXPOSE 7070
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/execd/bin/uvicorn", "--app-dir", "/opt/execd", "app:app", "--host", "0.0.0.0", "--port", "7070", "--no-access-log"]
