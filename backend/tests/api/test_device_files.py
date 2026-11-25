"""The device file tools (docs/specs/22-device-files.md, docs/device-contracts.md §8): the
permission category and the risks, who gets the tools, the live checks, the chunked
transfer with its hashes, the size limit, the overwrite rules both ways, and that a file
copied into the workspace is a revertible run file change.

The relay and the device lookup are fakes with the interface of features/devices/relay.py;
the fake computer speaks §8 over them, with files in memory."""

import base64
import hashlib
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from app.core.config import get_settings
from app.features.devices import relay
from app.features.devices import service as devices
from app.policy.engine import combine, evaluate
from app.policy.presets import CATEGORY_BY_CAP, PermissionSettings, compile_policy
from app.providers.adapters.fake import FakeAdapter
from app.providers.base import Done, TextDelta
from app.tools import registry
from app.tools.base import Tool, ToolContext
from app.tools.builtin import computer, device_files
from app.tools.builtin.device_files import DeviceFileGet, DeviceFilePut, GetInput, PutInput
from tests.api.test_agent import (
    agent_turn,
    call,
    run_status,
    script,
    setup,
    timeline,
    tool_results_sent_to_model,
)
from tests.api.test_notifications_automations import turn_context_sent
from tests.conftest import requires_db

pytestmark = requires_db

GET, PUT = DeviceFileGet(), DeviceFilePut()


@pytest.fixture(autouse=True)
def workspace():
    root = Path(get_settings().workspace_path)
    if root.exists():
        shutil.rmtree(root)
    (root / "notes").mkdir(parents=True)
    (root / "notes" / "todo.md").write_text("- a\n- b\n")
    FakeAdapter.scripts.clear()
    yield root


MB = 1024 * 1024


@dataclass
class FakeDevice:
    id: uuid.UUID
    name: str
    kind: str
    trust: str


@dataclass
class Transfer:
    path: str
    size: int
    sha256: str
    overwrite: bool
    data: bytearray = field(default_factory=bytearray)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeComputer:
    """The relay, the lookup, and one or more computers that answer §8's actions."""

    def __init__(self) -> None:
        self.rows: dict[str, FakeDevice] = {}
        self.offers: dict[uuid.UUID, relay.Offer] = {}
        self.files: dict[str, bytes] = {}  # what is on the computer, by its own path
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.transfers: dict[str, Transfer] = {}
        self.corrupt_reads = 0  # this many file_read answers carry a wrong byte
        self.change_after_stat: bytes | None = None  # the file changes after it was hashed
        self.fail_chunk_at: int | None = None  # file_write_chunk fails at this offset

    def add(
        self, name: str = "VM", trust: str = "trusted", *, files: bool = True, online: bool = True
    ) -> FakeDevice:
        device = FakeDevice(uuid.uuid4(), name, "computer", trust)
        self.rows[name.casefold()] = device
        if online:
            self.offers[device.id] = relay.Offer(control=True, shell=False, files=files)
        return device

    async def by_name(self, db: Any, name: str) -> FakeDevice | None:
        return self.rows.get(name.strip().casefold())

    async def online(self, device_id: uuid.UUID) -> relay.Offer | None:
        return self.offers.get(device_id)

    async def list_online(self) -> list[relay.DeviceInfo]:
        return [
            relay.DeviceInfo(
                id=d.id,
                name=d.name,
                kind="computer",
                trust=d.trust,  # type: ignore[arg-type]
                control=True,
                shell=False,
                files=self.offers[d.id].files,
            )
            for d in self.rows.values()
            if d.id in self.offers
        ]

    def actions(self) -> list[str]:
        return [action for action, _ in self.sent]

    async def send(
        self, device_id: uuid.UUID, action: str, fields: dict[str, Any], timeout_s: float = 90
    ) -> dict[str, Any]:
        self.sent.append((action, fields))
        if action == "file_stat":
            data = self.files.get(fields["path"])
            if data is None:
                raise relay.Missing("There is no such file.")
            state = {"kind": "file", "size": len(data), "sha256": _sha(data)}
            if self.change_after_stat is not None:
                self.files[fields["path"]] = self.change_after_stat
            return state
        if action == "file_read":
            data = self.files[fields["path"]]
            chunk = data[fields["offset"] : fields["offset"] + fields["length"]]
            digest = _sha(chunk)
            if self.corrupt_reads > 0:
                self.corrupt_reads -= 1
                chunk = bytes([chunk[0] ^ 1]) + chunk[1:]
            return {"data": base64.b64encode(chunk).decode(), "sha256": digest}
        if action == "file_write_begin":
            if fields["path"] in self.files and not fields["overwrite"]:
                raise relay.Exists("A file with that name is already there.")
            transfer = uuid.uuid4().hex
            self.transfers[transfer] = Transfer(
                fields["path"], fields["size"], fields["sha256"], fields["overwrite"]
            )
            return {"transfer": transfer, "chunk_bytes": 4 * MB}
        if action == "file_write_chunk":
            t = self.transfers[fields["transfer"]]
            if fields["offset"] == self.fail_chunk_at:
                raise relay.ActionFailed("The disk is full.")
            chunk = base64.b64decode(fields["data"])
            assert fields["offset"] == len(t.data) and _sha(chunk) == fields["sha256"]
            t.data += chunk
            return {"received": len(t.data)}
        if action == "file_write_end":
            t = self.transfers.pop(fields["transfer"])
            assert len(t.data) == t.size and _sha(bytes(t.data)) == t.sha256
            replaced = t.path in self.files
            self.files[t.path] = bytes(t.data)
            return {"path": t.path, "size": t.size, "sha256": t.sha256, "replaced": replaced}
        if action == "file_write_abort":
            self.transfers.pop(fields["transfer"], None)
            return {}
        raise relay.ActionFailed(f"Unknown action “{action}”")


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeComputer:
    f = FakeComputer()
    monkeypatch.setattr(relay, "online", f.online)
    monkeypatch.setattr(relay, "list_online", f.list_online)
    monkeypatch.setattr(relay, "send", f.send)
    monkeypatch.setattr(devices, "by_name", f.by_name)
    return f


