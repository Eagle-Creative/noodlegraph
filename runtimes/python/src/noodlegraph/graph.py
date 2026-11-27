# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph.graph — block registry, validation and the compiled graph.

:func:`check` is the single gate a graph passes before it may run: block types exist,
their settings are valid, wires connect an output to an input of a fitting type, a value
input carries at most one wire, and there is no cycle, so every chain ends.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from importlib.metadata import entry_points
from typing import Any

from annotated_types import MaxLen, MinLen
from pydantic import ValidationError

from noodlegraph.blocks import LIST_OF, Block, BlockOptions, Loop, Port, Trigger, fits
from noodlegraph.context import Context
from noodlegraph.forms import field_specs
from noodlegraph.model import Node, Graph, Wire

ENTRY_POINT_GROUP = "noodlegraph.blocks"
Registry = Mapping[str, type[Block]]


def registry(*blocks: type[Block] | Iterable[type[Block]] | Registry) -> dict[str, type[Block]]:
    """A registry from block classes, tuples of them or other registries; a later one wins.

    ``registry(STANDARD, MyAction, MyTrigger)`` is the usual call.
    """
    found: dict[str, type[Block]] = {}
    for item in blocks:
        if isinstance(item, Mapping):  # another registry
            item = item.values()  # noqa: PLW2901
        for cls in [item] if isinstance(item, type) else item:
            found[cls.kind] = cls
    return found


def discover_blocks(*, standard: bool = True) -> dict[str, type[Block]]:
    """Every installed block type by kind: the standard ones and those of other packages.

    A package adds blocks with an entry point in the group ``noodlegraph.blocks`` that
    names a tuple of block classes.
    """
    from noodlegraph.standard import STANDARD  # noqa: PLC0415

    found: dict[str, type[Block]] = {b.kind: b for b in STANDARD} if standard else {}
    for ep in entry_points(group=ENTRY_POINT_GROUP):
        for cls in ep.load():
            found.setdefault(cls.kind, cls)
    return found


def _label(name: str, title: str | None) -> str:
    """What a setting is called in the editor: its title, else its name with the unit apart.

    ``hold_s`` reads "Hold (s)", not "Hold s".
    """
    if title:
        return title
    words, unit = (name[:-2], " (s)") if name.endswith("_s") else (name, "")
    return words.replace("_", " ").capitalize() + unit


def catalogue(registry: Registry) -> list[dict[str, Any]]:
    """The block types for the editor (its ``blocks`` option): ports and the settings form."""
    out = []
    for cls in registry.values():
        fields = field_specs(cls.Options)
        for spec in fields:
            info = cls.Options.model_fields[spec["name"]]
            extra = info.json_schema_extra
            if isinstance(extra, dict) and "ui" in extra:
                spec["kind"] = extra["ui"]
            if isinstance(extra, dict) and "labels" in extra:
                spec["labels"] = extra["labels"]  # what a select shows for its values
            if spec["kind"] in LIST_OF:  # a list: how many items it may have
                for c in info.metadata:
                    if isinstance(c, MinLen):
                        spec["min_items"] = c.min_length
                    elif isinstance(c, MaxLen):
                        spec["max_items"] = c.max_length
                spec["default"] = list(spec.get("default", ()))
            spec["label"] = _label(spec["name"], info.title)
        out.append(
            {
                "kind": cls.kind,
                "title": cls.title,
                "category": cls.category,
                "help": cls.help,
                "inputs": [p.to_json() for p in cls.inputs],
                "outputs": [p.to_json() for p in cls.outputs],
                "fields": fields,
            }
        )
    return out


@dataclass(slots=True)
class Compiled:
    """A checked graph, ready to run."""

    graph: Graph
    classes: dict[str, type[Block]] = field(default_factory=dict)
    options: dict[str, BlockOptions] = field(default_factory=dict)
    #: a flow output -> the nodes it continues at (several run at the same time)
    flow_next: dict[tuple[str, str], list[str]] = field(default_factory=dict)
    value_from: dict[tuple[str, str], tuple[str, str]] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)

    @property
    def loops(self) -> bool:
        """It has a loop block: a run may last as long as the engine is active."""
        return any(issubclass(cls, Loop) for cls in self.classes.values())

    @property
    def valid(self) -> bool:
        """No problems: it may run."""
        return not self.problems

    @property
    def triggers(self) -> list[str]:
        """Ids of the trigger blocks."""
        return [n for n, cls in self.classes.items() if issubclass(cls, Trigger)]


def _port(ports: Iterable[Port], name: str) -> Port | None:
    return next((p for p in ports if p.name == name), None)


def _depends_on(cls: type[Block], output: str) -> tuple[str, ...]:
    """The inputs an output of *cls* is computed from (every input unless it says less)."""
    named = cls.depends.get(output)
    return tuple(p.name for p in cls.inputs) if named is None else named


def _has_cycle(edges: Mapping[str, list[str]]) -> bool:
    state: dict[str, int] = {}

    def visit(node: str) -> bool:
        if state.get(node) == 1:
            return True
        if state.get(node) == 2:
            return False
        state[node] = 1
        if any(visit(n) for n in edges.get(node, [])):
            return True
        state[node] = 2
        return False

    return any(visit(n) for n in list(edges))


