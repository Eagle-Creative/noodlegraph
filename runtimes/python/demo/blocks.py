# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""The demo's own blocks: what a host application adds next to the standard ones.

The "host" here is a tiny stage drawn in the browser: two lamps, a pointer, a button, a
slider and a line of text. :class:`Stage` is the context its blocks work through.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, ClassVar

from pydantic import Field

from noodlegraph import (
    Action,
    BlockOptions,
    Context,
    Port,
    Trigger,
    TriggerEvent,
    Value,
    ValueBlock,
    ui,
)

LAMPS = {"left": "Left lamp", "right": "Right lamp"}


class Stage(Context):
    """The demo stage: its state, and who to tell when it changes."""

    def __init__(self, changed: Callable[[dict[str, Any]], None]) -> None:
        self.lamps = dict.fromkeys(LAMPS, "#000000")
        self.pointer = {"angle": 0.0, "seconds": 0.0}
        self.slider = 50.0
        self.line = ""
        self._changed = changed
        self._button: list[Callable[[], None]] = []

    def state(self) -> dict[str, Any]:
        """Everything the page draws."""
        return {"lamps": self.lamps, "pointer": self.pointer, "line": self.line}

    def tell(self) -> None:
        """The stage changed: draw it again."""
        self._changed(self.state())

    def on_button(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Call *listener* at every press of the button; returns how to stop that."""
        self._button.append(listener)
        return lambda: self._button.remove(listener)

    def press(self) -> None:
        """The button of the page was pressed."""
        for listener in list(self._button):
            listener()

    async def release(self) -> None:
        """Stopped: lamps off, pointer back."""
        self.lamps = dict.fromkeys(LAMPS, "#000000")
        self.pointer = {"angle": 0.0, "seconds": 0.3}
        self.line = ""
        self.tell()


def _hex(colour: Value) -> str:
    return "#{:02x}{:02x}{:02x}".format(*colour)


class ButtonPressed(Trigger):
    """Fires when the button on the stage is pressed."""

    kind = "button"
    title = "When the button is pressed"
    help = "Starts when you press the button on the stage."

    async def start(self) -> None:
        """Begin watching."""
        self._off = self.ctx.on_button(lambda: self.emit(TriggerEvent(self.ctx.clock())))

    async def stop(self) -> None:
        """Stop watching."""
        self._off()


class SetLamp(Action):
    """Give a lamp a colour."""

    kind = "set_lamp"
    title = "Set lamp"
    help = "Gives a lamp a colour. Black is off."
    inputs: ClassVar[tuple[Port, ...]] = (Port("in", "flow"), Port("colour", "colour"))

    class Options(BlockOptions):
        """Settings of this block."""

        lamp: str = Field(json_schema_extra=ui("lamp"), description="Which lamp.")
        colour: str = Field(default="#ff8800", json_schema_extra=ui("colour"))

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step."""
        self.ctx.lamps[self.options.lamp] = _hex(inputs["colour"])
        self.ctx.tell()
        return "out"

    @classmethod
    def problems(cls, options: BlockOptions, ctx: Context) -> list[str]:
        """What the stage lacks for these settings."""
        lamp = options.lamp  # type: ignore[attr-defined]
        return [] if lamp in LAMPS else [f"there is no lamp {lamp!r}"]


class MovePointer(Action):
    """Turn the pointer to an angle, taking a while."""

    kind = "move_pointer"
    title = "Move pointer"
    help = "Turns the pointer to an angle (0 to 180) and waits until it is there."
    inputs: ClassVar[tuple[Port, ...]] = (
        Port("in", "flow"),
        Port("angle", "number"),
        Port("seconds", "number"),
    )

    class Options(BlockOptions):
        """Settings of this block."""

        angle: float = Field(default=90.0, ge=0, le=180)
        seconds: float = Field(default=0.5, ge=0, le=60, description="How long the move takes.")

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step."""
        seconds = min(max(float(inputs["seconds"]), 0.0), 60.0)
        self.ctx.pointer = {
            "angle": min(max(float(inputs["angle"]), 0.0), 180.0),
            "seconds": seconds,
        }
        self.ctx.tell()
        await self.ctx.sleep(seconds)
        return "out"


class Say(Action):
    """Show a line of text on the stage."""

    kind = "say"
    title = "Say"
    help = "Shows a line of text on the stage."

    class Options(BlockOptions):
        """Settings of this block."""

        text: str = Field(default="Hello", max_length=80)

    async def run(self, inputs: Mapping[str, Value]) -> str:
        """Do the step."""
        self.ctx.line = self.options.text
        self.ctx.tell()
        return "out"


class Slider(ValueBlock):
    """The slider on the stage, 0 to 100."""

    kind = "slider"
    title = "Slider"
    help = "Where the slider on the stage stands, 0 to 100."
    outputs: ClassVar[tuple[Port, ...]] = (Port("value", "number"),)

    def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
        """The output values."""
        return {"value": float(self.ctx.slider)}


DEMO_BLOCKS = (ButtonPressed, SetLamp, MovePointer, Say, Slider)
#: what the settings of kind "lamp" offer in the editor
CHOICES = {"lamp": [{"value": k, "label": v} for k, v in LAMPS.items()]}
