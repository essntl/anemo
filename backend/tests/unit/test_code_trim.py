"""Trimming one Claude Code event (docs/specs/code-sessions.md §6)."""

import copy

from app.features.code_sessions import trim


def _bash_result(output: str) -> dict:
    return {
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {"tool_use_id": "toolu_01", "type": "tool_result", "content": output},
            ],
        },
        "parent_tool_use_id": None,
        "session_id": "s-1",
        "tool_use_result": {"stdout": output, "stderr": "", "interrupted": False},
    }


def test_a_small_event_is_kept_as_it_is():
    event = {"type": "assistant", "message": {"content": [{"type": "text", "text": "Hi"}]}}
    stored, trimmed = trim.trim(event)
    assert stored == event and trimmed is False


def test_step_1_removes_known_copies_even_when_small():
    read = {
        "type": "user",
        "tool_use_result": {
            "type": "text",
            "file": {"filePath": "C:\\dev\\a.py", "content": "print(1)\n", "numLines": 1},
        },
    }
    stored, trimmed = trim.trim(read)
    assert trimmed is True
    assert stored["tool_use_result"]["file"] == {"filePath": "C:\\dev\\a.py", "numLines": 1}

    edit = {"type": "user", "tool_use_result": {"filePath": "a.py", "originalFile": "old"}}
    stored, trimmed = trim.trim(edit)
    assert trimmed is True and stored["tool_use_result"] == {"filePath": "a.py"}

    write = {
        "type": "user",
        "tool_use_result": {"type": "create", "filePath": "b.py", "content": "x = 1\n"},
    }
    stored, trimmed = trim.trim(write)
    assert trimmed is True and stored["tool_use_result"] == {"type": "create", "filePath": "b.py"}

    # `content` of another tool's result is not a copy.
    other = {"type": "user", "tool_use_result": {"type": "text", "content": "kept"}}
    assert trim.trim(other) == (other, False)
    # The event passed in is never changed.
    assert read["tool_use_result"]["file"]["content"] == "print(1)\n"


def test_step_2_cuts_long_strings_to_1500_and_400():
    long = "a" * 1500 + "b" * 17_000 + "c" * 400
    stored, trimmed = trim.trim(_bash_result(long))
    assert trimmed is True
    text = stored["message"]["content"][0]["content"]
    assert text == "a" * 1500 + "\n… [17000 characters trimmed] …\n" + "c" * 400
    assert stored["tool_use_result"]["stdout"] == text
    assert trim.size(stored) <= trim.LIMIT
    # Strings of up to 2000 characters stay.
    assert stored["session_id"] == "s-1"


def test_step_3_cuts_harder_when_step_2_was_not_enough():
    # Ten strings of 3000 characters: about 19 400 bytes after step 2.
    event = {"type": "assistant", "parts": [chr(ord("a") + i) * 3000 for i in range(10)]}
    stored, trimmed = trim.trim(event)
    assert trimmed is True
    first = stored["parts"][0]
    assert first == "a" * 400 + "\n… [2500 characters trimmed] …\n" + "a" * 100
    assert trim.size(stored) <= trim.LIMIT
    # A string of 600 characters or fewer is kept at step 3 too.
    event["parts"].append("z" * 600)
    stored, _ = trim.trim(event)
    assert stored["parts"][-1] == "z" * 600


def test_step_4_leaves_a_stub_with_the_tool_calls():
    calls = [
        {"type": "tool_use", "id": f"toolu_{i}", "name": "Bash", "input": {"c": "x" * 590}}
        for i in range(40)
    ]
    event = {
        "type": "assistant",
        "subtype": "x",
        "message": {"content": [{"type": "text", "text": "y" * 590}, *calls]},
    }
    stored, trimmed = trim.trim(event)
    assert trimmed is True
    assert stored == {
        "type": "assistant",
        "subtype": "x",
        "anemo_trimmed": "too large",
        "message": {
            "content": [{"type": "tool_use", "name": "Bash", "id": f"toolu_{i}"} for i in range(40)]
        },
    }
    # Without tool calls: only the type.
    plain = {"type": "user", "items": ["q" * 590] * 40}
    assert trim.trim(plain) == ({"type": "user", "anemo_trimmed": "too large"}, True)


def test_size_counts_utf8_bytes_of_compact_json():
    assert trim.size({"a": "é"}) == len('{"a":"é"}'.encode())
    assert trim.size({"a": [1, 2]}) == len('{"a":[1,2]}')


def test_multibyte_text_is_measured_in_bytes():
    # 6000 characters of three bytes each (18 000 bytes) in one string: step 2 cuts it.
    event = {"type": "assistant", "text": "€" * 6000}
    stored, trimmed = trim.trim(event)
    assert trimmed is True and trim.size(stored) <= trim.LIMIT
    assert stored["text"].startswith("€" * 1500)


def test_clean_makes_an_event_storable():
    event = {"type": "raw", "text": "a\x00b\ud800c", "k\x00": [{"deep": "ok"}]}
    before = copy.deepcopy(event)
    cleaned = trim.clean(event)
    assert cleaned == {"type": "raw", "text": "a\ufffdb\ufffdc", "k\ufffd": [{"deep": "ok"}]}
    assert event == before
    deep: dict = {}
    node = deep
    for _ in range(trim.MAX_DEPTH + 5):
        node["x"] = {}
        node = node["x"]
    cleaned = trim.clean(deep)
    depth = 0
    while isinstance(cleaned, dict):
        cleaned = cleaned["x"]
        depth += 1
    assert cleaned == trim.TOO_DEEP and depth == trim.MAX_DEPTH
