"""Project names as the server takes them (docs/specs/code-sessions.md §12.5): what
Anemo Desktop takes as a folder name in its projects folder."""

import pytest
from pydantic import ValidationError

from app.features.code_sessions.schemas import CodeJobIn
from app.tools.builtin.code import StartInput

BAD = [
    "",
    ".",
    "..",
    "...",
    "name.",
    "a/b",
    "a\b",
    "with space",
    "x" * 101,
    "CON",
    "con",
    "Prn",
    "aux.txt",
    "NUL.tar.gz",
    "com1",
    "COM9",
    "lpt1.md",
    "LPT9",
]
GOOD = [
    "anemo",
    "anemo-desktop",
    "a.b",
    "v1.2.3",
    ".config",
    "CONsole",
    "con-tools",
    "COM10",
    "lpt0",
]


@pytest.mark.parametrize("name", BAD)
def test_names_that_are_refused(name: str) -> None:
    with pytest.raises(ValidationError):
        CodeJobIn(device_id="00000000-0000-0000-0000-000000000000", project=name, prompt="x")
    with pytest.raises(ValidationError):
        StartInput(device="PC", project=name, prompt="x")


@pytest.mark.parametrize("name", GOOD)
def test_names_that_are_taken(name: str) -> None:
    job = CodeJobIn(device_id="00000000-0000-0000-0000-000000000000", project=name, prompt="x")
    assert job.project == name
    assert StartInput(device="PC", project=name, prompt="x").project == name
