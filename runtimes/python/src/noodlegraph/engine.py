# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph.engine — runs graphs.

Rules the engine enforces, whatever a graph contains:

* graphs run only while the engine is active; :meth:`Engine.deactivate` cancels every
  chain, stops the triggers and calls :meth:`Context.release`. Nothing resumes by itself:
  when the engine is activated again the enabled graphs start from their triggers;
* a trigger only emits; the engine applies its cooldown and the "if still running" policy
  and starts the chain;
* a chain is one task that can be cancelled at any step and ends after
  :attr:`Limits.max_run_s` at the latest (unless it has a loop); a failing block ends its chain
  and is logged, never the engine;
* every chain runs as its own task, so several graphs (and several chains of one graph)
  run side by side.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from noodlegraph.blocks import (
    LOOP_DONE,
    LOOP_EACH,
    MIN_ROUND_S,
    Action,
    Block,
    Loop,
    Trigger,
    TriggerEvent,
    Value,
    ValueBlock,
    coerce,
)
from noodlegraph.context import Context
from noodlegraph.graph import Compiled, Registry, check, discover_blocks
from noodlegraph.model import Graph

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Limits:
    """How far a graph may go: the host sets what suits it (a show, a tool, a game)."""

    max_run_s: float | None = 3600.0  # the longest a chain without a loop may run; None: no end
    max_steps: int = 10_000  # steps of one chain, or of one round of a loop
    max_value_depth: int = 64  # value blocks feeding value blocks
    max_loop_depth: int = 8  # loops inside loops
    min_round_s: float = MIN_ROUND_S  # the shortest round of a loop, so a loop cannot hog the host
    max_call_depth: int = 16  # graphs running graphs running graphs


#: called with (graph id, {"event", "trigger", "node", "message"}); event is "started",
#: "step" (the chain reached this block), "finished", "failed" or "cancelled"
OnEvent = Callable[[str, dict[str, Any]], Awaitable[None] | None]
#: called with :meth:`Engine.status` whenever it changes
OnStatus = Callable[[dict[str, Any]], Awaitable[None] | None]


class GraphError(RuntimeError):
    """A graph that cannot do what was asked (shown to the user)."""


@dataclass(slots=True)
class _Run:
    """One run of one chain: what its steps need to read their inputs."""

    c: Compiled
    trigger_id: str
    event: TriggerEvent
    blocks: dict[str, Block] = field(default_factory=dict)
    loop_values: dict[tuple[str, str], Value] = field(default_factory=dict)  # inside rounds
    variables: dict[str, Value] = field(default_factory=dict)  # of the graph, shared by its chains
    calls: int = 0  # how deep in graphs running graphs


@dataclass(slots=True)
class _Loaded:
    compiled: Compiled
    triggers: dict[str, Trigger] = field(default_factory=dict)
    runs: dict[str, asyncio.Task[None]] = field(default_factory=dict)
    fired_at: dict[str, float] = field(default_factory=dict)
    last: dict[str, Any] | None = None
    variables: dict[str, Value] = field(default_factory=dict)

    @property
    def graph(self) -> Graph:
        return self.compiled.graph