class Changes:
    """What a run's record_change gets."""

    def __init__(self) -> None:
        self.recorded: list[dict[str, Any]] = []

    async def __call__(self, **change: Any) -> None:
        self.recorded.append(change)


async def _no_emit(*_: Any, **__: Any) -> None:
    return None


async def _ctx(changes: Changes | None = None) -> ToolContext:
    ctx = ToolContext(run_id=uuid.uuid4(), emit=_no_emit, record_change=changes or Changes())
    await computer.refresh(ctx)
    return ctx


def _decide(tool: Tool, args: Any, ctx: ToolContext, levels: dict[str, str]) -> str:
    policy = compile_policy(PermissionSettings(levels=levels))
    return combine([evaluate(a, policy) for a in tool.actions(args, ctx)]).decision


def _get(**fields: Any) -> GetInput:
    return GetInput(
        **(
            {
                "device": "VM",
                "device_path": "/home/me/report.pdf",
                "workspace_path": "inbox/report.pdf",
            }
            | fields
        )
    )


def _put(**fields: Any) -> PutInput:
    return PutInput(
        **(
            {"device": "VM", "workspace_path": "notes/todo.md", "device_path": "/home/me/todo.md"}
            | fields
        )
    )


def _blob(size: int) -> bytes:
    return bytes((i * 31 + 7) % 251 for i in range(size))


# -- the category, the risks, who gets the tools ----------------------------------------------


def test_the_category_and_its_default():
    category = CATEGORY_BY_CAP["device.files"]
    assert (category.label, category.default) == ("Files on your computers", "ask")
    assert {t.capability for t in device_files.DEVICE_FILE_TOOLS} == {"device.files"}
    assert device_files.DEVICE_FILE_TOOL_NAMES <= {t.name for t in registry.BUILTIN_TOOLS}


def test_the_tools_are_offered_with_the_computer_tools_only():
    policy = compile_policy(PermissionSettings())
    names = {t.name for t in registry.toolset_for("agent", policy, None)}
    assert not device_files.DEVICE_FILE_TOOL_NAMES & names
    names = {t.name for t in registry.toolset_for("agent", policy, None, has_computer=True)}
    assert device_files.DEVICE_FILE_TOOL_NAMES <= names
    never = compile_policy(PermissionSettings(levels={"device.files": "deny"}))
    names = {t.name for t in registry.toolset_for("agent", never, None, has_computer=True)}
    assert not device_files.DEVICE_FILE_TOOL_NAMES & names


