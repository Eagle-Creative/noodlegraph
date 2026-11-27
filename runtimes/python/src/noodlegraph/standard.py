# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph.standard — the block types every host can use as they are.

Triggers that need nothing but a clock, waiting, If / For / While, and values (numbers,
lists, comparing, scaling, colours). A host adds its own blocks next to these:
``registry(STANDARD, MyAction, MyTrigger)``.

An option says how the editor shows it with ``json_schema_extra={"ui": ...}``: ``colour``,
``time``, a list (``colours`` or ``numbers``: one row per item, with add, remove and
move), or a kind of the host's own, which the editor shows as a dropdown of the host's
choices or with the host's own field.
"""

from __future__ import annotations

import asyncio
import contextlib
import random
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any, ClassVar, Literal, TypeVar

from pydantic import Field, JsonValue, field_validator

from noodlegraph.blocks import (
    FLOW_IN,
    MAX_LIST,
    Action,
    Block,
    BlockOptions,
    Loop,
    Port,
    Trigger,
    TriggerEvent,
    TriggerOptions,
    Value,
    ValueBlock,
    hue_colour,
    parse_colour,
)

MAX_WAIT_S = 3600.0


def ui(kind: str) -> dict[str, JsonValue]:
    """``json_schema_extra`` of an option the editor shows as *kind*."""
    return {"ui": kind}


_ui = ui
_T = TypeVar("_T")


def nth(items: Sequence[_T], number: Value, what: str = "item") -> _T:
    """The *number*-th of *items*, counting from 1; past the last it starts again at the first."""
    if not items:
        msg = f"no {what}"
        raise LookupError(msg)
    return items[(round(float(number)) - 1) % len(items)]


_nth = nth


class TaskTrigger(Trigger):
    """A trigger that runs one background task while it is started: write ``_watch``."""

    _task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """Begin watching."""
        self._task = asyncio.get_running_loop().create_task(self._watch())

    async def stop(self) -> None:
        """Stop watching."""
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _watch(self) -> None:
        raise NotImplementedError


_TaskTrigger = TaskTrigger


# ====================================================================== triggers
class OnStart(Trigger):
    """Fires once when the graph starts running (the engine activated, or the graph enabled)."""

    kind = "start"
    title = "When started"
    help = "Starts once when the engine is activated (or this graph is switched on)."

    class Options(TriggerOptions):
        """Settings of this block."""

        delay_s: float = Field(default=0.0, ge=0, le=3600, description="Wait this long first.")

    _task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """Begin watching."""

        async def later() -> None:
            await self.ctx.sleep(self.options.delay_s)
            self.emit(TriggerEvent(self.ctx.clock()))

        self._task = asyncio.get_running_loop().create_task(later())

    async def stop(self) -> None:
        """Stop watching."""
        if self._task is not None:
            self._task.cancel()
            self._task = None


class RunButton(Trigger):
    """Fires only from the *Run* button of the editor (or the API)."""

    kind = "manual"
    title = "Run button"
    help = "Starts when you press Run on this block. For testing and for manual cues."

    async def start(self) -> None:
        """Begin watching."""
        return None


class Interval(_TaskTrigger):
    """Fires every N seconds."""

    kind = "interval"
    title = "Every interval"
    help = "Starts again and again, with this time between starts."

    class Options(TriggerOptions):
        """Settings of this block."""

        every_s: float = Field(default=10.0, ge=0.2, le=86400, description="Seconds between.")
        first_now: bool = Field(default=True, description="Also start right away.")

    async def _watch(self) -> None:
        if not self.options.first_now:
            await self.ctx.sleep(self.options.every_s)
        while True:
            self.emit(TriggerEvent(self.ctx.clock()))
            await self.ctx.sleep(self.options.every_s)


class TimeOfDay(_TaskTrigger):
    """Fires at a time of day (the host's clock)."""

    kind = "time_of_day"
    title = "At a time of day"
    help = "Starts at this time, every day, by the clock of the host computer."

    class Options(TriggerOptions):
        """Settings of this block."""

        time: str = Field(default="18:00", json_schema_extra=_ui("time"), description="HH:MM")

        @field_validator("time")
        @classmethod
        def _hhmm(cls, v: str) -> str:
            datetime.strptime(v, "%H:%M")
            return v

    def _seconds_until(self, now: datetime) -> float:
        hh, mm = (int(x) for x in self.options.time.split(":"))
        target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        return (target - now).total_seconds()

    async def _watch(self) -> None:
        while True:
            await self.ctx.sleep(self._seconds_until(self.ctx.now()))
            self.emit(TriggerEvent(self.ctx.clock()))
            await self.ctx.sleep(1.0)  # leave the minute before looking again


# ====================================================================== actions
class Wait(Action):
    """Wait before the next step."""

    kind = "wait"
    title = "Wait"
    help = "Pauses the chain."
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow"), Port("seconds", "number"))

    class Options(BlockOptions):
        """Settings of this block."""

        seconds: float = Field(default=1.0, ge=0, le=MAX_WAIT_S)

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step."""
        await self.ctx.sleep(min(max(float(inputs["seconds"]), 0.0), MAX_WAIT_S))
        return "out"


# ====================================================================== logic
def _colour_list(v: tuple[str, ...]) -> tuple[str, ...]:
    """Check every ``#rrggbb`` of a list setting."""
    for c in v:
        parse_colour(c)
    return v


class For(Loop):
    """Count *i* from one number to another; run the round once for every *i*."""

    kind = "for"
    title = "For"
    help = (
        "Counts i from 'from' to 'to' (both included) in steps of 'step' and runs the blocks "
        "on 'each round' once for every i, then continues on 'done'. Wire i into a setting "
        "(a brightness, a position, a hue; Map range scales it). If 'from' is larger than "
        "'to' it counts down. Put a Wait in the round to set its pace."
    )
    inputs: ClassVar[tuple[Port, ...]] = (
        Port(FLOW_IN, "flow"),
        Port("start", "number", "from"),
        Port("end", "number", "to"),
        Port("step", "number", "step"),
    )
    outputs: ClassVar[tuple[Port, ...]] = (*Loop.outputs, Port("i", "number", "i"))
    fixed = True  # the bounds are read once, when the loop starts

    class Options(BlockOptions):
        """Settings of this block."""

        start: float = Field(default=1, title="From", description="The first i.")
        end: float = Field(default=5, title="To", description="The last i (included).")
        step: float = Field(default=1, gt=0, description="How much i changes each round.")

    @staticmethod
    def _bounds(inputs: Mapping[str, Value]) -> tuple[float, float, float]:
        start, end = float(inputs["start"]), float(inputs["end"])
        step = abs(float(inputs["step"]))
        if step == 0:
            msg = "For: a step of 0 never gets from 'from' to 'to'"
            raise ValueError(msg)
        return start, end, step if end >= start else -step

    def again(self, inputs: Mapping[str, Value], rounds: int) -> bool:
        """Another round while i has not passed 'to'."""
        start, end, step = self._bounds(inputs)
        return rounds <= int(abs(end - start) / abs(step) + 1e-9)

    def values(self, inputs: Mapping[str, Value], rounds: int) -> Mapping[str, Value]:
        """The value of i in this round."""
        start, _, step = self._bounds(inputs)
        return {"i": round(start + rounds * step, 9)}


class While(Loop):
    """Run the round again and again while a condition holds."""

    kind = "while"
    title = "While"
    help = (
        "Runs the blocks on 'each round' again and again while the condition is true "
        "(checked before every round), then continues on 'done'. With nothing wired and the "
        "condition ticked it runs for ever (until the engine is deactivated). 'round' counts 1, 2, 3 "
        "and can be wired into a setting. Put a Wait in the round to set its pace."
    )
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow"), Port("condition", "bool"))
    outputs: ClassVar[tuple[Port, ...]] = (*Loop.outputs, Port("round", "number", "round"))

    class Options(BlockOptions):
        """Settings of this block."""

        condition: bool = Field(default=True, description="Wire a condition here (Compare).")

    def again(self, inputs: Mapping[str, Value], rounds: int) -> bool:
        """Another round while the condition is true."""
        del rounds
        return bool(inputs["condition"])

    def values(self, inputs: Mapping[str, Value], rounds: int) -> Mapping[str, Value]:
        """The number of this round, from 1."""
        del inputs
        return {"round": rounds + 1}


class Branch(Action):
    """Continue on *then* or on *else*."""

    kind = "branch"
    title = "If"
    category = "logic"
    help = "Continues on 'then' if the condition is true, otherwise on 'else'."
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow"), Port("condition", "bool"))
    outputs: ClassVar[tuple[Port, ...]] = (Port("then", "flow"), Port("else", "flow"))

    class Options(BlockOptions):
        """Settings of this block."""

        condition: bool = True

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step."""
        return "then" if inputs["condition"] else "else"


# ====================================================================== values
class Number(ValueBlock):
    """A fixed number."""

    kind = "number"
    title = "Number"
    outputs: ClassVar[tuple[Port, ...]] = (Port("value", "number"),)

    class Options(BlockOptions):
        """Settings of this block."""

        value: float = 0.0

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        del inputs
        return {"value": float(self.options.value)}


def _list_values(items: Sequence[Value], inputs: Mapping[str, Value]) -> dict[str, Value]:
    """A list block's outputs; 'item' only when its 'no.' was asked for."""
    out: dict[str, Value] = {"list": tuple(items), "count": float(len(items))}
    if "index" in inputs:
        out["item"] = _nth(items, inputs["index"], "item")
    return out


_LIST_OUTPUTS_HELP = (
    "'item' is the one at 'no.' (1 = the first; past the last it starts again), so a For's i "
    "goes through them; 'count' is how many there are (wire it into a For's 'to')."
)


class ColourList(ValueBlock):
    """A list of colours: all of it, one item of it, and how many."""

    kind = "colour_list"
    title = "Colour list"
    help = (
        "Colours in order. 'list' feeds a setting that takes several colours; " + _LIST_OUTPUTS_HELP
    )
    inputs: ClassVar[tuple[Port, ...]] = (Port("index", "number", "no."),)
    outputs: ClassVar[tuple[Port, ...]] = (
        Port("list", "colours", "list"),
        Port("item", "colour", "item"),
        Port("count", "number", "count"),
    )
    depends: ClassVar[Mapping[str, tuple[str, ...]]] = {"list": (), "count": ()}

    class Options(BlockOptions):
        """Settings of this block."""

        colours: tuple[str, ...] = Field(
            default=("#ff0000", "#00ff00", "#0000ff"),
            min_length=1,
            max_length=MAX_LIST,
            json_schema_extra=_ui("colours"),
        )
        index: float = Field(
            default=1, title="No.", description="Which one 'item' is; 1 = the first."
        )

        @field_validator("colours")
        @classmethod
        def _colours(cls, v: tuple[str, ...]) -> tuple[str, ...]:
            return _colour_list(v)

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        return _list_values(tuple(parse_colour(c) for c in self.options.colours), inputs)


class NumberList(ValueBlock):
    """A list of numbers: all of it, one item of it, and how many."""

    kind = "number_list"
    title = "Number list"
    help = (
        "Numbers in order: positions to step through, brightness levels, waiting times. "
        + _LIST_OUTPUTS_HELP
    )
    inputs: ClassVar[tuple[Port, ...]] = (Port("index", "number", "no."),)
    outputs: ClassVar[tuple[Port, ...]] = (
        Port("list", "numbers", "list"),
        Port("item", "number", "item"),
        Port("count", "number", "count"),
    )
    depends: ClassVar[Mapping[str, tuple[str, ...]]] = {"list": (), "count": ()}

    class Options(BlockOptions):
        """Settings of this block."""

        values: tuple[float, ...] = Field(
            default=(0.0, 50.0, 100.0),
            min_length=1,
            max_length=MAX_LIST,
            json_schema_extra=_ui("numbers"),
        )
        index: float = Field(
            default=1, title="No.", description="Which one 'item' is; 1 = the first."
        )

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        return _list_values(tuple(float(v) for v in self.options.values), inputs)


class Text(ValueBlock):
    """A fixed text."""

    kind = "text"
    title = "Text"
    outputs: ClassVar[tuple[Port, ...]] = (Port("value", "text"),)

    class Options(BlockOptions):
        """Settings of this block."""

        value: str = ""

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        del inputs
        return {"value": self.options.value}


class TextList(ValueBlock):
    """A list of texts: all of it, one item of it, and how many."""

    kind = "text_list"
    title = "Text list"
    help = "Texts in order: lines to say, names to go through. " + _LIST_OUTPUTS_HELP
    inputs: ClassVar[tuple[Port, ...]] = (Port("index", "number", "no."),)
    outputs: ClassVar[tuple[Port, ...]] = (
        Port("list", "texts", "list"),
        Port("item", "text", "item"),
        Port("count", "number", "count"),
    )
    depends: ClassVar[Mapping[str, tuple[str, ...]]] = {"list": (), "count": ()}

    class Options(BlockOptions):
        """Settings of this block."""

        texts: tuple[str, ...] = Field(
            default=("one", "two", "three"),
            min_length=1,
            max_length=MAX_LIST,
            json_schema_extra=_ui("texts"),
        )
        index: float = Field(
            default=1, title="No.", description="Which one 'item' is; 1 = the first."
        )

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        return _list_values(tuple(self.options.texts), inputs)


class MapRange(ValueBlock):
    """Scale a number from one range to another."""

    kind = "map_range"
    title = "Map range"
    help = "Scales a number: in min..in max becomes out min..out max."
    inputs: ClassVar[tuple[Port, ...]] = (Port("value", "number"),)
    outputs: ClassVar[tuple[Port, ...]] = (Port("result", "number"),)

    class Options(BlockOptions):
        """Settings of this block."""

        value: float = 0.0
        in_min: float = 0.0
        in_max: float = 1.0
        out_min: float = 0.0
        out_max: float = 100.0
        clamp: bool = True

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        o = self.options
        span = o.in_max - o.in_min
        t = 0.0 if span == 0 else (float(inputs["value"]) - o.in_min) / span
        if o.clamp:
            t = min(max(t, 0.0), 1.0)
        return {"result": o.out_min + (o.out_max - o.out_min) * t}


class Compare(ValueBlock):
    """Compare two numbers."""

    kind = "compare"
    title = "Compare"
    inputs: ClassVar[tuple[Port, ...]] = (Port("a", "number"), Port("b", "number"))
    outputs: ClassVar[tuple[Port, ...]] = (Port("result", "bool"),)

    class Options(BlockOptions):
        """Settings of this block."""

        a: float = 0.0
        op: Literal[">", "<", ">=", "<=", "="] = ">"
        b: float = 0.0

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        a, b = float(inputs["a"]), float(inputs["b"])
        result = {">": a > b, "<": a < b, ">=": a >= b, "<=": a <= b, "=": a == b}
        return {"result": result[self.options.op]}


class ColourFromHue(ValueBlock):
    """A colour from a hue angle and a brightness."""

    kind = "colour_hue"
    title = "Colour from hue"
    help = "Hue 0-360 (0 red, 120 green, 240 blue) and brightness 0-100 make a colour."
    inputs: ClassVar[tuple[Port, ...]] = (Port("hue", "number"), Port("brightness", "number"))
    outputs: ClassVar[tuple[Port, ...]] = (Port("colour", "colour"),)

    class Options(BlockOptions):
        """Settings of this block."""

        hue: float = 0.0
        brightness: float = Field(default=50.0, ge=0, le=100)

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        return {"colour": hue_colour(float(inputs["hue"]), float(inputs["brightness"]))}


class Random(ValueBlock):
    """A random number, new every time it is used."""

    kind = "random"
    title = "Random"
    outputs: ClassVar[tuple[Port, ...]] = (Port("value", "number"),)

    class Options(BlockOptions):
        """Settings of this block."""

        min: float = 0.0
        max: float = 100.0

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        del inputs
        return {"value": random.uniform(self.options.min, self.options.max)}


# ====================================================================== variables
# A variable is a named value of its graph. It keeps what a chain stored in it until the
# engine is deactivated; one that was never set reads as 0, no, "" or black.
def _name() -> Any:
    return Field(
        default="x",
        json_schema_extra=_ui("variable"),
        description="Which variable. Blocks with the same name share it.",
    )


class _Setter(Action):
    """Stores the value of its input in a variable."""

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step."""
        self.variables[self.options.name] = inputs["value"]
        return "out"


class _Getter(ValueBlock):
    """Reads a variable."""

    unset: ClassVar[Value] = 0.0

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        del inputs
        return {"value": self.variables.get(self.options.name, self.unset)}


class _NameOnly(BlockOptions):
    """Settings of a block that reads a variable."""

    name: str = _name()


class SetNumber(_Setter):
    """Store a number."""

    kind = "set_number"
    title = "Set number"
    help = "Stores a number in a variable."
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow"), Port("value", "number"))

    class Options(BlockOptions):
        """Settings of this block."""

        name: str = _name()
        value: float = 0.0


class ChangeNumber(Action):
    """Add to a number."""

    kind = "change_number"
    title = "Change number"
    help = "Adds to the number in a variable (a negative number takes away). Counts things."
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow"), Port("by", "number"))

    class Options(BlockOptions):
        """Settings of this block."""

        name: str = _name()
        by: float = 1.0

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step."""
        now = self.variables.get(self.options.name, 0.0)
        if isinstance(now, bool) or not isinstance(now, int | float):
            msg = f"the variable '{self.options.name}' is not a number"
            raise TypeError(msg)
        self.variables[self.options.name] = now + inputs["by"]
        return "out"


class GetNumber(_Getter):
    """A stored number."""

    kind = "get_number"
    title = "Number variable"
    help = "The number stored in a variable; 0 if nothing was stored yet."
    outputs: ClassVar[tuple[Port, ...]] = (Port("value", "number"),)
    Options = _NameOnly


class SetText(_Setter):
    """Store a text."""

    kind = "set_text"
    title = "Set text"
    help = "Stores a text in a variable."
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow"), Port("value", "text"))

    class Options(BlockOptions):
        """Settings of this block."""

        name: str = _name()
        value: str = ""


class GetText(_Getter):
    """A stored text."""

    kind = "get_text"
    title = "Text variable"
    help = "The text stored in a variable; empty if nothing was stored yet."
    outputs: ClassVar[tuple[Port, ...]] = (Port("value", "text"),)
    Options = _NameOnly
    unset = ""


class SetBool(_Setter):
    """Store yes or no."""

    kind = "set_bool"
    title = "Set yes / no"
    help = "Stores yes or no in a variable."
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow"), Port("value", "bool"))

    class Options(BlockOptions):
        """Settings of this block."""

        name: str = _name()
        value: bool = True


class GetBool(_Getter):
    """A stored yes or no."""

    kind = "get_bool"
    title = "Yes / no variable"
    help = "The yes or no stored in a variable; no if nothing was stored yet."
    outputs: ClassVar[tuple[Port, ...]] = (Port("value", "bool"),)
    Options = _NameOnly
    unset = False


class SetColour(_Setter):
    """Store a colour."""

    kind = "set_colour"
    title = "Set colour"
    help = "Stores a colour in a variable."
    inputs: ClassVar[tuple[Port, ...]] = (Port(FLOW_IN, "flow"), Port("value", "colour"))

    class Options(BlockOptions):
        """Settings of this block."""

        name: str = _name()
        value: str = Field(default="#ff8800", json_schema_extra=_ui("colour"))


class GetColour(_Getter):
    """A stored colour."""

    kind = "get_colour"
    title = "Colour variable"
    help = "The colour stored in a variable; black if nothing was stored yet."
    outputs: ClassVar[tuple[Port, ...]] = (Port("value", "colour"),)
    Options = _NameOnly
    unset = (0, 0, 0)


# ====================================================================== graphs running graphs
class Called(Trigger):
    """Where another graph's "Run graph" block enters this graph."""

    kind = "called"
    title = "When run by another graph"
    help = (
        "Starts when a 'Run graph' block of another graph runs this graph. "
        "A graph has at most one of these."
    )

    async def start(self) -> None:
        """Begin watching."""
        return None


class Call(Action):
    """Run another graph and wait for it."""

    kind = "call"
    title = "Run graph"
    help = (
        "Runs another graph from its 'When run by another graph' block, waits until it is "
        "done, then continues. Build a sequence once and use it in several places."
    )

    class Options(BlockOptions):
        """Settings of this block."""

        graph: str = Field(json_schema_extra=_ui("graph"), description="Which graph to run.")

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step."""
        del inputs
        assert self.call is not None
        await self.call(self.options.graph)
        return "out"


#: the standard blocks, in the order the editor lists them
STANDARD: tuple[type[Block], ...] = (
    RunButton, OnStart, Interval, TimeOfDay, Called,
    Wait, Call, SetNumber, ChangeNumber, SetText, SetBool, SetColour, Branch, For, While,
    Number, NumberList, Text, TextList, ColourList, MapRange, Compare, ColourFromHue, Random,
    GetNumber, GetText, GetBool, GetColour,
)  # fmt: skip
