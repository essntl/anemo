"""The API contract: the schema the backend serves must match the one the frontend's
types were generated from (`frontend/src/api/openapi.json`).

A failure means an endpoint, a parameter or a response shape changed. If that was
intended, regenerate the frontend types with `make gen-api` and commit both files; if
not, the change broke the API the frontend relies on.

The dev container mounts only `backend/`, so CI and `make test-backend` mount the
committed file and point OPENAPI_SNAPSHOT at it.
"""

import json
import os
from pathlib import Path

import pytest

from app.main_api import create_app

SNAPSHOT = Path(
    os.environ.get("OPENAPI_SNAPSHOT")
    or Path(__file__).parents[3] / "frontend" / "src" / "api" / "openapi.json"
)


@pytest.mark.skipif(not SNAPSHOT.is_file(), reason=f"no committed schema at {SNAPSHOT}")
def test_the_api_matches_the_committed_schema() -> None:
    committed = json.loads(SNAPSHOT.read_text())
    current = create_app().openapi()
    added = sorted(set(current["paths"]) - set(committed["paths"]))
    removed = sorted(set(committed["paths"]) - set(current["paths"]))
    changed = sorted(
        p
        for p in set(current["paths"]) & set(committed["paths"])
        if current["paths"][p] != committed["paths"][p]
    )
    schemas = sorted(
        name
        for name in set(current["components"]["schemas"]) | set(committed["components"]["schemas"])
        if current["components"]["schemas"].get(name)
        != committed["components"]["schemas"].get(name)
    )
    assert current == committed, (
        "The API differs from frontend/src/api/openapi.json (run `make gen-api` if intended).\n"
        f"Paths added: {added}\nPaths removed: {removed}\nPaths changed: {changed}\n"
        f"Schemas changed: {schemas}"
    )
