# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""The engine end to end: checks, chains, loops, values, a host's own blocks and types."""

import asyncio
from collections.abc import Mapping
from typing import Any, ClassVar

import pytest
from pydantic import Field

from noodlegraph import (
    STANDARD,
    Action,
    BlockOptions,
    Context,
    Engine,
    Graph,
    GraphError,
    GraphStore,
    Limits,
    Port,
    Value,
    ValueBlock,
    catalogue,
    check,
    dump,
    parse,
    parse_text,
    register_type,
    registry,
    ui,
)


class Stage(Context):
    """A host for the tests: remembers what the blocks did."""

    def __init__(self) -> None:
        self.said: list[Any] = []
        self.released = 0

    async def release(self) -> None:
        self.released += 1


class Say(Action):
    kind = "say"
    title = "Say"
    inputs: ClassVar[tuple[Port, ...]] = (Port("in", "flow"), Port("value", "number"))

    class Options(BlockOptions):
        value: float = 0.0
        lamp: str = Field(default="", json_schema_extra=ui("lamp"))

    async def run(self, inputs: Mapping[str, Value]) -> str:
        self.ctx.said.append(inputs["value"])
        return "out"

    @classmethod
    def problems(cls, options: BlockOptions, ctx: Context) -> list[str]:
        return ["no lamp called ghost"] if options.lamp == "ghost" else []  # type: ignore[attr-defined]


class Boom(Action):
    kind = "boom"
    title = "Boom"

    async def run(self, inputs: Mapping[str, Value]) -> str:
        raise RuntimeError("it broke")


REG = registry(STANDARD, Say, Boom)


def graph(
    nodes: list[dict[str, Any]], wires: list[tuple[str, str, str, str]], **more: Any
) -> Graph:
    return parse({
        "schema": "noodlegraph/1", "id": "g", "name": "G", "enabled": True,
        "nodes": [{"id": "t", "kind": "manual"}, *nodes],
        "wires": [{"from_node": a, "from_port": b, "to_node": c, "to_port": d} for a, b, c, d in wires],
        **more,
    })  # fmt: skip


class Rig:
    def __init__(self) -> None:
        self.ctx = Stage()
        self.events: list[tuple[str, str]] = []
        self.statuses: list[dict[str, Any]] = []
        self.done = asyncio.Event()
        self.engine = Engine(self.ctx, REG, on_event=self.on_event, on_status=self.statuses.append)

    async def on_event(self, _gid: str, payload: dict[str, Any]) -> None:
        self.events.append((payload["event"], payload["node"]))
        if payload["event"] in ("finished", "failed", "cancelled"):
            self.result = payload
            self.done.set()

    async def run(self, g: Graph, node: str = "t") -> dict[str, Any]:
        await self.engine.load([g])
        await self.engine.activate()
        await self.engine.fire(g.id, node)
        await asyncio.wait_for(self.done.wait(), 5)
        return self.result


def go(coro: Any) -> Any:
    return asyncio.run(coro)


def test_a_chain_runs_its_steps_in_order() -> None:
    async def main() -> None:
        rig = Rig()
        g = graph(
            [
                {"id": "a", "kind": "say", "options": {"value": 1}},
                {"id": "b", "kind": "say", "options": {"value": 2}},
            ],
            [("t", "out", "a", "in"), ("a", "out", "b", "in")],
        )
        result = await rig.run(g)
        assert result["event"] == "finished"
        assert rig.ctx.said == [1.0, 2.0]
        assert [e for e in rig.events if e[0] == "step"] == [("step", "a"), ("step", "b")]
        assert rig.statuses[-1]["graphs"]["g"]["last"]["result"] == "finished"

    go(main())


def test_for_counts_and_feeds_i_through_a_value_block() -> None:
    async def main() -> None:
        rig = Rig()
        g = graph(
            [
                {"id": "f", "kind": "for", "options": {"start": 1, "end": 3}},
                {"id": "m", "kind": "map_range", "options": {"in_min": 0, "in_max": 1, "out_min": 0, "out_max": 10, "clamp": False}},
                {"id": "s", "kind": "say"},
                {"id": "end", "kind": "say", "options": {"value": 99}},
            ],
            [("t", "out", "f", "in"), ("f", "each", "s", "in"), ("f", "i", "m", "value"),
             ("m", "result", "s", "value"), ("f", "done", "end", "in")],
        )  # fmt: skip
        assert (await rig.run(g))["event"] == "finished"
        assert rig.ctx.said == [10.0, 20.0, 30.0, 99.0]

    go(main())


