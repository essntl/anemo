"""`request-size --tools`: the tool specs' sizes, without a database (was tool-spec-sizes)."""

from app import cli


def test_request_size_tools_prints_every_tool_spec(capsys) -> None:
    assert cli.main(["cli", "request-size", "--tools"]) == 0
    out = capsys.readouterr().out
    assert "TOTAL (" in out and "code_status" in out


def test_the_old_name_is_gone(capsys) -> None:
    assert cli.main(["cli", "tool-spec-sizes"]) == 2
    assert "request-size --tools" in capsys.readouterr().err