def upgrade(graph: Graph, registry: Registry) -> Graph:
    """*graph* in today's form: settings and ports a block renamed since it was saved.

    A graph file from an older version of the host's blocks keeps working; saved again, it
    is written in the new form.
    """
    changed = False
    nodes: list[Node] = []
    for node in graph.nodes:
        cls = registry.get(node.kind)
        options = cls.upgrade(dict(node.options)) if cls is not None else node.options
        if options != node.options:
            node, changed = node.model_copy(update={"options": options}), True  # noqa: PLW2901
        nodes.append(node)
    kinds = {n.id: registry.get(n.kind) for n in graph.nodes}
    wires: list[Wire] = []
    for w in graph.wires:
        cls = kinds.get(w.to_node)
        new = cls.renamed.get(w.to_port, w.to_port) if cls is not None else w.to_port
        if new != w.to_port:
            w, changed = w.model_copy(update={"to_port": new}), True  # noqa: PLW2901
        wires.append(w)
    if not changed:
        return graph
    return graph.model_copy(update={"nodes": tuple(nodes), "wires": tuple(wires)})


def check(graph: Graph, registry: Registry, ctx: Context | None = None) -> Compiled:
    """Validate *graph*; with *ctx* also against the host (what the blocks refer to).

    Four passes: the blocks and their settings, the wires, settings a wire was meant to choose,
    and circles. An older graph is checked (and run) in today's form: see :func:`upgrade`.
    """
    graph = upgrade(graph, registry)
    c = Compiled(graph)
    _check_blocks(c, graph, registry, ctx)
    edges: dict[str, list[str]] = {}  # port -> ports it feeds, for the circle check
    _check_wires(c, graph, edges)
    _check_unchosen(c, graph)
    for node_id, cls in c.classes.items():  # inside a block: an output from its inputs
        for out_port in cls.outputs:
            for name in _depends_on(cls, out_port.name):
                edges.setdefault(f"{node_id}\0{name}\0in", []).append(
                    f"{node_id}\0{out_port.name}\0out"
                )
    if _has_cycle(edges):
        c.problems.append(
            "the wires form a circle; a chain must end (use For or While to repeat steps)"
        )
    return c


def _check_blocks(c: Compiled, graph: Graph, registry: Registry, ctx: Context | None) -> None:
    """Every block: a known type and valid settings (and, with *ctx*, fits the host)."""
    for node in graph.nodes:
        cls = registry.get(node.kind)
        if cls is None:
            c.problems.append(f"{node.id}: unknown block type {node.kind!r}")
            continue
        c.classes[node.id] = cls
        try:
            c.options[node.id] = cls.Options.model_validate(node.options)
        except ValidationError as exc:
            for err in exc.errors():
                where = ".".join(str(x) for x in err["loc"]) or "settings"
                c.problems.append(f"{node.id} ({cls.title}): {where}: {err['msg']}")
            continue
        if ctx is not None:
            c.problems += [
                f"{node.id} ({cls.title}): {p}" for p in cls.problems(c.options[node.id], ctx)
            ]


def _check_wires(c: Compiled, graph: Graph, edges: dict[str, list[str]]) -> None:
    """Every wire: both blocks and ports exist, the types fit, one wire per input.

    A flow output may continue in several places; a value input takes one wire.
    """
    for w in graph.wires:
        src, dst = c.classes.get(w.from_node), c.classes.get(w.to_node)
        label = f"wire {w.from_node}.{w.from_port} -> {w.to_node}.{w.to_port}"
        if src is None or dst is None:
            c.problems.append(f"{label}: a block is missing")
            continue
        out, inp = _port(src.outputs, w.from_port), _port(dst.inputs, w.to_port)
        if out is None or inp is None:
            c.problems.append(f"{label}: no such port")
            continue
        if not fits(out.type, inp.type):
            c.problems.append(f"{label}: {out.type} cannot feed {inp.type}")
            continue
        edges.setdefault(f"{w.from_node}\0{w.from_port}\0out", []).append(
            f"{w.to_node}\0{w.to_port}\0in"
        )
        if out.type == "flow":
            nexts = c.flow_next.setdefault((w.from_node, w.from_port), [])
            if w.to_node not in nexts:  # a flow output may continue in several places
                nexts.append(w.to_node)
        else:
            if (w.to_node, w.to_port) in c.value_from:
                c.problems.append(f"{label}: this input already has a wire")
            c.value_from[(w.to_node, w.to_port)] = (w.from_node, w.from_port)


def _check_unchosen(c: Compiled, graph: Graph) -> None:
    """A setting left empty because a wire was meant to choose it, but no wire does."""
    for node in graph.nodes:
        cls, options = c.classes.get(node.id), c.options.get(node.id)
        if cls is None or options is None:
            continue
        for p in cls.inputs:
            wired = (node.id, p.name) in c.value_from
            if p.replaces and not wired and not getattr(options, p.replaces, None):
                what = (cls.Options.model_fields[p.replaces].title or p.replaces).lower()
                c.problems.append(
                    f"{node.id} ({cls.title}): choose the {what}, "
                    f"or wire a number into '{p.label or p.name}'"
                )