def test_if_takes_the_branch_of_its_condition() -> None:
    async def main() -> None:
        rig = Rig()
        g = graph(
            [
                {"id": "c", "kind": "compare", "options": {"a": 5, "op": ">", "b": 3}},
                {"id": "i", "kind": "branch"},
                {"id": "yes", "kind": "say", "options": {"value": 1}},
                {"id": "no", "kind": "say", "options": {"value": 0}},
            ],
            [
                ("t", "out", "i", "in"),
                ("c", "result", "i", "condition"),
                ("i", "then", "yes", "in"),
                ("i", "else", "no", "in"),
            ],
        )
        await rig.run(g)
        assert rig.ctx.said == [1.0]

    go(main())


def test_a_list_item_follows_the_loop_and_count_feeds_the_loop() -> None:
    async def main() -> None:
        rig = Rig()
        g = graph(
            [
                {"id": "l", "kind": "number_list", "options": {"values": [7, 8, 9]}},
                {"id": "f", "kind": "for"},
                {"id": "s", "kind": "say"},
            ],
            [("t", "out", "f", "in"), ("l", "count", "f", "end"), ("f", "i", "l", "index"),
             ("l", "item", "s", "value"), ("f", "each", "s", "in")],
        )  # fmt: skip
        assert check(g, REG).valid  # count does not need 'no.', so this is no circle
        await rig.run(g)
        assert rig.ctx.said == [7.0, 8.0, 9.0]

    go(main())


def test_check_names_what_is_wrong() -> None:
    g = graph(
        [{"id": "a", "kind": "say"}, {"id": "w", "kind": "wait", "options": {"seconds": -1}},
         {"id": "x", "kind": "nope"}, {"id": "c", "kind": "compare"}],
        [("t", "out", "a", "value"), ("c", "result", "a", "value"), ("t", "out", "zzz", "in")],
    )  # fmt: skip
    problems = "\n".join(check(g, REG).problems)
    assert "unknown block type 'nope'" in problems
    assert "w (Wait): seconds" in problems
    assert "flow cannot feed number" in problems
    assert "bool cannot feed number" in problems
    assert "a block is missing" in problems


def test_a_circle_is_refused_and_the_host_is_asked() -> None:
    circle = graph(
        [{"id": "a", "kind": "say"}, {"id": "b", "kind": "say"}],
        [("t", "out", "a", "in"), ("a", "out", "b", "in"), ("b", "out", "a", "in")],
    )
    assert any("circle" in p for p in check(circle, REG).problems)
    ghost = graph([{"id": "a", "kind": "say", "options": {"lamp": "ghost"}}], [])
    assert check(ghost, REG).valid
    assert check(ghost, REG, Stage()).problems == ["a (Say): no lamp called ghost"]


def test_a_failing_block_ends_its_chain_not_the_engine() -> None:
    async def main() -> None:
        rig = Rig()
        g = graph([{"id": "b", "kind": "boom"}], [("t", "out", "b", "in")])
        result = await rig.run(g)
        assert (result["event"], result["message"]) == ("failed", "it broke")
        rig.done.clear()
        await rig.engine.fire("g", "t")  # still alive
        await asyncio.wait_for(rig.done.wait(), 5)

    go(main())


def test_deactivate_cancels_a_running_loop_and_releases() -> None:
    async def main() -> None:
        rig = Rig()
        g = graph(
            [{"id": "w", "kind": "while"}, {"id": "s", "kind": "say"}],
            [("t", "out", "w", "in"), ("w", "each", "s", "in"), ("w", "round", "s", "value")],
        )
        await rig.engine.load([g])
        await rig.engine.activate()
        await rig.engine.fire("g", "t")
        await asyncio.sleep(0.15)
        assert rig.engine.status()["graphs"]["g"]["running"] == ["t"]
        before = rig.ctx.released
        await rig.engine.deactivate()
        assert rig.result["event"] == "cancelled"
        assert rig.ctx.released == before + 1
        assert 2 <= len(rig.ctx.said) <= 12  # a round takes at least 20 ms
        assert rig.ctx.said[:2] == [1.0, 2.0]
        with pytest.raises(GraphError):
            await rig.engine.fire("g", "t")

    go(main())


def test_an_interval_trigger_starts_chains_while_active() -> None:
    async def main() -> None:
        rig = Rig()
        g = parse({
            "id": "tick", "enabled": True,
            "nodes": [{"id": "e", "kind": "interval", "options": {"every_s": 0.2}}, {"id": "s", "kind": "say", "options": {"value": 4}}],
            "wires": [{"from_node": "e", "from_port": "out", "to_node": "s", "to_port": "in"}],
        })  # fmt: skip
        await rig.engine.load([g])
        assert rig.ctx.said == []
        await rig.engine.activate()
        await asyncio.sleep(0.5)
        await rig.engine.deactivate()
        assert 2 <= len(rig.ctx.said) <= 4

    go(main())


