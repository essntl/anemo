"""PowerShell CLIXML to plain text.

When PowerShell's error stream goes to a pipe (Anemo Desktop runs `powershell.exe` with its
output redirected), PowerShell writes it as serialized XML, not as text:

    #< CLIXML
    <Objs Version="1.1.0.1" xmlns="..."><S S="Error">Get-Item : Cannot find path_x000D__x000A_</S>
    <Obj S="progress" RefId="0">...</Obj></Objs>

That is 3-5 times longer than the message and hard to read. `decode` turns every such block
back into the text PowerShell would have printed: the `<S>` strings of the error, warning,
verbose, debug and information streams, with `_xHHHH_` escapes and XML entities decoded;
progress records (`<Obj S="progress">`) are dropped. Text around the blocks is kept, and a
block cut off at the end (output that was too long) is decoded as far as it goes.
"""

import html
import re

MARKER = "#< CLIXML"

# A block: the marker, then <Objs ...> up to </Objs> or the end of the text.
_BLOCK = re.compile(r"#< CLIXML\r?\n?(<Objs\b.*?(?:</Objs>|\Z))", re.DOTALL)
_STRING = re.compile(r'<S S="(\w+)">(.*?)(?:</S>|\Z)', re.DOTALL)
_OBJ = re.compile(r"<Obj\b.*?(?:</Obj>|\Z)", re.DOTALL)
_ESCAPE = re.compile(r"_x([0-9A-Fa-f]{4})_")

# How PowerShell prefixes each stream when it prints it to a console.
_PREFIX = {"warning": "WARNING: ", "verbose": "VERBOSE: ", "debug": "DEBUG: "}


def _unescape(text: str) -> str:
    return html.unescape(_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), text))


def _decode_block(xml: str) -> str:
    # Progress (and other serialized objects) first: their own <S> strings aren't output.
    xml = _OBJ.sub("", xml)
    lines: list[str] = []
    for stream, raw in _STRING.findall(xml):
        line = _unescape(raw)
        prefix = _PREFIX.get(stream.lower())
        if prefix is not None:  # one message per string, printed on its own line
            line = prefix + line.rstrip("\r\n") + "\n"
        lines.append(line)
    text = "".join(lines)
    return text.replace("\r\n", "\n")


def decode(text: str) -> str:
    """`text` with every CLIXML block replaced by its plain text (unchanged if it has none)."""
    if MARKER not in text:
        return text
    return _BLOCK.sub(lambda m: _decode_block(m.group(1)), text).strip("\n")
