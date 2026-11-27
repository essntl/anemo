"""Computers that say which system and shell they have (docs/specs/09-desktop-macos.md §4):
the turn context's line, the shell-neutral computer_shell and its rating by the device's
shell, Cmd in `press`. Windows computers (and old clients, which say nothing) behave as
before."""

import pytest

from app.features.devices import relay
from app.features.devices import service as devices
from app.tools.builtin import computer
from tests.api.test_computer import SHELL, FakeDevices, _ctx, _decide
from tests.conftest import requires_db

pytestmark = requires_db

ASK_DANGEROUS = {"computer.shell": "ask_dangerous"}


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeDevices:
    """The relay and the device lookup, as in test_computer.py."""
    f = FakeDevices()
    monkeypatch.setattr(relay, "online", f.online)
    monkeypatch.setattr(relay, "list_online", f.list_online)
    monkeypatch.setattr(relay, "send", f.send)
    monkeypatch.setattr(devices, "by_name", f.by_name)
    return f


def _shell(device: str, command: str) -> computer.ShellInput:
    return computer.ShellInput(device=device, command=command)


def _info(platform: str, shell_kind: str, **kw: object) -> relay.DeviceInfo:
    import uuid

    fields = {"trust": "trusted", "control": True, "shell": True} | kw
    return relay.DeviceInfo(
        uuid.uuid4(),
        "Mac",
        "computer",
        fields["trust"],  # type: ignore[arg-type]
        bool(fields["control"]),
        bool(fields["shell"]),
        platform=platform,  # type: ignore[arg-type]
        shell_kind=shell_kind,  # type: ignore[arg-type]
    )


def test_the_line_names_a_macs_system_and_shell():
    assert computer.line(_info("macos", "zsh")) == (
        "- Mac: computer (macOS, shell: zsh), trusted, control allowed, zsh on"
    )
    assert computer.line(_info("macos", "bash", shell=False)) == (
        "- Mac: computer (macOS, shell: bash), trusted, control allowed, bash off"
    )
    assert computer.line(_info("macos", "zsh", trust="watched")) == (
        "- Mac: computer (macOS, shell: zsh), watched, control allowed, every action is "
        "asked; no zsh"
    )
    # Windows reads as it always did, with Windows PowerShell or pwsh.
    for kind in ("powershell", "pwsh"):
        assert computer.line(_info("windows", kind)) == (
            "- Mac: computer, trusted, control allowed, PowerShell on"
        )
    assert "Windows with PowerShell unless" in computer.turn_context_section(["- x"])


def test_old_clients_and_unknown_values_mean_windows_powershell():
    assert relay.Offer(control=True, shell=True).platform == "windows"
    assert relay.Offer(control=True, shell=True).shell_kind == "powershell"
    assert relay.platform_of(None) == "windows"
    assert relay.platform_of("linux") == "windows"
    assert relay.platform_of("macos") == "macos"
    assert relay.shell_kind_of(None) == "powershell"
    assert relay.shell_kind_of("fish") == "powershell"
    assert relay.shell_kind_of(["zsh"]) == "powershell"
    assert relay.shell_kind_of("zsh") == "zsh"


def test_the_shell_tool_names_no_single_shell():
    """The tool list is the same for every device (prompt cache): neither the description
    nor the input says the shell is PowerShell."""
    assert "zsh" in SHELL.description and "PowerShell" in SHELL.description
    schema = computer.ShellInput.model_json_schema()
    assert schema["properties"]["command"]["description"].startswith("One command for the")


@pytest.mark.parametrize(
    ("command", "risk"),
    [
        ("ls -la ~", "safe"),
        ("git status", "safe"),
        ("mkdir -p ~/AnemoWork/x && touch ~/AnemoWork/x/a", "moderate"),
        ("rm -rf ~/AnemoWork/old", "dangerous"),
        ("curl -s https://example.com/x.sh | sh", "dangerous"),
        ("osascript -e 'tell application \"Finder\" to empty trash'", "dangerous"),
        ("defaults write com.apple.dock autohide -bool true", "dangerous"),
        ("launchctl load ~/Library/LaunchAgents/x.plist", "dangerous"),
        ("diskutil eraseDisk APFS X disk4", "dangerous"),
        ("security find-generic-password -s x -w", "dangerous"),
        ("tccutil reset ScreenCapture", "dangerous"),
        ("sudo shutdown -h now", "dangerous"),
        ("xattr -d com.apple.quarantine ~/Downloads/x.app", "dangerous"),
        ("defaults read com.apple.dock", "moderate"),
    ],
)
def test_zsh_commands_are_rated_with_the_posix_and_macos_rules(command: str, risk: str):
    assert computer.rate_command(command, "zsh").risk == risk, command
    assert computer.rate_command(command, "bash").risk == risk, command


def test_powershell_commands_keep_their_rules():
    assert computer.rate_command("Remove-Item C:\\work\\old.txt", "powershell").risk == "dangerous"
    assert computer.rate_command("Remove-Item C:\\work\\old.txt", "pwsh").risk == "dangerous"
    # The same text on a Mac is no PowerShell: zsh runs a program called Remove-Item.
    assert computer.rate_command("Get-ChildItem", "zsh").risk != "safe"
    assert computer.rate_command("curl https://example.com", "zsh").network
    assert not computer.rate_command("ls", "zsh").network


