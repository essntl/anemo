"""What a shell tool's result repeats of the command (run_shell, computer_shell)."""

from app.tools.builtin.shell import ECHO_CHARS, command_echo


def test_a_one_line_command_is_repeated_as_it_is():
    assert command_echo("ls -la") == "ls -la"
    assert command_echo("  git status\n") == "git status"


def test_a_script_is_repeated_by_its_first_line():
    assert command_echo("cd app\nnpm ci\nnpm test") == "cd app … (2 more lines)"
    assert command_echo("cd app\nnpm test") == "cd app … (1 more line)"


def test_a_long_first_line_is_cut():
    echo = command_echo("echo " + "y" * 1000)
    assert echo == ("echo " + "y" * 1000)[:ECHO_CHARS] + "…"
