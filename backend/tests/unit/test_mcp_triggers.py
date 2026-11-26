"""MCP triggers: the pure parts (docs/specs/17-mcp-triggers.md)."""

import uuid

import mcp_types as types
import pytest

from app.features.triggers import catalogue, matching, mcp_listener, render
from app.mcp import listen
from app.mcp.client import Target

SERVER = "0194f3a0-0000-7000-8000-000000000001"


def test_the_type_is_in_the_catalogue_and_names_its_server() -> None:
    mcp = catalogue.BY_TYPE["mcp.notification"]
    assert mcp.outside and not mcp.addressed
    assert matching.check_filter(mcp, {"server_id": SERVER, "uri": " note://a "}) == {
        "server_id": SERVER,
        "uri": "note://a",
    }
    with pytest.raises(ValueError, match="must name its MCP server"):
        matching.check_filter(mcp, {"method": "notifications/resources/updated"})
    with pytest.raises(ValueError, match="can't be filtered on “params”"):
        matching.check_filter(mcp, {"server_id": SERVER, "params": "x"})


def test_the_summary_says_which_server_and_what() -> None:
    data = {"server": "Notes", "method": "notifications/resources/updated", "uri": "note://a"}
    assert render.summary("mcp.notification", data) == (
        "MCP server notification: Notes resources/updated note://a"
    )


def test_notifications_are_method_and_params_without_meta() -> None:
    message = types.ResourceUpdatedNotification(
        params=types.ResourceUpdatedNotificationParams(uri="note://a", _meta={"x": 1})
    )
    note = listen.notification_from(message)
    assert note is not None
    assert (note.method, note.params, note.uri) == (
        "notifications/resources/updated",
        {"uri": "note://a"},
        "note://a",
    )
    assert listen.notification_from(RuntimeError("transport")) is None
    progress = types.ProgressNotification(
        params=types.ProgressNotificationParams(progress_token="t", progress=1)
    )
    assert listen.notification_from(progress) is None


def test_params_are_cut_to_fit() -> None:
    small = {"uri": "note://a"}
    assert mcp_listener.capped_params(small) is small
    cut = mcp_listener.capped_params({"data": "é" * 20_000})
    assert cut["cut"] is True and len(cut["json"].encode()) <= mcp_listener.MAX_PARAMS // 2


def test_only_what_a_trigger_could_match_is_kept() -> None:
    need = mcp_listener.Need(
        server_id=uuid.UUID(SERVER),
        name="Notes",
        target=Target(server_id=SERVER, transport="http", url="http://x"),
        wants=listen.Wants(uris=("note://a",)),
        filters=[{"server_id": SERVER, "uri": "note://a"}],
    )
    assert need.wanted({"server_id": SERVER, "method": "x", "uri": "note://a"})
    assert not need.wanted({"server_id": SERVER, "method": "x", "uri": "note://b"})
    assert not need.wanted({"server_id": SERVER, "method": "notifications/tools/list_changed"})
    # A changed subscription changes the key (reconnect); a changed filter alone doesn't.
    other = mcp_listener.Need(need.server_id, need.name, need.target, listen.Wants(), [])
    assert other.key != need.key
    same = mcp_listener.Need(need.server_id, need.name, need.target, need.wants, [])
    assert same.key == need.key