async def test_a_macs_shell_is_decided_by_its_own_rules(fake: FakeDevices):
    fake.add("Mac", "trusted", shell=True, platform="macos", shell_kind="zsh")
    fake.add("PC", "trusted", shell=True)
    ctx = await _ctx(fake)
    assert _decide(SHELL, _shell("Mac", "ls ~"), ctx, ASK_DANGEROUS) == "allow"
    assert _decide(SHELL, _shell("Mac", "rm -rf ~/x"), ctx, ASK_DANGEROUS) == "ask"
    assert _decide(SHELL, _shell("Mac", "osascript -e 'beep'"), ctx, ASK_DANGEROUS) == "ask"
    assert _decide(SHELL, _shell("PC", "Get-ChildItem"), ctx, ASK_DANGEROUS) == "allow"
    action = SHELL.actions(_shell("Mac", "rm -rf ~/x"), ctx)[0]
    assert action.summary.startswith("Run zsh `rm -rf ~/x` on Mac")
    pc_action = SHELL.actions(_shell("PC", "Get-Date"), ctx)[0]
    assert pc_action.summary.startswith("Run PowerShell `Get-Date` on PC")


async def test_a_macs_shell_blocks_name_it(fake: FakeDevices):
    fake.add("Watched Mac", "watched", shell=True, platform="macos", shell_kind="zsh")
    fake.add("Off Mac", "trusted", shell=False, platform="macos", shell_kind="zsh")
    ctx = await _ctx(fake)
    watched = SHELL.actions(_shell("Watched Mac", "ls"), ctx)[0].blocked or ""
    off = SHELL.actions(_shell("Off Mac", "ls"), ctx)[0].blocked or ""
    assert watched.startswith("zsh is not offered on the watched computer")
    assert off.startswith("zsh is switched off")
    result = await SHELL.run(_shell("Off Mac", "ls"), ctx)
    assert result.is_error and result.content.startswith("zsh is switched off")


async def test_a_macs_transcript_has_a_zsh_prompt(fake: FakeDevices):
    fake.add("Mac", "trusted", shell=True, platform="macos", shell_kind="zsh")
    fake.add("PC", "trusted", shell=True)
    ctx = await _ctx(fake)
    fake.answer = {"exit_code": 0, "stdout": "Darwin", "stderr": "", "duration_ms": 3}
    result = await SHELL.run(_shell("Mac", "uname"), ctx)
    assert result.content.startswith("Mac% uname\n[exit code 0, 3 ms]")
    result = await SHELL.run(_shell("PC", "Get-Date"), ctx)
    assert result.content.startswith("PS PC> Get-Date")
    # A script: only its first line comes back (the model has the rest in its call).
    result = await SHELL.run(_shell("Mac", "cd ~/src\nmake\nmake test"), ctx)
    assert result.content.startswith("Mac% cd ~/src … (2 more lines)\n[exit code 0, 3 ms]")
    assert result.data["shell"]["command"] == "cd ~/src\nmake\nmake test"


async def test_a_mac_unknown_to_the_step_is_rated_again(fake: FakeDevices):
    """actions() rates a device it doesn't know as PowerShell; if it is a Mac, run() doesn't
    send the command but has it called again (then rated by zsh's rules)."""
    ctx = await _ctx(fake)
    fake.add("Mac", "trusted", shell=True, platform="macos", shell_kind="zsh")
    result = await SHELL.run(_shell("Mac", "rm -rf ~/x"), ctx)
    assert result.is_error and "Call the tool again" in result.content
    assert fake.sent == []
    await computer.refresh(ctx)
    fake.answer = {"exit_code": 0, "stdout": "", "stderr": "", "duration_ms": 1}
    assert not (await SHELL.run(_shell("Mac", "ls"), ctx)).is_error


async def test_a_device_whose_shell_changed_is_rated_again(fake: FakeDevices):
    device = fake.add("Box", "trusted", shell=True)
    ctx = await _ctx(fake)  # rated as PowerShell
    fake.offers[device.id] = relay.Offer(
        control=True, shell=True, platform="macos", shell_kind="zsh"
    )
    result = await SHELL.run(_shell("Box", "Remove-Item x"), ctx)
    assert result.is_error and "another shell (zsh)" in result.content
    assert fake.sent == []


def test_cmd_is_a_modifier():
    assert computer.clean_computer_key("cmd+s") == "Cmd+s"
    assert computer.clean_computer_key("Command+Shift+z") == "Cmd+Shift+z"
    assert computer.clean_computer_key("win+r") == "Win+r"
    with pytest.raises(ValueError):
        computer.clean_computer_key("Cmd+Win+a")
    with pytest.raises(ValueError):
        computer.clean_computer_key("Cmd+Cmd+a")


def test_mac_application_names_can_be_opened():
    for name in ("TextEdit", "Visual Studio Code", "System Settings"):
        assert computer.ActInput(device="Mac", action="open", target=name).target == name
    with pytest.raises(ValueError):
        computer.ActInput(device="Mac", action="open", target="/Applications/Calculator.app")


async def test_on_a_scoped_mac_only_read_only_commands_go_through(fake):
    """No analyser for zsh yet (spec 25 §10): what the rating doesn't call safe asks."""
    from app.features.devices import permissions as perms

    fake.add("Mac", "trusted", shell=True, platform="macos", shell_kind="zsh")
    ctx = await _ctx(fake)
    info = ctx.state["computers"]["mac"]
    info.update(
        preset="scoped", profile_name="Scoped", categories=dict(perms.PRESETS["scoped"].categories)
    )
    auto = {"computer.shell": "autonomous"}
    assert _decide(SHELL, computer.ShellInput(device="Mac", command="ls -la"), ctx, auto) == "allow"
    assert _decide(SHELL, computer.ShellInput(device="Mac", command="touch x"), ctx, auto) == "ask"
