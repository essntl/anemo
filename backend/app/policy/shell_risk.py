"""Rates how risky a shell command is, without running it: safe, moderate or dangerous.

The rating feeds the permission engine (e.g. "Ask for dangerous actions" lets
moderate commands run but asks before dangerous ones). It is a heuristic and is
built to err upwards: anything it doesn't understand is at least moderate, and
anything it can't parse, or whose command name is computed at runtime, is
dangerous. The real protection is the sandbox container; this only decides when
to ask the user first.

  safe       only reads: ls, cat, grep, git status, find without actions, ...
  moderate   changes things in the usual way: builds, installs, writes files, git commit
  dangerous  hard to undo or hides what runs: rm -r, git push --force, git reset --hard,
             dd, curl ... | sh, eval, $(...) as a command name, sudo, ...

Deletes inside the workspace scratch folder (docs/specs/25-device-permission-profiles.md
§0) are moderate instead: `rm`, `find ... -delete` and `git clean` whose paths are all
literal and, resolved against the working folder (the call's cwd plus literal `cd X &&`),
fall inside `scratch/`. The caller passes a `DeleteScope` that knows where scratch is and
resolves symlinks (this module does no IO). Anything less certain keeps today's rating.
"""

import posixpath
import re
import shlex
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from app.policy.models import Risk

_ORDER: dict[Risk, int] = {"safe": 0, "moderate": 1, "dangerous": 2}
MAX_LENGTH = 20_000
MAX_DEPTH = 3  # nested `bash -c` / $(...) levels we follow

