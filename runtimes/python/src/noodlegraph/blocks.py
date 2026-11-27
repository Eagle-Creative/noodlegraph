# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph.blocks — the block classes: triggers, actions, loops and values.

A block type is a class with a ``kind``, an ``Options`` model (its settings, edited on the
block) and typed ports. Three kinds of port exist:

* **flow** ports say "then do this": a trigger has a flow output, an action a flow input
  and one or more flow outputs;
* **value** ports (number, bool, text, colour, or a type the host registers) carry data into a
  block's settings. A value input has the name of an option: wired, the wire's value is
  used, otherwise the option;
* **list** ports (numbers, texts, colours) carry a list of values. A single item may feed
  a list input: it becomes a list of one.

Blocks reach the host application only through its :class:`~noodlegraph.context.Context`.
A trigger only *emits*; the engine decides what an event starts.
"""

from __future__ import annotations

import colorsys
from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from noodlegraph.context import Context

#: a port type: "flow", one of the built-in value types (number, bool, text, colour and the
#: lists numbers, texts, colours), or a type the host added with :func:`register_type`
PortType = str
#: the group a block is listed under: trigger, action, logic, value, or one the host adds
Category = str
Colour = tuple[int, int, int]
Value = Any

#: list port types and the type of one item: an item may feed a list input (a list of one)
LIST_OF: dict[str, str] = {"colours": "colour", "numbers": "number", "texts": "text"}
MAX_LIST = 64  # items in a list setting


def fits(out_type: str, in_type: str) -> bool:
    """Whether an output of *out_type* may feed an input of *in_type*."""
    return out_type == in_type or LIST_OF.get(in_type) == out_type


FLOW_IN = "in"
FLOW_OUT = "out"
LOOP_EACH = "each"
LOOP_DONE = "done"
MIN_ROUND_S = 0.02  # the shortest round of a loop


@dataclass(frozen=True, slots=True)
class Port:
    """A connection point of a block."""

    name: str
    type: PortType
    label: str = ""
    replaces: str = ""  # a setting this input overrides when wired, else unused

    def to_json(self) -> dict[str, str]:
        """JSON form for the editor."""
        out = {"name": self.name, "type": self.type, "label": self.label or self.name}
        if self.replaces:
            out["replaces"] = self.replaces
        return out


@dataclass(frozen=True, slots=True)
class TriggerEvent:
    """What a trigger emits: the moment and the values of its output ports."""

    at: float
    values: Mapping[str, Value] = field(default_factory=dict)


Emit = Callable[[TriggerEvent], None]


class BlockOptions(BaseModel):
    """Base of every block's settings."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class Block(ABC):
    """A block type. Subclass :class:`Trigger`, :class:`Action` or :class:`ValueBlock`."""

    kind: ClassVar[str]
    title: ClassVar[str]
    category: ClassVar[Category]
    help: ClassVar[str] = ""
    Options: ClassVar[type[BlockOptions]] = BlockOptions
    inputs: ClassVar[tuple[Port, ...]] = ()
    outputs: ClassVar[tuple[Port, ...]] = ()
    #: input ports of older graph files under their new name (a wire into "colour" goes
    #: into "colours" now)
    renamed: ClassVar[Mapping[str, str]] = {}
    #: outputs that depend only on these inputs (others depend on every input): a list's
    #: count does not need its 'no.', so it may feed the For whose i goes into that 'no.'
    depends: ClassVar[Mapping[str, tuple[str, ...]]] = {}

    def __init__(self, node_id: str, options: BlockOptions, ctx: Context) -> None:
        self.node_id = node_id
        self.options: Any = options
        self.ctx = ctx
        #: the variables of this block's graph, by name (the engine puts them here)
        self.variables: dict[str, Value] = {}
        #: runs another graph as a step of this chain (the engine puts it here)
        self.call: Callable[[str], Any] | None = None

    @classmethod
    def upgrade(cls, options: dict[str, Any]) -> dict[str, Any]:
        """The settings of an older graph file in today's form (default: as they are)."""
        return options

    @classmethod
    def problems(cls, options: BlockOptions, ctx: Context) -> list[str]:
        """What the host lacks for these settings (e.g. something they name is not there)."""
        del options, ctx
        return []


class TriggerOptions(BlockOptions):
    """Settings every trigger has."""

    cooldown_s: float = Field(
        default=0.0, ge=0, le=86400, description="Do not start again for this long."
    )
    when_running: Literal["ignore", "restart"] = Field(
        default="ignore",
        title="If still running",
        description="If its chain is still running when it fires again.",
    )


class Trigger(Block):
    """An entry point: watches one thing and emits when it happens (an edge, not a level)."""

    category: ClassVar[Category] = "trigger"
    Options: ClassVar[type[BlockOptions]] = TriggerOptions
    outputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_OUT, "flow", "then"),)

    def __init__(self, node_id: str, options: BlockOptions, ctx: Context, emit: Emit) -> None:
        super().__init__(node_id, options, ctx)
        self.emit = emit

    @abstractmethod
    async def start(self) -> None:
        """Begin watching (subscribe, schedule)."""

    async def stop(self) -> None:
        """Undo everything :meth:`start` did."""


