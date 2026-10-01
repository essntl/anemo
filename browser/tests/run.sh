#!/bin/sh
# Runs the browserd tests inside the browser image (see test_browserd.py).
set -e
/opt/browserd/bin/pip install --quiet --target /tmp/testdeps pytest pytest-asyncio httpx
cd /tmp
PYTHONPATH=/tmp/testdeps:/src/browserd exec /opt/browserd/bin/python -m pytest \
    -p no:cacheprovider -o asyncio_mode=auto -q /src/tests "$@"
