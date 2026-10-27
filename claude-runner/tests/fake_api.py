"""A scripted stand-in for the Anthropic Messages API, for driving the real Claude
Code CLI in tests without any account. It records every request body, so tests can
check exactly what Claude Code would send (tools, system prompt, cache prefix).

Replies come from a queue (`FakeApi.replies`); each is (blocks, stop_reason). When
the queue is empty it answers with a short text. Usage figures are made up but
follow the API's shape: the prefix that matches the previous request counts as a
cache read, the rest as a cache write, which lets tests see prefix stability.
"""

import json
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def text(t: str) -> dict[str, Any]:
    return {"type": "text", "text": t}


def tool_use(id_: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"type": "tool_use", "id": id_, "name": f"mcp__anemo__{name}", "input": args}


def _prefix_chars(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


class FakeApi:
    def __init__(self, word_delay: float = 0.0) -> None:
        self.word_delay = word_delay  # seconds between streamed words (streaming tests)
        self.replies: deque[tuple[list[dict[str, Any]], str]] = deque()
        self.requests: list[dict[str, Any]] = []  # /v1/messages bodies, in order
        self.lock = threading.Lock()
        self._last_prompt = ""
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                self.send_response(404)
                self.send_header("content-length", "0")
                self.end_headers()

            def do_POST(self) -> None:  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("content-length", 0)))
                body = json.loads(raw or b"{}")
                if not self.path.startswith("/v1/messages") or "count_tokens" in self.path:
                    out = json.dumps({"input_tokens": 10}).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
                    return
                api.handle(self, body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> "FakeApi":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()

    def main_requests(self) -> list[dict[str, Any]]:
        """Requests of the conversation itself (with tools or a system prompt)."""
        return [r for r in self.requests if r.get("messages")]

    def handle(self, h: BaseHTTPRequestHandler, body: dict[str, Any]) -> None:
        with self.lock:
            self.requests.append(body)
            blocks, stop = self.replies.popleft() if self.replies else ([text("ok")], "end_turn")
            prompt = json.dumps([body.get("tools"), body.get("system"), body.get("messages")])
            read = _prefix_chars(prompt, self._last_prompt) // 4
            total = len(prompt) // 4
            self._last_prompt = prompt
            n = len(self.requests)
        usage = {
            "input_tokens": 3,
            "cache_read_input_tokens": read,
            "cache_creation_input_tokens": max(total - read - 3, 0),
            "output_tokens": 1,
        }
        if not body.get("stream"):
            out = json.dumps({"id": f"msg_{n}", "type": "message", "role": "assistant",
                              "model": body.get("model"), "content": blocks,
                              "stop_reason": stop, "usage": usage}).encode()
            h.send_response(200)
            h.send_header("content-type", "application/json")
            h.send_header("content-length", str(len(out)))
            h.end_headers()
            h.wfile.write(out)
            return
        h.send_response(200)
        h.send_header("content-type", "text/event-stream")
        h.send_header("connection", "close")
        h.end_headers()

        def sse(event: str, data: dict[str, Any]) -> None:
            h.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            h.wfile.flush()

        sse("message_start", {"type": "message_start", "message": {
            "id": f"msg_{n}", "type": "message", "role": "assistant", "model": body.get("model"),
            "content": [], "stop_reason": None, "usage": usage}})
        for i, b in enumerate(blocks):
            if b["type"] == "text":
                sse("content_block_start", {"type": "content_block_start", "index": i,
                                            "content_block": {"type": "text", "text": ""}})
                for word in b["text"].split(" "):
                    sse("content_block_delta", {"type": "content_block_delta", "index": i,
                                                "delta": {"type": "text_delta", "text": word + " "}})
                    if self.word_delay:
                        time.sleep(self.word_delay)
            else:
                sse("content_block_start", {"type": "content_block_start", "index": i,
                                            "content_block": {"type": "tool_use", "id": b["id"],
                                                              "name": b["name"], "input": {}}})
                sse("content_block_delta", {"type": "content_block_delta", "index": i,
                                            "delta": {"type": "input_json_delta",
                                                      "partial_json": json.dumps(b["input"])}})
            sse("content_block_stop", {"type": "content_block_stop", "index": i})
        sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop},
                              "usage": {"output_tokens": 7}})
        sse("message_stop", {"type": "message_stop"})
        h.close_connection = True
