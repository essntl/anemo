"""MCP helpers that need no server: names, schemas, results, risk."""

import pytest
from pydantic import ValidationError

from app.features.mcp.service import risk_from_hints, slugify, tool_hash
from app.mcp.client import result_from_dump, tool_from_dump
from app.tools.mcp_tool import _input_model, model_name, provider_schema


def test_server_ids_and_tool_names_fit_what_providers_accept():
    assert slugify("My GitHub (work)") == "my_github_work"
    assert slugify("   ") == "server"
    assert len(slugify("x" * 80)) == 24
    assert model_name("github", "create_issue") == "mcp__github__create_issue"
    odd = model_name("github", "repos/list.all")
    assert odd.startswith("mcp__github__repos_list_all_") and odd != model_name(
        "github", "repos_list_all"
    )
    long = model_name("github", "t" * 100)
    assert len(long) == 64 and long != model_name("github", "t" * 99)


def test_schemas_are_made_safe_for_providers():
    schema = {
        "$schema": "x",
        "title": "T",
        "type": "object",
        "properties": {"a": {"type": "string"}},
    }
    assert provider_schema(schema) == {"type": "object", "properties": {"a": {"type": "string"}}}
    assert provider_schema({}) == {"type": "object", "properties": {}}
    assert provider_schema({"type": "string"}) == {"type": "object", "properties": {}}


def test_arguments_are_checked_against_the_tools_schema():
    model = _input_model(
        {"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"]}
    )
    assert model.model_validate({"n": 3}).root == {"n": 3}
    with pytest.raises(ValidationError, match="'n' is a required property"):
        model.model_validate({})
    with pytest.raises(ValidationError, match="n: 'x' is not of type 'integer'"):
        model.model_validate({"n": "x"})
    # A schema that is itself broken does not block the call.
    assert _input_model({"type": 12}).model_validate({"a": 1}).root == {"a": 1}


def test_risk_comes_from_the_servers_hints():
    assert risk_from_hints({"read_only_hint": True}) == "safe"
    assert risk_from_hints({"readOnlyHint": True, "destructiveHint": True}) == "safe"
    assert risk_from_hints({"destructive_hint": True}) == "dangerous"
    assert risk_from_hints({}) == "moderate"
    assert tool_hash("d", {"a": 1}, {}) != tool_hash("d2", {"a": 1}, {})
    assert tool_hash("d", {"a": 1, "b": 2}, {}) == tool_hash("d", {"b": 2, "a": 1}, {})


def test_results_become_text_for_the_model():
    result = result_from_dump(
        {
            "content": [
                {"type": "text", "text": "first"},
                {"type": "image", "data": "AAAA", "mime_type": "image/png"},
                {"type": "resource", "resource": {"uri": "file:///a", "text": "from a file"}},
                {"type": "resource_link", "uri": "https://example.com/x"},
            ],
            "is_error": False,
        }
    )
    assert result.text == (
        "first\n[image returned by the tool (image/png); not shown]\n"
        "from a file\n[link: https://example.com/x]"
    )
    assert not result.is_error
    assert (
        result_from_dump({"content": [], "structured_content": {"n": 1}}).text == '{\n  "n": 1\n}'
    )
    assert result_from_dump({"content": []}).text == "(The tool returned nothing.)"
    assert result_from_dump({"content": [{"type": "text", "text": "no"}], "isError": True}).is_error
    assert result_from_dump({"input_requests": []}).is_error  # asks for input: not supported

    tool = tool_from_dump({"name": "t", "inputSchema": {"type": "object"}, "annotations": None})
    assert tool.input_schema == {"type": "object"} and tool.annotations == {}
