"""Web tools inside agent runs, and the Web & Search settings."""

import httpx
import pytest

from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.web import search
from tests.api.test_agent import (
    agent_turn,
    call,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
    workspace,  # noqa: F401 - autouse fixture
)
from tests.api.test_shell import new_chat
from tests.conftest import requires_db
from tests.web_server import web_server

pytestmark = requires_db


@pytest.fixture
def searxng():
    """A fake SearXNG answering every search with two results."""
    queries: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        queries.append(request.url.params["q"])
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Otter facts",
                        "url": "https://otters.example/facts",
                        "content": "Otters use tools.",
                    },
                    {
                        "title": "Raft",
                        "url": "https://otters.example/raft",
                        "content": "Groups of otters.",
                    },
                ]
            },
        )

    search.transport_override = httpx.MockTransport(handler)
    yield queries
    search.transport_override = None


async def web_settings(client, **values) -> None:
    r = await client.put("/api/settings/web", json=values)
    assert r.status_code == 200, r.text


async def test_web_search_tool(authed, searxng):
    cid = await setup(authed)
    script("find otter facts", [TextDelta("no search"), Done("end")])
    await agent_turn(authed, cid, "find otter facts")
    assert "web_search" not in {t.name for t in FakeAdapter.requests[-1].tools}  # not set up

    await web_settings(authed, searxng_url="http://searx.lan/", search_results=5)
    script(
        "otters please",
        [call("web_search", query="otter tools", category="news"), Done("tool_use")],
        [TextDelta("Otters use tools."), Done("end")],
    )
    run_id = await agent_turn(authed, await new_chat(authed), "otters please")
    [result] = tool_results_sent_to_model()
    assert "[turn0search0] Otter facts" in result and "https://otters.example/raft" in result
    assert "Untrusted content" in result and searxng == ["otter tools"]
    [c] = (await timeline(authed, run_id))["tool_calls"]
    assert (
        c["status"] == "succeeded"
        and c["result_data"]["search"]["results"][0]["title"] == "Otter facts"
    )


async def test_read_web_page_is_blocked_on_the_private_network_unless_allowed(authed):
    cid = await setup(authed)
    async with web_server() as base:
        script(
            "read local page",
            [call("read_web_page", url=f"{base}/page"), Done("tool_use")],
            [TextDelta("ok"), Done("end")],
        )
        run_id = await agent_turn(authed, cid, "read local page")
        [c] = (await timeline(authed, run_id))["tool_calls"]
        assert c["status"] == "denied" and "private network" in c["decision_reason"]

        # Allowed in settings: the page is read (net.fetch defaults to "ask for dangerous";
        # your own network counts as moderate, so it runs without asking).
        await web_settings(authed, allowed_private_hosts=["127.0.0.1"])
        script(
            "read it now",
            [call("read_web_page", url=f"{base}/page"), Done("tool_use")],
            [TextDelta("Otters hold hands."), Done("end")],
        )
        run_id = await agent_turn(authed, await new_chat(authed), "read it now")
        [c] = (await timeline(authed, run_id))["tool_calls"]
        assert c["status"] == "succeeded" and c["risk"] == "moderate"
        assert c["result_data"]["web"]["title"] == "Otters in the Wild"
        [sent] = tool_results_sent_to_model()
        assert sent.startswith("# Otters in the Wild") and "hold hands" in sent


async def test_http_request_asks_first_and_reports_the_response(authed):
    cid = await setup(authed)
    await web_settings(authed, allowed_private_hosts=["127.0.0.0/8"])
    async with web_server() as base:
        script(
            "post it",
            [
                call(
                    "http_request",
                    method="POST",
                    url=f"{base}/echo",
                    headers={"Authorization": "Bearer abc", "Host": "evil"},
                    json_body={"hello": "world"},
                ),
                Done("tool_use"),
            ],
            [TextDelta("Posted."), Done("end")],
        )
        run_id = await agent_turn(authed, cid, "post it")
        [pending] = (await authed.get("/api/approvals")).json()
        assert pending["summary"].startswith("POST http://127.0.0.1")
        await authed.post(f"/api/approvals/{pending['id']}", json={"decision": "approve"})
        import uuid

        from app.runtime.dispatch import execute_run

        await execute_run(uuid.UUID(run_id))
        [c] = (await timeline(authed, run_id))["tool_calls"]
        assert c["status"] == "succeeded" and c["result_data"]["http"]["status"] == 201
        [sent] = tool_results_sent_to_model()
        assert sent.startswith("HTTP 201 Created")
        assert '\\"hello\\":\\"world\\"' in sent and "Bearer abc" in sent


async def test_web_settings_are_sensitive_and_validated(authed):
    bad = await authed.put("/api/settings/web", json={"searxng_url": "searx.lan"})
    assert bad.status_code == 422
    bad = await authed.put("/api/settings/web", json={"allowed_private_hosts": ["http://nas"]})
    assert bad.status_code == 422
    actions = [e["action"] for e in (await authed.get("/api/audit")).json()]
    await web_settings(authed, allowed_private_hosts=["nas.lan"])
    after = [e["action"] for e in (await authed.get("/api/audit")).json()]
    assert after.count("settings.update") == actions.count("settings.update") + 1
    assert (await authed.get("/api/web/status")).json()["search_configured"] is False


async def test_search_test_endpoint(authed, searxng):
    r = await authed.post("/api/web/test-search", json={"searxng_url": "http://searx.lan"})
    body = r.json()
    assert body["ok"] and len(body["results"]) == 2 and "Works" in body["message"]
    r = await authed.post("/api/web/test-search", json={})
    assert r.json() == {"ok": False, "message": "No SearXNG URL is set.", "results": []}
    r = await authed.post("/api/web/test-search", json={"searxng_url": "ftp://x"})
    assert not r.json()["ok"]


async def test_model_citation_markup_becomes_links(authed, searxng):
    cid = await setup(authed)
    await web_settings(authed, searxng_url="http://searx.lan")
    script(
        "cite otters",
        [call("web_search", query="otters"), Done("tool_use")],
        [TextDelta("Otters use tools. citeturn0search1"), Done("end")],
    )
    await agent_turn(authed, cid, "cite otters")
    [result] = tool_results_sent_to_model()
    assert "[turn0search0] Otter facts" in result and "[turn0search1] Raft" in result
    text = (await authed.get(f"/api/conversations/{cid}/messages")).json()[-1]["text"]
    assert text.startswith("Otters use tools. [[1]](https://otters.example/raft)")
    assert "**Sources**\n\n1. [Raft](https://otters.example/raft)" in text