async def test_risks_and_the_workspace_permissions(fake):
    vm = fake.add("VM")
    ctx = await _ctx()
    device, write = GET.actions(_get(), ctx)
    assert (device.capability, device.risk, device.resource) == (
        "device.files",
        "moderate",
        f"device:{vm.id}",
    )
    assert device.blocked is None
    assert (write.capability, write.risk, write.resource) == (
        "fs.write",
        "safe",
        "inbox/report.pdf",
    )
    # Replacing a workspace file is moderate, as for write_file.
    *_, replace = GET.actions(_get(workspace_path="notes/todo.md", overwrite=True), ctx)
    assert replace.risk == "moderate"
    device, read = PUT.actions(_put(), ctx)
    assert (device.risk, read.capability, read.resource) == ("moderate", "fs.read", "notes/todo.md")
    # Replacing a file on the computer is dangerous.
    (device, _) = PUT.actions(_put(overwrite=True), ctx)
    assert device.risk == "dangerous" and device.summary == "Replace /home/me/todo.md on VM"
    # The default asks; "ask for dangerous actions" copies freely but asks before a replace.
    assert _decide(PUT, _put(), ctx, {}) == "ask"
    assert (
        _decide(PUT, _put(), ctx, {"device.files": "ask_dangerous", "fs.read": "autonomous"})
        == "allow"
    )
    levels = {"device.files": "ask_dangerous", "fs.read": "autonomous"}
    assert _decide(PUT, _put(overwrite=True), ctx, levels) == "ask"
    # A workspace folder hidden from agents stays hidden.
    ctx.workspace.folders = {"notes": "none"}
    assert _decide(PUT, _put(), ctx, {"device.files": "autonomous"}) == "deny"


async def test_a_watched_computer_or_one_without_files_is_denied_without_asking(fake):
    fake.add("Desk PC", "watched")
    fake.add("Old PC", files=False)
    ctx = await _ctx()
    for name in ("Desk PC", "Old PC"):
        for tool, args in ((GET, _get(device=name)), (PUT, _put(device=name))):
            assert (
                _decide(tool, args, ctx, {"device.files": "autonomous", "fs.read": "autonomous"})
                == "deny"
            )
    assert "watched" in (GET.actions(_get(device="Desk PC"), ctx)[0].blocked or "")
    assert "doesn't offer files" in (GET.actions(_get(device="Old PC"), ctx)[0].blocked or "")


async def test_the_live_check_refuses_before_anything_is_sent(fake):
    ctx = await _ctx()  # nothing online when the step began: not blocked, checked live
    fake.add("Desk PC", "watched")
    fake.add("Old PC", files=False)
    fake.add("Laptop", online=False)
    watched = await GET.run(_get(device="Desk PC"), ctx)
    assert watched.is_error and "watched computer" in watched.content
    old = await PUT.run(_put(device="Old PC"), ctx)
    assert old.is_error and "Let Anemo read and write files" in old.content
    offline = await GET.run(_get(device="Laptop"), ctx)
    assert offline.is_error and "isn't connected" in offline.content
    unknown = await GET.run(_get(device="Nope"), ctx)
    assert unknown.is_error and "no computer named" in unknown.content
    assert fake.sent == []


# -- device_file_get -------------------------------------------------------------------------


async def test_a_file_comes_over_in_checked_chunks_and_is_recorded(fake, workspace):
    fake.add("VM")
    data = _blob(2 * MB + 12345)
    fake.files["/home/me/report.pdf"] = data
    changes = Changes()
    result = await GET.run(_get(), await _ctx(changes))
    assert not result.is_error, result.content
    assert (workspace / "inbox" / "report.pdf").read_bytes() == data
    reads = [f for a, f in fake.sent if a == "file_read"]
    assert [(r["offset"], r["length"]) for r in reads] == [
        (0, MB),
        (MB, MB),
        (2 * MB, 12345),
    ]
    assert fake.sent[0] == ("file_stat", {"path": "/home/me/report.pdf", "hash": True})
    assert changes.recorded == [
        {
            "op": "create",
            "path": "inbox/report.pdf",
            "before_hash": None,
            "after_hash": _sha(data),
            "backup_ref": None,
        }
    ]
    assert "untrusted" in result.content and "2.0 MB" in result.content