class Engine:
    """Loads graphs, starts their triggers while it is active and runs their chains.

    *ctx* is the host as the blocks see it; *registry* the block types by kind (default:
    the standard blocks and those other installed packages add). *on_event* and *on_status*
    (plain or async functions) tell the host what happens, for a live editor or a log.
    """

    def __init__(
        self,
        ctx: Context | None = None,
        registry: Registry | None = None,
        *,
        limits: Limits | None = None,
        on_event: OnEvent | None = None,
        on_status: OnStatus | None = None,
    ) -> None:
        self.ctx = ctx if ctx is not None else Context()
        self.registry: Registry = registry if registry is not None else discover_blocks()
        self.limits = limits if limits is not None else Limits()
        self.on_event = on_event
        self.on_status = on_status
        self._loaded: dict[str, _Loaded] = {}
        self._active = False
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ lifecycle
    @property
    def active(self) -> bool:
        """Triggers are listening and chains may run."""
        return self._active

    async def activate(self) -> None:
        """Start the triggers of every enabled, valid graph."""
        if self._active:
            return
        async with self._lock:
            self._active = True
            await self._activate()
        await self._publish_status()

    async def deactivate(self) -> None:
        """Cancel every chain, stop the triggers and let go of everything (the STOP)."""
        if not self._active:
            return
        async with self._lock:
            self._active = False
            await self._deactivate()
        await self._publish_status()

    async def load(self, graphs: Iterable[Graph]) -> None:
        """Replace the graphs (after a save); running chains are cancelled."""
        async with self._lock:
            await self._deactivate()
            self._loaded = {g.id: _Loaded(check(g, self.registry, self.ctx)) for g in graphs}
            if self._active:
                await self._activate()
        await self._publish_status()

    def compiled(self, graph_id: str) -> Compiled | None:
        """The checked form of a loaded graph."""
        loaded = self._loaded.get(graph_id)
        return loaded.compiled if loaded else None

    # ------------------------------------------------------------------ activation
    async def _activate(self) -> None:
        for loaded in self._loaded.values():
            loaded.variables.clear()  # variables start empty with every activation
            c = loaded.compiled
            if not (c.graph.enabled and c.valid):
                continue
            for node_id in c.triggers:
                await self._start_trigger(loaded, node_id)

    async def _start_trigger(self, loaded: _Loaded, node_id: str) -> Trigger:
        trigger = loaded.triggers.get(node_id)
        if trigger is not None:
            return trigger
        c = loaded.compiled
        cls = c.classes[node_id]
        assert issubclass(cls, Trigger)

        def emit(event: TriggerEvent) -> None:
            self._fire(loaded, node_id, event)

        trigger = cls(node_id, c.options[node_id], self.ctx, emit)
        trigger.variables = loaded.variables
        loaded.triggers[node_id] = trigger
        try:
            await trigger.start()
        except Exception as exc:  # a block must not take the engine down
            log.warning("graph %s: trigger %s did not start: %s", c.graph.id, node_id, exc)
            loaded.last = self._result(node_id, "failed", f"trigger did not start: {exc}")
        return trigger

    async def _deactivate(self) -> None:
        tasks: list[asyncio.Task[None]] = []
        for loaded in self._loaded.values():
            tasks += list(loaded.runs.values())
            for trigger in loaded.triggers.values():
                with contextlib.suppress(Exception):
                    await trigger.stop()
            loaded.triggers.clear()
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        for loaded in self._loaded.values():
            loaded.runs.clear()
        with contextlib.suppress(Exception):
            await self.ctx.release()

    # ------------------------------------------------------------------ running
    async def fire(self, graph_id: str, node_id: str) -> None:
        """Start a chain from one of its triggers by hand (the editor's Run button)."""
        loaded = self._loaded.get(graph_id)
        if loaded is None:
            raise GraphError(f"no graph {graph_id!r}")
        c = loaded.compiled
        if not c.valid:
            raise GraphError("fix the graph's problems first: " + "; ".join(c.problems[:3]))
        if node_id not in c.triggers:
            raise GraphError(f"{node_id!r} is not a trigger block of this graph")
        if not self._active:
            raise GraphError("the engine is not active: activate it to run a graph")
        self._fire(loaded, node_id, TriggerEvent(self.ctx.clock()), forced=True)

    def run_buttons(self, graph_id: str) -> list[str]:
        """Ids of the graph's Run button blocks (trigger kind ``manual``)."""
        loaded = self._loaded.get(graph_id)
        if loaded is None:
            raise GraphError(f"no graph {graph_id!r}")
        return [n.id for n in loaded.graph.nodes if n.kind == "manual"]

    async def cancel(self, graph_id: str) -> list[str]:
        """Cancel the running chains of a graph; returns the triggers they started from.

        Its triggers keep listening: a chain may start again when one fires.
        """
        loaded = self._loaded.get(graph_id)
        if loaded is None:
            raise GraphError(f"no graph {graph_id!r}")
        stopped = [t for t, task in loaded.runs.items() if not task.done()]
        tasks = [loaded.runs[t] for t in stopped]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        return stopped

    def evaluate(self, graph_id: str, node_id: str, port: str) -> Value:
        """The value of an output of a value block right now, without running a chain.

        For graphs that only calculate (values in, values out) and for showing live values.
        Values of a trigger or of a loop exist only inside a chain and cannot be asked for.
        """
        loaded = self._loaded.get(graph_id)
        if loaded is None:
            raise GraphError(f"no graph {graph_id!r}")
        c = loaded.compiled
        if not c.valid:
            raise GraphError("fix the graph's problems first: " + "; ".join(c.problems[:3]))
        cls = c.classes.get(node_id)
        if cls is None or not issubclass(cls, ValueBlock):
            raise GraphError(f"{node_id!r} is not a value block of this graph")
        out = next((p for p in cls.outputs if p.name == port), None)
        if out is None:
            raise GraphError(f"{node_id!r} has no output {port!r}")
        run = _Run(c, "", TriggerEvent(self.ctx.clock()), variables=loaded.variables)
        return self._output(run, node_id, port, out.type, 0)

    def _fire(
        self, loaded: _Loaded, node_id: str, event: TriggerEvent, *, forced: bool = False
    ) -> None:
        if not self._active:
            return
        c = loaded.compiled
        options = c.options[node_id]
        cooldown = float(getattr(options, "cooldown_s", 0.0))
        last = loaded.fired_at.get(node_id)
        if not forced and last is not None and event.at - last < cooldown:
            return
        running = loaded.runs.get(node_id)
        if running is not None and not running.done():
            if not forced and getattr(options, "when_running", "ignore") == "ignore":
                return
            running.cancel()
        loaded.fired_at[node_id] = event.at
        task = asyncio.get_running_loop().create_task(self._run(loaded, node_id, event))
        loaded.runs[node_id] = task

    async def _run(self, loaded: _Loaded, trigger_id: str, event: TriggerEvent) -> None:
        gid = loaded.graph.id
        await self._event(gid, "started", trigger_id, trigger_id)
        await self._publish_status()
        result, message = "finished", ""
        try:
            # a graph with a loop may run as long as the engine is active; others have a limit
            limit = None if loaded.compiled.loops else self.limits.max_run_s
            await asyncio.wait_for(self._chain(loaded, trigger_id, event), limit)
        except asyncio.CancelledError:
            result = "cancelled"
            raise
        except TimeoutError:
            result, message = (
                "failed",
                f"stopped after {self.limits.max_run_s:g} s (the longest a chain may run)",
            )
        except Exception as exc:  # a block must not take the engine down
            result, message = "failed", str(exc) or type(exc).__name__
            log.warning("graph %s: chain from %s failed: %s", gid, trigger_id, message)
        finally:
            if loaded.runs.get(trigger_id) is asyncio.current_task():
                del loaded.runs[trigger_id]
            loaded.last = self._result(trigger_id, result, message)
            with contextlib.suppress(Exception):
                await asyncio.shield(self._after_run(gid, trigger_id, result, message))

    async def _after_run(self, gid: str, trigger_id: str, result: str, message: str) -> None:
        await self._event(gid, result, trigger_id, trigger_id, message)
        await self._publish_status()

    async def _chain(self, loaded: _Loaded, trigger_id: str, event: TriggerEvent) -> None:
        run = _Run(loaded.compiled, trigger_id, event, variables=loaded.variables)
        await self._follow(run, run.c.flow_next.get((trigger_id, "out"), []), 0)

    async def _follow(self, run: _Run, nodes: list[str], depth: int) -> None:
        """Continue at *nodes*: nowhere, at one, or at several at the same time.

        With several the chain goes on when all of them reached their end; one that fails
        stops the others.
        """
        if not nodes:
            return
        if len(nodes) == 1:
            await self._walk(run, nodes[0], depth)
            return
        try:
            async with asyncio.TaskGroup() as group:
                for node in nodes:
                    group.create_task(self._walk(run, node, depth))
        except BaseExceptionGroup as failed:
            raise failed.exceptions[0] from None

    async def _walk(self, run: _Run, node: str | None, depth: int) -> None:
        """Run the steps from *node* to the end of its branch (a loop's rounds included)."""
        if depth > self.limits.max_loop_depth:
            raise GraphError("loops nested too deep")
        c, steps = run.c, 0
        while node is not None:
            steps += 1
            if steps > self.limits.max_steps:
                raise GraphError("too many steps")
            block = self._block(run, node)
            if not isinstance(block, Action):
                raise GraphError(f"{node}: not an action")
            await self._event(c.graph.id, "step", run.trigger_id, node)
            if isinstance(block, Loop):
                await self._rounds(run, node, block, depth)
                nexts = c.flow_next.get((node, LOOP_DONE), [])
            else:
                port = await block.run(self._inputs(run, node, block))
                nexts = c.flow_next.get((node, port), [])
            if len(nexts) > 1:  # branches
                await self._follow(run, nexts, depth)
                return
            node = nexts[0] if nexts else None

    async def _rounds(self, run: _Run, node: str, block: Loop, depth: int) -> None:
        body = run.c.flow_next.get((node, LOOP_EACH), [])
        inputs = self._inputs(run, node, block)
        rounds = 0
        try:
            while block.again(inputs, rounds):
                for name, value in block.values(inputs, rounds).items():
                    run.loop_values[(node, name)] = value
                started = self.ctx.clock()
                await self._follow(run, body, depth + 1)
                rounds += 1
                took = self.ctx.clock() - started
                await self.ctx.sleep(max(self.limits.min_round_s - took, 0.0))  # lets others run
                if took >= 0.2 or rounds % 10 == 0:  # the editor lights the loop up, not too often
                    await self._event(run.c.graph.id, "step", run.trigger_id, node)
                if not block.fixed:
                    inputs = self._inputs(run, node, block)
        finally:
            for port in block.outputs:  # known only inside the rounds
                run.loop_values.pop((node, port.name), None)

    def _inputs(self, run: _Run, node: str, block: Block) -> dict[str, Value]:
        """The values of a step's inputs; one that replaces a setting only when it is wired."""
        return {
            p.name: self._value(run, node, p.name, 0)
            for p in block.inputs
            if p.type != "flow" and (not p.replaces or (node, p.name) in run.c.value_from)
        }

    def _block(self, run: _Run, node_id: str) -> Block:
        block = run.blocks.get(node_id)
        if block is None:
            cls = run.c.classes[node_id]
            block = run.blocks[node_id] = cls(node_id, run.c.options[node_id], self.ctx)
            block.variables = run.variables
            block.call = lambda graph_id: self._call(run, graph_id)
        return block

    async def _call(self, run: _Run, graph_id: str) -> None:
        """Run another graph as a step of this chain.

        The chain after its "When run by another graph" block, to its end. It is part of
        the calling chain (cancelled and limited with it) but works on its own graph's
        variables.
        """
        loaded = self._loaded.get(graph_id)
        if loaded is None:
            raise GraphError(f"there is no graph '{graph_id}' to run")
        c = loaded.compiled
        if not c.valid:
            raise GraphError(f"the graph '{graph_id}' has problems and cannot be run")
        entries = [n.id for n in c.graph.nodes if n.kind == "called"]
        if len(entries) != 1:
            raise GraphError(
                f"the graph '{graph_id}' needs one 'When run by another graph' block "
                f"(it has {len(entries)})"
            )
        if run.calls + 1 > self.limits.max_call_depth:
            raise GraphError("graphs run each other too deep")
        inner = _Run(
            c,
            entries[0],
            TriggerEvent(self.ctx.clock()),
            variables=loaded.variables,
            calls=run.calls + 1,
        )
        await self._follow(inner, c.flow_next.get((entries[0], "out"), []), 0)

    def _value(self, run: _Run, node_id: str, port: str, depth: int) -> Value:
        """The value of an input port: its wire, or else the block's own setting."""
        if depth > self.limits.max_value_depth:
            raise GraphError("value wires nested too deep")
        c = run.c
        cls = c.classes[node_id]
        port_type = next(p.type for p in cls.inputs if p.name == port)
        source = c.value_from.get((node_id, port))
        if source is None:
            return coerce(getattr(c.options[node_id], port), port_type)
        src_node, src_port = source
        src_cls = c.classes[src_node]
        if issubclass(src_cls, Trigger):
            if src_node != run.trigger_id or src_port not in run.event.values:
                raise GraphError(
                    f"{node_id}: the value of {src_node} is only known in its own chain"
                )
            return coerce(run.event.values[src_port], port_type)
        if issubclass(src_cls, Loop):
            if source not in run.loop_values:
                raise GraphError(
                    f"{node_id}: the {src_port} of {src_node} is only known inside its rounds"
                )
            return coerce(run.loop_values[source], port_type)
        return self._output(run, src_node, src_port, port_type, depth)

    def _output(self, run: _Run, node_id: str, port: str, port_type: str, depth: int) -> Value:
        """The value of an output port of a value block, brought into *port_type*."""
        block = self._block(run, node_id)
        if not isinstance(block, ValueBlock):
            raise GraphError(f"{node_id}: not a value block")
        need = type(block).depends.get(port)  # only what this output is computed from
        inputs = {
            p.name: self._value(run, node_id, p.name, depth + 1)
            for p in block.inputs
            if need is None or p.name in need
        }
        return coerce(block.compute(inputs)[port], port_type)

    # ------------------------------------------------------------------ reporting
    @staticmethod
    def _result(trigger_id: str, result: str, message: str = "") -> dict[str, Any]:
        return {"trigger": trigger_id, "result": result, "message": message, "ts": time.time()}

    def status(self) -> dict[str, Any]:
        """State of every loaded graph (also handed to ``on_status`` whenever it changes)."""
        return {
            "active": self._active,
            "graphs": {
                gid: {
                    "name": loaded.graph.name,
                    "enabled": loaded.graph.enabled,
                    "valid": loaded.compiled.valid,
                    "problems": list(loaded.compiled.problems),
                    "listening": sorted(loaded.triggers),
                    "running": sorted(t for t, task in loaded.runs.items() if not task.done()),
                    "last": loaded.last,
                }
                for gid, loaded in self._loaded.items()
            },
        }

    async def _publish_status(self) -> None:
        await self._tell(self.on_status, self.status())

    async def _event(
        self, gid: str, event: str, trigger: str, node: str, message: str = ""
    ) -> None:
        payload = {"event": event, "trigger": trigger, "node": node, "message": message}
        await self._tell(self.on_event, gid, payload)

    @staticmethod
    async def _tell(listener: Callable[..., Any] | None, *args: Any) -> None:
        """Call a listener of the host; one that fails is logged, never ends a chain."""
        if listener is None:
            return
        try:
            result = listener(*args)
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            log.exception("a listener of the engine failed")