class Action(Block):
    """One bounded step of a chain."""

    category: ClassVar[Category] = "action"
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow", ""),)
    outputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_OUT, "flow", "then"),)

    @abstractmethod
    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step; return the name of the flow output to continue on."""


class Loop(Action):
    """A step that runs its *each* chain again and again, then continues on *done*.

    Before every round the engine asks :meth:`again`, then sets the loop's value outputs
    (:meth:`values`, such as a For's ``i``) for the blocks of that round: they are known only
    inside the rounds. It runs the chain wired to ``each`` to its end and continues on
    ``done`` once the answer is no. The inputs are read before every round (a While's
    condition), or once when the loop starts if :attr:`fixed` (a For's bounds). A round takes
    at least :data:`MIN_ROUND_S`, so a loop without a wait cannot hold up the host;
    deactivating the engine stops it like every chain.
    """

    category: ClassVar[Category] = "logic"
    outputs: ClassVar[tuple[Port, ...]] = (
        Port(LOOP_EACH, "flow", "each round"),
        Port(LOOP_DONE, "flow", "done"),
    )
    fixed: ClassVar[bool] = False

    @abstractmethod
    def again(self, inputs: Mapping[str, Value], rounds: int) -> bool:
        """Whether to run another round; *rounds* have run so far."""

    def values(self, inputs: Mapping[str, Value], rounds: int) -> Mapping[str, Value]:
        """The value outputs for the round about to run (*rounds* have run before it)."""
        del inputs, rounds
        return {}

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Not used: the engine runs a loop's rounds itself."""
        del inputs
        return LOOP_DONE


class ValueBlock(Block):
    """Computes values from its inputs; has no flow ports and no side effects."""

    category: ClassVar[Category] = "value"

    @abstractmethod
    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The values of the output ports.

        *inputs* holds what the asked output depends on (:attr:`Block.depends`); an output
        whose inputs are missing may be left out.
        """


# ------------------------------------------------------------------ value helpers
def parse_colour(text: object) -> Colour:
    """``#rrggbb`` -> (r, g, b)."""
    if isinstance(text, tuple | list) and len(text) == 3:
        return (int(text[0]) & 255, int(text[1]) & 255, int(text[2]) & 255)
    s = str(text).strip().lstrip("#")
    if len(s) != 6:
        raise ValueError(f"not a colour: {text!r} (use #rrggbb)")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def hue_colour(hue_deg: float, brightness_pct: float) -> Colour:
    """A fully saturated colour from a hue (0-360) and a brightness (0-100)."""
    v = min(max(brightness_pct, 0.0), 100.0) / 100.0
    r, g, b = colorsys.hsv_to_rgb((hue_deg % 360.0) / 360.0, 1.0, v)
    return (round(r * 255), round(g * 255), round(b * 255))


def _is_colour(value: object) -> bool:
    """One colour (``#rrggbb`` or r, g, b), not a list of them."""
    return isinstance(value, str) or (
        isinstance(value, tuple | list)
        and len(value) == 3
        and all(isinstance(x, int | float) and not isinstance(x, bool) for x in value)
    )


def _coerce_colours(value: object) -> Value:
    items = [value] if _is_colour(value) else value
    if not isinstance(items, tuple | list) or not items:
        raise ValueError(f"not a list of colours: {value!r}")
    return tuple(parse_colour(c) for c in items)


def _coerce_numbers(value: object) -> Value:
    items = value if isinstance(value, tuple | list) else [value]
    if not items:
        raise ValueError("an empty list of numbers")
    return tuple(_coerce_number(x) for x in items)


def _coerce_number(value: object) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, int | float):
        return float(value)
    raise ValueError(f"not a number: {value!r}")


def _coerce_text(value: object) -> str:
    if isinstance(value, str):
        return value
    raise ValueError(f"not a text: {value!r}")


def _coerce_texts(value: object) -> Value:
    items = value if isinstance(value, tuple | list) else [value]
    if not items:
        raise ValueError("an empty list of texts")
    return tuple(_coerce_text(x) for x in items)


#: how a setting or a wire's value is brought into each value port type
COERCE: dict[str, Callable[[object], Value]] = {
    "number": _coerce_number,
    "bool": bool,
    "text": _coerce_text,
    "texts": _coerce_texts,
    "colour": parse_colour,
    "colours": _coerce_colours,
    "numbers": _coerce_numbers,
}


def register_type(
    name: str, convert: Callable[[object], Value] | None = None, *, list_of: str = ""
) -> None:
    """Add a value port type of the host's own (say ``"pose"`` or ``"sound"``).

    *convert* brings a setting or a wire's value into the type and raises ``ValueError`` for
    one that does not fit (default: the value as it is). With *list_of* the type is a list
    of that item type, and one item may feed it. Tell the editor about the type too
    (its ``types`` option), so its dots and wires get a colour.
    """
    if name == "flow" or not name:
        raise ValueError("'flow' is the order of steps, not a value type")
    COERCE[name] = convert if convert is not None else (lambda value: value)
    if list_of:
        LIST_OF[name] = list_of


def coerce(value: object, port_type: PortType) -> Value:
    """Bring an option or wire value into the type of a value port.

    For a list port a single item becomes a list of one.
    """
    convert = COERCE.get(port_type)
    if convert is None:
        raise ValueError(f"unknown port type {port_type!r}")
    return convert(value)