def test_the_catalogue_describes_blocks_for_the_editor() -> None:
    blocks = {b["kind"]: b for b in catalogue(REG)}
    assert len(blocks) == len(STANDARD) + 2
    say = blocks["say"]
    assert say["category"] == "action"
    assert say["inputs"] == [
        {"name": "in", "type": "flow", "label": "in"},
        {"name": "value", "type": "number", "label": "value"},
    ]
    assert {f["name"]: f["kind"] for f in say["fields"]} == {"value": "float", "lamp": "lamp"}
    colours = blocks["colour_list"]["fields"][0]
    assert (colours["kind"], colours["min_items"], colours["max_items"]) == ("colours", 1, 64)
    assert blocks["compare"]["fields"][1]["options"] == [">", "<", ">=", "<=", "="]
    assert blocks["wait"]["fields"][0]["max"] == 3600.0
    assert blocks["manual"]["fields"][1]["label"] == "If still running"
    assert blocks["manual"]["fields"][0]["label"] == "Cooldown (s)"


def test_a_host_can_add_a_value_type() -> None:
    register_type("word", str)

    class Shout(ValueBlock):
        kind = "shout"
        title = "Shout"
        inputs: ClassVar[tuple[Port, ...]] = (Port("text", "word"),)
        outputs: ClassVar[tuple[Port, ...]] = (Port("loud", "word"),)

        class Options(BlockOptions):
            text: str = "hi"

        def compute(self, inputs: Mapping[str, Value]) -> Mapping[str, Value]:
            return {"loud": inputs["text"].upper()}

    class Print(Action):
        kind = "print"
        title = "Print"
        inputs: ClassVar[tuple[Port, ...]] = (Port("in", "flow"), Port("text", "word"))

        class Options(BlockOptions):
            text: str = ""

        async def run(self, inputs: Mapping[str, Value]) -> str:
            self.ctx.said.append(inputs["text"])
            return "out"

    async def main() -> None:
        rig = Rig()
        rig.engine.registry = registry(REG, Shout, Print)
        g = graph(
            [
                {"id": "s", "kind": "shout"},
                {"id": "p", "kind": "print"},
                {"id": "n", "kind": "number"},
            ],
            [("t", "out", "p", "in"), ("s", "loud", "p", "text")],
        )
        await rig.run(g)
        assert rig.ctx.said == ["HI"]
        bad = graph(
            [{"id": "p", "kind": "print"}, {"id": "n", "kind": "number"}],
            [("n", "value", "p", "text")],
        )
        assert any("number cannot feed word" in p for p in check(bad, rig.engine.registry).problems)

    go(main())


def test_files_round_trip_and_bad_ones_are_named(tmp_path: Any) -> None:
    g = graph([{"id": "a", "kind": "say", "position": [10, 20]}], [("t", "out", "a", "in")])
    assert parse_text(dump(g)) == g
    assert parse_text('{"id": "j", "nodes": [], "wires": []}').id == "j"  # JSON is YAML too
    store = GraphStore(tmp_path)
    store.save(g)
    (tmp_path / "broken.yaml").write_text("id: [")
    graphs, errors = store.load()
    assert graphs == [g]
    assert list(errors) == ["broken.yaml"]
    assert store.delete("g") and not store.delete("g")


def test_the_host_sets_the_limits() -> None:
    async def main() -> None:
        rig = Rig()
        rig.engine.limits = Limits(max_run_s=0.05, max_steps=3)
        result = await rig.run(
            graph(
                [{"id": "w", "kind": "wait", "options": {"seconds": 1}}], [("t", "out", "w", "in")]
            )
        )
        assert (result["event"], result["message"]) == (
            "failed",
            "stopped after 0.05 s (the longest a chain may run)",
        )
        rig.done.clear()
        many = [{"id": i, "kind": "say"} for i in "abcd"]
        wires = [
            ("t", "out", "a", "in"),
            ("a", "out", "b", "in"),
            ("b", "out", "c", "in"),
            ("c", "out", "d", "in"),
        ]
        assert (await rig.run(graph(many, wires)))["message"] == "too many steps"

    go(main())


def test_branches_run_at_the_same_time() -> None:
    async def main() -> None:
        rig = Rig()
        g = graph(
            [{"id": "a", "kind": "wait", "options": {"seconds": 0.15}}, {"id": "b", "kind": "wait", "options": {"seconds": 0.15}},
             {"id": "x", "kind": "say", "options": {"value": 1}}, {"id": "y", "kind": "say", "options": {"value": 2}}],
            [("t", "out", "a", "in"), ("t", "out", "b", "in"), ("a", "out", "x", "in"), ("b", "out", "y", "in")],
        )  # fmt: skip
        started = asyncio.get_running_loop().time()
        assert (await rig.run(g))["event"] == "finished"
        assert asyncio.get_running_loop().time() - started < 0.27  # not one after the other
        assert sorted(rig.ctx.said) == [1.0, 2.0]

    go(main())
