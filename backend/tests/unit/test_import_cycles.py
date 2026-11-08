"""No import cycles between backend modules (module-level imports; see CLAUDE.md).

Imports inside a function don't count: runtime/compaction.py, history.py and
references.py use one to break the only cycle there is. Imports under
`if TYPE_CHECKING:` don't count either."""

import ast
from pathlib import Path

APP = Path(__file__).parents[2] / "app"


def _module_name(path: Path) -> str:
    parts = path.relative_to(APP.parent).with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _graph() -> dict[str, set[str]]:
    files = {_module_name(p): p for p in APP.rglob("*.py")}
    graph: dict[str, set[str]] = {name: set() for name in files}
    for name, path in files.items():
        package = name if path.name == "__init__.py" else name.rpartition(".")[0]
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.If) and "TYPE_CHECKING" in ast.unparse(node.test):
                continue
            for imp in ast.walk(node) if isinstance(node, ast.If | ast.Try) else [node]:
                targets: list[str] = []
                if isinstance(imp, ast.Import):
                    targets = [a.name for a in imp.names]
                elif isinstance(imp, ast.ImportFrom):
                    base = imp.module or ""
                    if imp.level:
                        up = package.split(".")[: len(package.split(".")) - (imp.level - 1)]
                        base = ".".join([*up, *([base] if base else [])])
                    targets = [base, *(f"{base}.{a.name}" for a in imp.names)]
                graph[name] |= {t for t in targets if t in files and t != name}
    return graph


def _cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    on_stack: set[str] = set()
    found: list[list[str]] = []

    def visit(v: str) -> None:
        index[v] = low[v] = len(index)
        stack.append(v)
        on_stack.add(v)
        for w in graph[v]:
            if w not in index:
                visit(w)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            component = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                component.append(w)
                if w == v:
                    break
            if len(component) > 1:
                found.append(sorted(component))

    for v in graph:
        if v not in index:
            visit(v)
    return found


def test_backend_modules_import_each_other_in_no_circle() -> None:
    graph = _graph()
    assert len(graph) > 200  # the scan found the app
    assert _cycles(graph) == []
