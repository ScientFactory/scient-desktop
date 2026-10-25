"""Static paths and local imports for the workspace's Python test helpers."""

import ast
import json
from pathlib import Path
import sys


def inspect(file):
    tree = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
    bindings = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and node.value:
                    bindings.setdefault(target.id, []).append(node.value)

    def values(node, seen=frozenset()):
        if node is None or id(node) in seen:
            return []
        seen = seen | {id(node)}
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return [node.value] if "\n" not in node.value else []
        if isinstance(node, ast.Name):
            if node.id == "__file__":
                return [str(file)]
            return [v for expr in bindings.get(node.id, []) for v in values(expr, seen)]
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return [v for item in node.elts for v in values(item, seen)]
        if isinstance(node, ast.Attribute) and node.attr == "parent":
            return [str(Path(v).parent) for v in values(node.value, seen)]
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute):
            if node.value.attr == "parents" and isinstance(node.slice, ast.Constant):
                return [str(Path(v).parents[node.slice.value]) for v in values(node.value.value, seen)]
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Div, ast.Add)):
            left = values(node.left, seen)
            right = values(node.right, seen) or ["*"]
            return [str(Path(a) / b) if isinstance(node.op, ast.Div) else a + b for a in left for b in right]
        if isinstance(node, ast.Call):
            name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
            if name in ("resolve", "absolute", "read_text", "read_bytes", "open") and isinstance(node.func, ast.Attribute):
                return values(node.func.value, seen)
            if name == "dirname":
                return [str(Path(v).parent) for v in values(node.args[0], seen)]
            if name in ("Path", "join", "str", "open") and node.args:
                result = values(node.args[0], seen)
                for arg in node.args[1:]:
                    result = [str(Path(a) / b) for a in result for b in values(arg, seen) or ["*"]]
                return result
            if name in ("glob", "rglob") and isinstance(node.func, ast.Attribute):
                return [str(Path(v)) + "/" for v in values(node.func.value, seen)]
        return []

    refs = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            for value in values(node):
                if Path(value).is_absolute():
                    refs.add(value)
        modules = []
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            modules = [node.module or ""] + [
                ".".join(part for part in (node.module, alias.name) if part)
                for alias in node.names if alias.name != "*"
            ]
        for module in modules:
            base = file.parent
            if isinstance(node, ast.ImportFrom):
                for _ in range(max(0, node.level - 1)):
                    base = base.parent
            candidate = base.joinpath(*module.split("."))
            for target in (candidate.with_suffix(".py"), candidate / "__init__.py"):
                if target.is_file():
                    refs.add(str(target))
    return sorted(refs)


request = json.load(sys.stdin)
root = Path(request["root"])
json.dump({file: inspect(root / file) for file in request["files"]}, sys.stdout)