SEPARATORS = {";", "&&", "||", "|", "&", "\n", "(", ")", "|&", ";;"}
REDIRECTS = {">", ">>", "<", "<<", "<<<", ">&", "&>", "&>>", ">|", "<&", "<>"}
GROUPING = {"{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "fi", "done"}

SAFE = {
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "pwd",
    "echo",
    "printf",
    "which",
    "type",
    "file",
    "stat",
    "du",
    "df",
    "tree",
    "sort",
    "uniq",
    "cut",
    "tr",
    "date",
    "whoami",
    "journalctl",
    "id",
    "uname",
    "printenv",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "diff",
    "cmp",
    "md5sum",
    "sha1sum",
    "sha256sum",
    "jq",
    "true",
    "false",
    "test",
    "[",
    "[[",
    "seq",
    "nl",
    "column",
    "hostname",
    "uptime",
    "ps",
    "free",
    "locale",
    "cd",
    "less",
    "more",
    "sleep",
    "nproc",
    "lsof",
    "env",
    "history",
    "ldd",
    "od",
    "xxd",
    "hexdump",
    "strings",
    "fold",
    "fmt",
    "comm",
    "join",
    "paste",
    "rev",
    "tac",
    "look",
    "expr",
    "bc",
    "cal",
    "tty",
    "groups",
    "arch",
    "getconf",
    "pgrep",
    "top",
    "htop",
}
# Always dangerous, whatever the arguments.
DANGEROUS = {
    "sudo",
    "su",
    "doas",
    "dd",
    "fdisk",
    "sfdisk",
    "parted",
    "shred",
    "wipefs",
    "mount",
    "umount",
    "reboot",
    "shutdown",
    "halt",
    "poweroff",
    "eval",
    "chroot",
    "iptables",
    "crontab",
    "truncate",
    "srm",
    "mkswap",
    "swapon",
    "insmod",
    "rmmod",
    "modprobe",
    "setfacl",
    "chattr",
    "nsenter",
    "unshare",
    "pkexec",
}
DANGEROUS_PREFIXES = ("mkfs",)
# Programs that run what they read on stdin when given no script: `curl ... | sh`.
INTERPRETERS = {
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "python",
    "python3",
    "perl",
    "ruby",
    "node",
    "php",
    "lua",
    "tclsh",
    "source",
    ".",
}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
# Commands that run another command: we look through them at the real one.
WRAPPERS = {
    "env",
    "nice",
    "nohup",
    "time",
    "timeout",
    "command",
    "builtin",
    "exec",
    "xargs",
    "stdbuf",
    "ionice",
    "caffeinate",
    "watch",
    "strace",
    "ltrace",
    "chronic",
}
WRAPPER_VALUE_OPTS = {  # options that take a separate value we must skip
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "nice": {"-n", "--adjustment"},
    "xargs": {"-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"},
    "env": {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"},
    "ionice": {"-c", "-n", "-p"},
    "stdbuf": {"-i", "-o", "-e"},
    "watch": {"-n", "--interval"},
}

GIT_SAFE = {
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "ls-files",
    "ls-tree",
    "rev-parse",
    "describe",
    "shortlog",
    "grep",
    "reflog",
    "cat-file",
    "whatchanged",
    "help",
    "version",
    "remote",
    "config",
    "tag",
    "branch",
    "stash",
    "worktree",
    "fetch",
}
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_FUNCTION_DEF = re.compile(r"(^|[\s;&|{])(function\s+\S+|[^\s();|&$<>=]+\s*\(\s*\))\s*\{")
_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


@dataclass
class ShellRisk:
    risk: Risk = "safe"
    reasons: list[str] = field(default_factory=list)

    def raise_to(self, risk: Risk, reason: str | None = None) -> None:
        if _ORDER[risk] > _ORDER[self.risk]:
            self.risk = risk
        if reason and risk != "safe" and reason not in self.reasons:
            self.reasons.append(reason)

    @property
    def summary(self) -> str:
        return "; ".join(self.reasons)


Where = Literal["inside", "root", "outside"]


@dataclass(frozen=True)
class DeleteScope:
    """Where deletes need no approval: the workspace scratch folder.

    `cwd` is the command's working folder as an absolute path in the sandbox
    ("/workspace/notes"). `where` gets an absolute path that may still contain `..` and
    links, resolves it, and says whether it is strictly inside scratch, scratch itself
    ("root"), or anywhere else. It must answer "outside" whenever it is unsure.
    """

    cwd: str
    where: Callable[[str], Where]


def classify(command: str, scope: DeleteScope | None = None) -> ShellRisk:
    result = ShellRisk()
    _classify(command, result, depth=0, scope=scope)
    return result


def _classify(
    command: str, result: ShellRisk, depth: int, scope: DeleteScope | None = None
) -> None:
    if depth > MAX_DEPTH:
        result.raise_to("dangerous", "too deeply nested to check")
        return
    if "\x00" in command or len(command) > MAX_LENGTH:
        result.raise_to("dangerous", "not a normal command")
        return
    command = _strip_heredoc_bodies(command)
    if _FUNCTION_DEF.search(command):
        result.raise_to("dangerous", "defines a shell function")
    if "`" in command:
        result.raise_to("dangerous", "uses backtick command substitution")
    for inner in _substitutions(command, result):
        result.raise_to("moderate", "uses command substitution")
        _classify(inner, result, depth + 1)
    try:
        tokens = _tokenize(command)
    except ValueError:
        result.raise_to("dangerous", "could not be parsed")
        return
    cwds = _Cwds(scope.cwd) if scope else None
    for segment, piped, end in _segments(tokens):
        here = cwds.current if cwds else None
        _classify_segment(segment, piped, result, depth, scope=scope, cwds=here)
        if cwds:
            cwds.after(segment, piped, end)


class _Cwds:
    """The working folders a command may be in, tracked through literal `cd X &&`.

    Always a superset of the real one: `cd X && rm y` runs rm in X only, but after `;`,
    `||`, `&` or a subshell's `)` the cd may have failed or been undone, so from there on
    every folder seen so far counts (a delete must be inside scratch for all of them).
    `None` in the set is a folder we can't know (`cd $X`, `pushd`, `if cd ...`).
    """

    def __init__(self, cwd: str) -> None:
        self.current: set[str | None] = {cwd}
        self.seen: set[str | None] = {cwd}

    def after(self, segment: list[str], piped: bool, end: str | None) -> None:
        if any(w in ("cd", "pushd", "popd") for w in segment):
            target = segment[1] if len(segment) == 2 and segment[0] == "cd" else None
            if target is not None and _literal_path(target) and not piped and end == "&&":
                self.current = {_join(c, target) for c in self.current}
            else:
                self.current = self.current | {None}
            self.seen |= self.current
        if end != "&&":
            self.current = set(self.seen)


def _join(cwd: str | None, path: str | None) -> str | None:
    if cwd is None or path is None:
        return None
    return posixpath.join(cwd, path)


def _literal_path(token: str) -> bool:
    """A path written out in full: no variables, home, globs or brace expansion."""
    return (
        bool(token)
        and not token.startswith(("~", "-"))
        and not any(ch in token for ch in "$`*?[]{}")
    )


def _strip_heredoc_bodies(command: str) -> str:
    """Here-document text is data, not commands: drop it before tokenizing."""
    lines = command.split("\n")
    out: list[str] = []
    waiting: list[str] = []
    for line in lines:
        if waiting:
            if line.strip() == waiting[0]:
                waiting.pop(0)
                out.append("")
            continue
        out.append(line)
        waiting.extend(m.group(2) for m in _HEREDOC.finditer(line))
    return "\n".join(out)


def _substitutions(command: str, result: ShellRisk) -> list[str]:
    """Bodies of $(...) and <(...) / >(...), found by bracket matching."""
    found: list[str] = []
    i = 0
    while True:
        starts = [
            p
            for p in (command.find("$(", i), command.find("<(", i), command.find(">(", i))
            if p >= 0
        ]
        if not starts:
            return found
        start = min(starts) + 2
        depth, j = 1, start
        while j < len(command) and depth:
            if command[j] == "(":
                depth += 1
            elif command[j] == ")":
                depth -= 1
            j += 1
        if depth:
            result.raise_to("dangerous", "unbalanced command substitution")
            return found
        found.append(command[start : j - 1])
        i = j


def _tokenize(command: str) -> list[str]:
    lexer = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
    lexer.whitespace = " \t\r"  # newlines separate commands, so they are tokens
    lexer.whitespace_split = True
    lexer.commenters = "#"
    return list(lexer)


def _segments(tokens: list[str]) -> list[tuple[list[str], bool, str | None]]:
    """Split into simple commands; `piped` marks a command reading a previous one's output,
    and the last item is the separator after it (None at the end). A separator with no
    command before it (`(`, `)`) gives an empty command, so cwd tracking still sees it."""
    segments: list[tuple[list[str], bool, str | None]] = []
    current: list[str] = []
    piped = False
    for token in tokens:
        if token in SEPARATORS or (token and set(token) <= set(";&|()\n")):
            segments.append((current, piped, token))
            current = []
            piped = token in ("|", "|&")
            continue
        current.append(token)
    if current:
        segments.append((current, piped, None))
    return segments


def _classify_segment(
    tokens: list[str],
    piped: bool,
    result: ShellRisk,
    depth: int,
    scope: DeleteScope | None = None,
    cwds: set[str | None] | None = None,
) -> None:
    if not tokens:
        return
    words: list[str] = []
    redirect: str | None = None  # the redirect operator whose target comes next
    for tok in tokens:
        if redirect is not None:
            if ">" in redirect:
                _check_redirect_target(tok, result)
            redirect = None
            continue
        if tok in REDIRECTS or re.fullmatch(r"\d*[<>]+&?\d*", tok):
            redirect = tok
            continue
        words.append(tok)
    while words and (words[0] in GROUPING):
        words.pop(0)
    while words and _ASSIGNMENT.match(words[0]):
        words.pop(0)
    if not words:
        return
    if words[0] in ("for", "select", "case", "in", "esac"):
        return  # loop/case headers: the commands inside are checked on their own
    unwrapped = _unwrap(words, result)
    if unwrapped is not words:
        scope = None  # `xargs rm`, `env -C dir rm`: the paths aren't what they look like
    words = unwrapped
    if not words:
        return
    name_raw = words[0]
    if name_raw not in ("[", "[[") and any(ch in name_raw for ch in "$*?[{"):
        result.raise_to("dangerous", "the command name is computed at run time")
        return
    name = name_raw.rsplit("/", 1)[-1]
    args = words[1:]

    if name in DANGEROUS or name.startswith(DANGEROUS_PREFIXES):
        result.raise_to("dangerous", f"runs {name}")
        return
    if piped and name in INTERPRETERS and not _has_script_arg(name, args):
        result.raise_to("dangerous", f"pipes output into {name}")
        return
    if name in SHELLS or name in ("source", "."):
        inner = _inline_script(args)
        if inner is not None:
            result.raise_to("moderate", f"runs a {name} script")
            _classify(inner, result, depth + 1)
        else:
            result.raise_to("moderate", f"runs a {name} script")
        return

    if scope is not None and cwds and name == name_raw and _scratch_delete(name, args, scope, cwds):
        result.raise_to("moderate", "deletes inside scratch/")
        return
    checker = _SPECIFIC.get(name)
    if checker:
        checker(args, result)
    elif name in SAFE:
        pass
    else:
        result.raise_to("moderate", f"runs {name}")


def _check_redirect_target(target: str, result: ShellRisk) -> None:
    if target.isdigit() or target in ("/dev/null", "/dev/stdout", "/dev/stderr", "-"):
        return  # 2>&1, >/dev/null: no file is written
    if target.startswith("/dev/"):
        result.raise_to("dangerous", f"writes to device {target}")
    else:
        result.raise_to("moderate", "writes to a file")


def _unwrap(words: list[str], result: ShellRisk) -> list[str]:
    """`nice -n 5 timeout 10 rm -rf x` -> `rm -rf x`. Returns `words` itself when there is
    no wrapper."""
    for _ in range(10):
        if not words:
            return words
        name = words[0].rsplit("/", 1)[-1]
        if name not in WRAPPERS:
            return words
        if name == "xargs":
            result.raise_to("moderate", "runs commands on piped input")
        if name == "env" and len(words) == 1:
            return words  # plain `env` prints the environment
        value_opts = WRAPPER_VALUE_OPTS.get(name, set())
        i = 1
        while i < len(words):
            w = words[i]
            if w in value_opts:
                i += 2
            elif w.startswith("-") or _ASSIGNMENT.match(w):
                i += 1
            elif name == "timeout" and re.fullmatch(r"[\d.]+[smhd]?", w):
                i += 1  # the duration
            else:
                break
        words = words[i:]
    result.raise_to("dangerous", "too many nested wrappers")
    return []


def _has_script_arg(name: str, args: list[str]) -> bool:
    """`python script.py` reads a file; `python` / `python -` reads stdin."""
    for a in args:
        if a == "-":
            return False
        if not a.startswith("-"):
            return True
    return False


def _inline_script(args: list[str]) -> str | None:
    for i, a in enumerate(args):
        if a == "-c" or (a.startswith("-") and not a.startswith("--") and a.endswith("c")):
            return args[i + 1] if i + 1 < len(args) else ""
    return None


def _flags(args: list[str]) -> set[str]:
    """Short flags split into letters (-rf -> r, f) plus long options."""
    out: set[str] = set()
    for a in args:
        if a == "--":
            break
        if a.startswith("--"):
            out.add(a.split("=", 1)[0])
        elif a.startswith("-") and len(a) > 1:
            out.update(a[1:])
    return out


def _operands(args: list[str]) -> list[str]:
    return [a for a in args if not a.startswith("-")]


def _check_rm(args: list[str], result: ShellRisk) -> None:
    flags = _flags(args)
    if flags & {"r", "R", "--recursive"}:
        result.raise_to("dangerous", "deletes folders recursively")
    elif any(
        o in ("/", "~", "..", ".", "*") or o.startswith(("/", "~")) or "*" in o
        for o in _operands(args)
    ):
        result.raise_to("dangerous", "deletes with a wildcard or outside the current folder")
    else:
        result.raise_to("moderate", "deletes files")


def _check_rmdir(args: list[str], result: ShellRisk) -> None:
    result.raise_to("moderate", "removes empty folders")


def _check_recursive_perm(name: str):  # noqa: ANN202
    def check(args: list[str], result: ShellRisk) -> None:
        if _flags(args) & {"R", "--recursive"}:
            result.raise_to("dangerous", f"changes permissions recursively ({name})")
        else:
            result.raise_to("moderate", f"changes permissions ({name})")

    return check


def _check_find(args: list[str], result: ShellRisk) -> None:
    if "-delete" in args:
        result.raise_to("dangerous", "find -delete removes files")
    for action in ("-exec", "-execdir", "-ok", "-okdir"):
        if action in args:
            start = args.index(action) + 1
            end = next(
                (i for i in range(start, len(args)) if args[i] in (";", "+", "\\;")), len(args)
            )
            inner = ShellRisk()
            _classify_segment(args[start:end], False, inner, MAX_DEPTH)
            result.raise_to("moderate", "find runs a command on each match")
            result.raise_to(inner.risk, inner.reasons[0] if inner.reasons else None)
    if any(a in args for a in ("-fprint", "-fprintf", "-fls")):
        result.raise_to("moderate", "find writes a file")


def _check_git(args: list[str], result: ShellRisk) -> None:
    # Skip global options like -C dir / -c key=val.
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in ("-C", "-c", "--git-dir", "--work-tree") else 1
    if i >= len(args):
        return
    sub, rest = args[i], args[i + 1 :]
    flags = _flags(rest)
    if sub == "push":
        if flags & {
            "f",
            "--force",
            "--force-with-lease",
            "--mirror",
            "--delete",
            "d",
            "--prune",
        } or any(r.startswith(("+", ":")) for r in _operands(rest)):
            result.raise_to("dangerous", "git push that rewrites or deletes remote history")
        else:
            result.raise_to("moderate", "git push")
    elif sub == "reset" and "--hard" in flags:
        result.raise_to("dangerous", "git reset --hard discards changes")
    elif sub == "clean" and flags & {"f", "--force"}:
        result.raise_to("dangerous", "git clean deletes untracked files")
    elif sub in ("checkout", "switch") and (
        flags & {"f", "--force", "--discard-changes"} or "." in rest or "--" in rest
    ):
        result.raise_to("dangerous", "git checkout that discards changes")
    elif sub == "restore" and "--staged" not in flags:
        result.raise_to("dangerous", "git restore discards changes")
    elif sub == "branch" and flags & {"D", "d", "--delete", "M", "m", "--move", "f", "--force"}:
        result.raise_to(
            "dangerous" if "D" in flags or "M" in flags else "moderate", "git branch delete/rename"
        )
    elif sub == "stash" and rest[:1] and rest[0] in ("drop", "clear"):
        result.raise_to("dangerous", "git stash drop/clear loses work")
    elif sub in ("filter-branch", "filter-repo", "update-ref", "replace"):
        result.raise_to("dangerous", f"git {sub} rewrites history")
    elif sub in ("reflog", "gc") and (
        "expire" in rest or any(r.startswith("--prune") for r in rest)
    ):
        result.raise_to("dangerous", "git discards unreachable history")
    elif sub == "tag" and flags & {"d", "--delete", "f", "--force"}:
        result.raise_to("moderate", "git tag change")
    elif sub == "config" and not (flags & {"l", "--list", "--get", "--get-all"}):
        result.raise_to("moderate", "git config change")
    elif sub == "remote" and rest[:1] and rest[0] not in ("-v", "show", "get-url"):
        result.raise_to("moderate", "git remote change")
    elif sub == "stash" and (not rest or rest[0] not in ("list", "show")):
        result.raise_to("moderate", "git stash")
    elif sub in ("worktree", "fetch") or sub not in GIT_SAFE:
        result.raise_to("moderate", f"git {sub}")


def _check_sed(args: list[str], result: ShellRisk) -> None:
    if any(
        a == "-i"
        or a.startswith(("-i", "--in-place"))
        or (a.startswith("-") and not a.startswith("--") and "i" in a)
        for a in args
    ):
        result.raise_to("moderate", "sed edits files in place")


def _check_kill(args: list[str], result: ShellRisk) -> None:
    if args and args[-1] == "-1":
        result.raise_to("dangerous", "kill every process")
    else:
        result.raise_to("moderate", "stops processes")


def _moderate(reason: str):  # noqa: ANN202
    def check(args: list[str], result: ShellRisk) -> None:
        result.raise_to("moderate", reason)

    return check


SSH_VALUE_OPTS = set("bcDEeFIiJLlmOopQRSWwB")


def _check_ssh(args: list[str], result: ShellRisk) -> None:
    """`ssh host 'cmd'` runs cmd on the other machine: rate that command too."""
    result.raise_to("moderate", "connects to another machine over SSH")
    i = 0
    while i < len(args) and args[i].startswith("-"):
        flag = args[i]
        # -p 22 takes a value; -p22 or -tt don't need the next word.
        i += 2 if len(flag) == 2 and flag[1] in SSH_VALUE_OPTS else 1
    remote = args[i + 1 :]  # after the destination
    if remote:
        inner = ShellRisk()
        _classify(" ".join(remote), inner, depth=1)
        if inner.risk == "dangerous":
            result.raise_to("dangerous", "on the remote machine: " + "; ".join(inner.reasons))


SYSTEMCTL_READ = {
    "status",
    "show",
    "cat",
    "is-active",
    "is-enabled",
    "is-failed",
    "list-units",
    "list-unit-files",
    "list-timers",
    "list-sockets",
}


def _check_systemctl(args: list[str], result: ShellRisk) -> None:
    ops = _operands(args)
    if ops and ops[0] in SYSTEMCTL_READ:
        return
    result.raise_to("dangerous", f"systemctl {ops[0] if ops else ''} changes services")


def _check_rsync(args: list[str], result: ShellRisk) -> None:
    if any(a.startswith(("--delete", "--remove-source-files")) for a in args):
        result.raise_to("dangerous", "rsync deletes files")
    else:
        result.raise_to("moderate", "copies files with rsync")


def _check_mv(args: list[str], result: ShellRisk) -> None:
    ops = _operands(args)
    if ops and ops[-1].startswith("/dev/"):
        result.raise_to("dangerous", "moves files into a device")
    else:
        result.raise_to("moderate", "moves or renames files")


_SPECIFIC = {
    "rm": _check_rm,
    "unlink": _moderate("deletes a file"),
    "rmdir": _check_rmdir,
    "chmod": _check_recursive_perm("chmod"),
    "chown": _check_recursive_perm("chown"),
    "chgrp": _check_recursive_perm("chgrp"),
    "find": _check_find,
    "git": _check_git,
    "sed": _check_sed,
    "kill": _check_kill,
    "pkill": _moderate("stops processes"),
    "killall": _moderate("stops processes"),
    "mv": _check_mv,
    "cp": _moderate("copies files"),
    "ln": _moderate("creates links"),
    "mkdir": _moderate("creates folders"),
    "touch": _moderate("creates or updates files"),
    "tee": _moderate("writes files"),
    "awk": _moderate("runs an awk program"),
    "systemctl": _check_systemctl,
    "ssh": _check_ssh,
    "scp": _moderate("copies files over SSH"),
    "sftp": _moderate("transfers files over SSH"),
    "rsync": _check_rsync,
}


# --- deletes inside scratch/ (spec 25 §0) ---------------------------------------------

_FIND_NOT_JUST_DELETE = {
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
    "-L",
    "-H",
    "-follow",
}


def _scratch_delete(name: str, args: list[str], scope: DeleteScope, cwds: set[str | None]) -> bool:
    """True when this rm / find -delete / git clean deletes only inside scratch/, for every
    working folder the command may be in."""
    if name == "rm":
        paths = _rm_paths(args)
        return bool(paths) and all(_inside(p, c, scope) for p in paths for c in cwds)
    if name == "find":
        starts = _find_starts(args)
        return starts is not None and all(_inside(p, c, scope) for p in starts for c in cwds)
    if name == "git":
        return _git_clean_inside(args, scope, cwds)
    return False


def _rm_paths(args: list[str]) -> list[str]:
    paths: list[str] = []
    options_done = False
    for a in args:
        if not options_done and a == "--":
            options_done = True
        elif options_done or not a.startswith("-"):
            paths.append(a)
    return paths


def _find_starts(args: list[str]) -> list[str] | None:
    """The start folders of `find <paths> <tests> -delete`, or None when it does more than
    delete (runs commands, writes files, follows links) or starts with options."""
    if "-delete" not in args or any(a in _FIND_NOT_JUST_DELETE for a in args):
        return None
    starts: list[str] = []
    for a in args:
        if a.startswith("-") or a in ("(", "!", ")"):
            break
        starts.append(a)
    # Without a path find starts in the working folder, which must then be inside scratch
    # (find never deletes its start folder "." itself).
    return starts or ["."]


def _git_clean_inside(args: list[str], scope: DeleteScope, cwds: set[str | None]) -> bool:
    folders = set(cwds)
    i = 0
    while i < len(args) and args[i].startswith("-"):
        if args[i] != "-C" or i + 1 >= len(args) or not _literal_path(args[i + 1]):
            return False  # -c, --git-dir, --work-tree could point anywhere
        folders = {_join(c, args[i + 1]) for c in folders}
        i += 2
    if i >= len(args) or args[i] != "clean":
        return False
    paths: list[str] = []
    rest = args[i + 1 :]
    after_dashes = False
    j = 0
    while j < len(rest):
        a = rest[j]
        if after_dashes or not a.startswith("-"):
            paths.append(a)
        elif a == "--":
            after_dashes = True
        elif a in ("-e", "--exclude"):
            j += 1  # its pattern
        j += 1
    # Without paths git clean works from the working folder down: it must be inside.
    return all(_inside(p, c, scope) for p in (paths or ["."]) for c in folders)


def _inside(path: str, cwd: str | None, scope: DeleteScope) -> bool:
    """`path` (relative to `cwd`) is strictly inside scratch/. A glob counts when all it can
    match are children of a folder inside scratch, or of scratch itself (`scratch/*`)."""
    if cwd is None or not path or path.startswith("~") or any(ch in path for ch in "$`{}"):
        return False
    glob_at = next((i for i, ch in enumerate(path) if ch in "*?[]"), None)
    if glob_at is None:
        return scope.where(posixpath.join(cwd, path)) == "inside"
    prefix, rest = path[:glob_at], path[glob_at:]
    if "/" in rest:
        return False  # `scratch/*/../..`: a glob in the middle of a path
    folder, slash, start = prefix.rpartition("/")
    if (start or rest).startswith("."):
        return False  # `.*` can match `..`
    parent = (folder or "/") if slash else "."
    return scope.where(posixpath.join(cwd, parent)) in ("inside", "root")


def max_risk(a: Risk, b: Risk) -> Risk:
    return a if _ORDER[a] >= _ORDER[b] else b