async def test_a_bad_chunk_is_asked_for_once_more_then_the_copy_stops(fake, workspace):
    fake.add("VM")
    fake.files["/home/me/report.pdf"] = _blob(3000)
    fake.corrupt_reads = 1
    assert not (await GET.run(_get(), await _ctx())).is_error
    assert fake.actions() == ["file_stat", "file_read", "file_read"]

    fake.sent.clear()
    fake.corrupt_reads = 2
    changes = Changes()
    result = await GET.run(_get(workspace_path="inbox/again.pdf"), await _ctx(changes))
    assert result.is_error and "SHA-256" in result.content
    assert not (workspace / "inbox" / "again.pdf").exists() and changes.recorded == []


async def test_a_file_that_changes_while_it_is_copied_is_not_saved(fake, workspace):
    fake.add("VM")
    fake.files["/home/me/report.pdf"] = b"first version"
    fake.change_after_stat = b"other version"  # the same size, other bytes
    result = await GET.run(_get(), await _ctx())
    assert result.is_error and "changed on VM while it was copied" in result.content
    assert not (workspace / "inbox" / "report.pdf").exists()


async def test_the_size_limit_is_checked_before_reading(authed, fake, workspace):
    fake.add("VM")
    fake.files["/home/me/big.iso"] = _blob(2 * MB)
    r = await authed.put("/api/settings/files", json={"device_file_max_mb": 1})
    assert r.status_code == 200, r.text
    result = await GET.run(_get(device_path="/home/me/big.iso"), await _ctx())
    assert result.is_error and "more than the 1.0 MB" in result.content
    assert fake.actions() == ["file_stat"]
    # And for a put: the workspace file is too large to send.
    (workspace / "out").mkdir()
    (workspace / "out" / "big.bin").write_bytes(_blob(MB + 1))
    result = await PUT.run(_put(workspace_path="out/big.bin"), await _ctx())
    assert result.is_error and "larger than the 1.0 MB" in result.content
    assert fake.actions() == ["file_stat"]
    # The limit's own bounds.
    assert (
        await authed.put("/api/settings/files", json={"device_file_max_mb": 201})
    ).status_code == 422
    await authed.put("/api/settings/files", json={"device_file_max_mb": 50})


async def test_a_workspace_file_is_replaced_only_when_asked_and_revertibly(fake, workspace):
    fake.add("VM")
    fake.files["/home/me/todo.md"] = b"from the computer"
    refused = await GET.run(
        _get(device_path="/home/me/todo.md", workspace_path="notes/todo.md"), await _ctx()
    )
    assert refused.is_error and "already exists in the workspace" in refused.content
    assert fake.sent == []  # refused before the device was asked anything
    changes = Changes()
    args = _get(device_path="/home/me/todo.md", workspace_path="notes/todo.md", overwrite=True)
    assert not (await GET.run(args, await _ctx(changes))).is_error
    assert (workspace / "notes" / "todo.md").read_bytes() == b"from the computer"
    (change,) = changes.recorded
    assert change["op"] == "modify" and change["backup_ref"].startswith("backup:")


async def test_a_missing_file_or_a_folder_is_said_so(fake, workspace):
    fake.add("VM")
    missing = await GET.run(_get(device_path="/home/me/nothing.txt"), await _ctx())
    assert missing.is_error and "There is no file /home/me/nothing.txt on VM" in missing.content


# -- device_file_put -------------------------------------------------------------------------


async def test_a_workspace_file_goes_over_in_checked_chunks(fake, workspace):
    fake.add("VM")
    data = _blob(MB + 10)
    (workspace / "out").mkdir()
    (workspace / "out" / "data.bin").write_bytes(data)
    result = await PUT.run(
        _put(workspace_path="out/data.bin", device_path="/home/me/data.bin"), await _ctx()
    )
    assert not result.is_error, result.content
    assert fake.files["/home/me/data.bin"] == data
    assert fake.actions() == [
        "file_write_begin",
        "file_write_chunk",
        "file_write_chunk",
        "file_write_end",
    ]
    begin = fake.sent[0][1]
    assert begin == {
        "path": "/home/me/data.bin",
        "size": MB + 10,
        "sha256": _sha(data),
        "overwrite": False,
    }
    assert "replaced" not in result.content


