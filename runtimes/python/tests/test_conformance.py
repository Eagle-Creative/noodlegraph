# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""The shared test graphs (spec/tests): every runtime must treat them the same way."""

import asyncio
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, ClassVar

import pytest
from pydantic import Field

from noodlegraph import (
    STANDARD,
    Action,
    BlockOptions,
    Context,
    Engine,
    Port,
    Value,
    catalogue,
    check,
    parse,
    registry,
    ui,
)

SPEC = Path(__file__).resolve().parents[3] / "spec" / "tests"
CASES = json.loads((SPEC / "cases.json").read_text(encoding="utf-8"))["cases"]


def plain(value: Any) -> Any:
    """As JSON would carry it (tuples become lists)."""
    return json.loads(json.dumps(value))


class Log(Context):
    def __init__(self) -> None:
        self.log: list[Any] = []


def logger(
    kind_: str, title_: str, name: str, type_: str, annotation: Any, field: Any
) -> type[Action]:
    """A test block of the spec: writes what it gets into ctx.log."""
    options = type("Options", (BlockOptions,), {"__annotations__": {name: annotation}, name: field})

    class Logger(Action):
        kind = kind_
        title = title_
        inputs: ClassVar[tuple[Port, ...]] = (Port("in", "flow"), Port(name, type_))
        Options = options

        async def run(self, inputs: Mapping[str, Value]) -> str:
            self.ctx.log.append(inputs[name])
            return "out"

    return Logger


class Fail(Action):
    kind = "test_fail"
    title = "Fail"

    async def run(self, inputs: Mapping[str, Value]) -> str:
        raise RuntimeError("it broke")


TEST_BLOCKS = (
    logger("test_log", "Log", "value", "number", float, 0.0),
    logger("test_show", "Show", "text", "text", str, ""),
    logger(
        "test_paint",
        "Paint",
        "colour",
        "colour",
        str,
        Field(default="#000000", json_schema_extra=ui("colour")),
    ),
    logger(
        "test_paints",
        "Paints",
        "colours",
        "colours",
        tuple[str, ...],
        Field(default=("#000000",), json_schema_extra=ui("colours")),
    ),
    Fail,
)
REG = registry(STANDARD, TEST_BLOCKS)


def test_the_standard_blocks_are_described_exactly_as_the_spec_says() -> None:
    want = json.loads((SPEC / "standard-catalogue.json").read_text(encoding="utf-8"))
    assert plain(catalogue(registry(STANDARD))) == want


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_case(case: dict[str, Any]) -> None:
    graph = parse(case["graph"])
    if "problems" in case:
        problems = check(graph, REG).problems
        for want in case["problems"]:
            assert any(want in p for p in problems), f"missing {want!r} in {problems}"
        return
    assert check(graph, REG).problems == []

    async def main() -> None:
        ctx = Log()
        steps: list[str] = []
        ended: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        def on_event(_gid: str, e: dict[str, Any]) -> None:
            if e["event"] == "step":
                steps.append(e["node"])
            if e["event"] in ("finished", "failed", "cancelled"):
                ended.set_result(e)

        engine = Engine(ctx, REG, on_event=on_event)
        await engine.load([graph, *(parse(g) for g in case.get("with", []))])
        await engine.activate()
        if "evaluate" in case:
            assert plain(engine.evaluate(graph.id, *case["evaluate"])) == case["value"]
        else:
            await engine.fire(graph.id, case["fire"])
            end = await asyncio.wait_for(ended, 5)
            expect = case["expect"]
            assert end["event"] == expect["result"], end["message"]
            if "message" in expect:
                assert end["message"] == expect["message"]
            if "message_contains" in expect:
                assert expect["message_contains"] in end["message"]
            got, want = plain(ctx.log), expect["log"]
            if expect.get("log_any_order"):
                key = lambda x: (str(type(x)), json.dumps(x))  # noqa: E731
                got, want = sorted(got, key=key), sorted(want, key=key)
            assert got == want
            if "steps" in expect:
                assert steps == expect["steps"]
        await engine.deactivate()

    asyncio.run(main())