async def test_a_file_on_the_computer_is_replaced_only_with_overwrite(fake, workspace):
    fake.add("VM")
    fake.files["/home/me/todo.md"] = b"mine"
    refused = await PUT.run(_put(), await _ctx())
    assert refused.is_error and "already exists on VM" in refused.content
    assert fake.files["/home/me/todo.md"] == b"mine"
    replaced = await PUT.run(_put(overwrite=True), await _ctx())
    assert not replaced.is_error and "replaced the file that was there" in replaced.content
    assert fake.files["/home/me/todo.md"] == (workspace / "notes" / "todo.md").read_bytes()
    assert fake.sent[-3] == ("file_write_begin", fake.sent[-3][1])
    assert fake.sent[-3][1]["overwrite"] is True


async def test_a_failed_chunk_aborts_the_transfer(fake, workspace):
    fake.add("VM")
    (workspace / "out").mkdir()
    (workspace / "out" / "data.bin").write_bytes(_blob(2 * MB))
    fake.fail_chunk_at = MB
    result = await PUT.run(
        _put(workspace_path="out/data.bin", device_path="/home/me/data.bin"), await _ctx()
    )
    assert result.is_error and "The disk is full" in result.content
    assert fake.actions() == [
        "file_write_begin",
        "file_write_chunk",
        "file_write_chunk",
        "file_write_abort",
    ]
    assert fake.transfers == {} and "/home/me/data.bin" not in fake.files


# -- whole runs -------------------------------------------------------------------------------


async def test_an_agent_copies_a_file_in_and_the_user_can_revert_it(authed, fake, workspace):
    fake.add("VM")
    fake.files["C:\\Users\\me\\report.txt"] = b"quarterly numbers"
    cid = await setup(authed, **{"device.files": "autonomous", "fs.write": "autonomous"})
    script(
        "fetch the report",
        [
            call(
                "device_file_get",
                device="VM",
                device_path="C:\\Users\\me\\report.txt",
                workspace_path="inbox/report.txt",
            ),
            Done("tool_use"),
        ],
        [TextDelta("Fetched."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "fetch the report")
    assert await run_status(authed, run_id) == "completed"
    assert (
        "- VM: computer, trusted, control allowed, PowerShell off, files on" in turn_context_sent()
    )
    assert device_files.DEVICE_FILE_TOOL_NAMES <= {t.name for t in FakeAdapter.requests[-1].tools}
    assert (
        "Copied C:\\Users\\me\\report.txt from VM to inbox/report.txt"
        in tool_results_sent_to_model()[-1]
    )
    (change,) = (await timeline(authed, run_id))["file_changes"]
    assert (change["op"], change["path"]) == ("create", "inbox/report.txt")
    r = await authed.post(f"/api/runs/{run_id}/files/{change['id']}/revert")
    assert r.status_code == 200, r.text
    assert not (workspace / "inbox" / "report.txt").exists()


async def test_a_client_without_files_gets_no_files_line_and_no_transfer(authed, fake, workspace):
    fake.add("VM", files=False)
    cid = await setup(authed, **{"device.files": "autonomous", "fs.write": "autonomous"})
    script(
        "fetch the report",
        [
            call("device_file_get", device="VM", device_path="/x", workspace_path="x"),
            Done("tool_use"),
        ],
        [TextDelta("Could not."), Done("end")],
    )
    run_id = await agent_turn(authed, cid, "fetch the report")
    assert await run_status(authed, run_id) == "completed"
    context = turn_context_sent()
    assert "- VM: computer, trusted" in context and "files on" not in context.split("- VM:")[1]
    (c,) = (await timeline(authed, run_id))["tool_calls"]
    assert c["decision"] == "deny"
    assert fake.sent == []


def test_device_paths_are_opaque_but_never_hold_control_characters():
    assert _get(device_path="/Users/me/ünïcode ✓.txt").device_path == "/Users/me/ünïcode ✓.txt"
    with pytest.raises(ValueError):
        _get(device_path="/home/me/a\x00b")
    with pytest.raises(ValueError):
        _put(device_path="C:\\a\nb")


def test_chunks_fit_the_frame_limits():
    # base64 of a chunk plus the JSON around it stays far below the 12 MB a device's answer
    # may have and the 16 MB a command to a 1.7.0 client may have.
    assert device_files.CHUNK_BYTES * 4 / 3 + 1000 < 12 * MB
