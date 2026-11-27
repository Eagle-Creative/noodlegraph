// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
// What the shared test graphs cannot show: time, cancelling, triggers, limits, a host's own things.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context, Engine, GraphError, STANDARD, catalogue, check, defineBlock, parse, registerType, registry } from "../src/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const Say = defineBlock({
  role: "action", kind: "say", title: "Say",
  inputs: [{ name: "in", type: "flow" }, { name: "value", type: "number" }],
  fields: [{ name: "value", kind: "float", default: 0 }, { name: "lamp", kind: "lamp", default: "" }],
  run({ ctx, inputs }) { ctx.said.push(inputs.value); return "out"; },
  problems: ({ options }) => (options.lamp === "ghost" ? ["no lamp called ghost"] : []),
});
const REG = registry(STANDARD, Say);

class Stage extends Context {
  said = [];
  released = 0;
  async release() { this.released += 1; }
}

const graph = (nodes, wires, more = {}) => parse({
  id: "g", enabled: true, nodes: [{ id: "t", kind: "manual" }, ...nodes],
  wires: wires.map(([a, b, c, d]) => ({ from_node: a, from_port: b, to_node: c, to_port: d })), ...more,
});

function rig(options = {}) {
  const ctx = new Stage(), events = [];
  const engine = new Engine({ context: ctx, registry: REG, onEvent: (_g, e) => events.push(e), ...options });
  const ended = () => events.filter((e) => ["finished", "failed", "cancelled"].includes(e.event));
  return { ctx, engine, events, ended };
}

test("deactivate cancels a running loop, releases, and nothing runs afterwards", async () => {
  const r = rig();
  await r.engine.load([graph([{ id: "w", kind: "while" }, { id: "s", kind: "say" }], [["t", "out", "w", "in"], ["w", "each", "s", "in"], ["w", "round", "s", "value"]])]);
  await r.engine.activate();
  await r.engine.fire("g", "t");
  await sleep(150);
  assert.deepEqual(r.engine.status().graphs.g.running, ["t"]);
  const before = r.ctx.released;
  await r.engine.deactivate();
  assert.equal(r.ended().at(-1).event, "cancelled");
  assert.equal(r.ctx.released, before + 1);
  assert.ok(r.ctx.said.length >= 2 && r.ctx.said.length <= 12, `rounds: ${r.ctx.said.length}`);  // a round takes at least 20 ms
  assert.deepEqual(r.ctx.said.slice(0, 2), [1, 2]);
  await assert.rejects(r.engine.fire("g", "t"), GraphError);
  const count = r.ctx.said.length;
  await sleep(60);
  assert.equal(r.ctx.said.length, count);
});

test("an interval trigger starts chains only while the engine is active", async () => {
  const r = rig();
  await r.engine.load([parse({ id: "tick", enabled: true,
    nodes: [{ id: "e", kind: "interval", options: { every_s: 0.2 } }, { id: "s", kind: "say", options: { value: 4 } }],
    wires: [{ from_node: "e", from_port: "out", to_node: "s", to_port: "in" }] })]);
  assert.deepEqual(r.ctx.said, []);
  await r.engine.activate();
  assert.deepEqual(r.engine.status().graphs.tick.listening, ["e"]);
  await sleep(500);
  await r.engine.deactivate();
  assert.ok(r.ctx.said.length >= 2 && r.ctx.said.length <= 4, `starts: ${r.ctx.said.length}`);
});

test("a trigger that fires while its chain runs is ignored, or restarts it", async () => {
  for (const [policy, want] of [["ignore", [1]], ["restart", [1, 1]]]) {
    const r = rig();
    let press;
    const button = defineBlock({ role: "trigger", kind: "button", title: "Button", start: ({ emit }) => { press = emit; return () => { press = null; }; } });
    r.engine.registry = registry(REG, button);
    await r.engine.load([parse({ id: "g", enabled: true,
      nodes: [{ id: "b", kind: "button", options: { when_running: policy } }, { id: "s", kind: "say", options: { value: 1 } }, { id: "w", kind: "wait", options: { seconds: 0.15 } }, { id: "e", kind: "say", options: { value: 2 } }],
      wires: [["b", "out", "s", "in"], ["s", "out", "w", "in"], ["w", "out", "e", "in"]].map(([a, b, c, d]) => ({ from_node: a, from_port: b, to_node: c, to_port: d })) })]);
    await r.engine.activate();
    press();
    await sleep(40);
    press();
    await sleep(60);
    assert.deepEqual(r.ctx.said, want, policy);
    await sleep(200);
    assert.deepEqual(r.ctx.said, [...want, 2], policy);
    await r.engine.deactivate();
    assert.equal(press, null);
  }
});

test("the host sets the limits", async () => {
  const r = rig({ limits: { maxRunS: 0.05, maxSteps: 3 } });
  await r.engine.load([graph([{ id: "w", kind: "wait", options: { seconds: 1 } }], [["t", "out", "w", "in"]])]);
  await r.engine.activate();
  await r.engine.fire("g", "t");
  await sleep(120);
  assert.deepEqual([r.ended()[0].event, r.ended()[0].message], ["failed", "stopped after 0.05 s (the longest a chain may run)"]);
  const many = ["a", "b", "c", "d"].map((id) => ({ id, kind: "say" }));
  await r.engine.load([graph(many, [["t", "out", "a", "in"], ["a", "out", "b", "in"], ["b", "out", "c", "in"], ["c", "out", "d", "in"]])]);
  await r.engine.fire("g", "t");
  await sleep(30);
  assert.equal(r.ended().at(-1).message, "too many steps");
});

test("the host is asked about what a setting names, and adds a value type", async () => {
  const ghost = graph([{ id: "a", kind: "say", options: { lamp: "ghost" } }], []);
  assert.ok(check(ghost, REG).valid);
  assert.deepEqual(check(ghost, REG, new Stage()).problems, ["a (Say): no lamp called ghost"]);

  registerType("pose", (v) => { if (!v || typeof v.x !== "number") throw new Error("not a pose"); return v; });
  const Home = defineBlock({ role: "value", kind: "home", title: "Home", outputs: [{ name: "pose", type: "pose" }], compute: () => ({ pose: { x: 3 } }) });
  const Go = defineBlock({
    role: "action", kind: "go", title: "Go", inputs: [{ name: "in", type: "flow" }, { name: "pose", type: "pose" }],
    run({ ctx, inputs }) { ctx.said.push(inputs.pose.x); return "out"; },
  });
  const reg = registry(REG, Home, Go);
  const r = rig();
  r.engine.registry = reg;
  await r.engine.load([graph([{ id: "h", kind: "home" }, { id: "go", kind: "go" }], [["t", "out", "go", "in"], ["h", "pose", "go", "pose"]])]);
  await r.engine.activate();
  await r.engine.fire("g", "t");
  await sleep(20);
  assert.deepEqual(r.ctx.said, [3]);
  const bad = graph([{ id: "n", kind: "number" }, { id: "go", kind: "go" }], [["n", "value", "go", "pose"]]);
  assert.ok(check(bad, reg).problems.some((p) => p.includes("number cannot feed pose")));
  assert.equal(catalogue(reg).find((b) => b.kind === "go").inputs[1].type, "pose");
  await r.engine.deactivate();
});

test("a graph file with mistakes is refused with what is wrong", () => {
  assert.throws(() => parse({ id: "Bad Id", nodes: [{ id: "a", kind: "wait" }, { id: "a", kind: "wait" }], colour: 1 }), /colour: Extra inputs.*id: .*block ids must be unique/s);
  assert.throws(() => parse("{"), /not valid JSON/);
  assert.equal(parse('{"id": "j"}').enabled, false);
});

test("branches run at the same time", async () => {
  const r = rig();
  await r.engine.load([graph(
    [{ id: "a", kind: "wait", options: { seconds: 0.15 } }, { id: "b", kind: "wait", options: { seconds: 0.15 } }, { id: "x", kind: "say", options: { value: 1 } }, { id: "y", kind: "say", options: { value: 2 } }],
    [["t", "out", "a", "in"], ["t", "out", "b", "in"], ["a", "out", "x", "in"], ["b", "out", "y", "in"]])]);
  await r.engine.activate();
  const started = Date.now();
  await r.engine.fire("g", "t");
  while (!r.ended().length) await sleep(5);
  assert.equal(r.ended()[0].event, "finished");
  assert.ok(Date.now() - started < 270, "one after the other");
  assert.deepEqual([...r.ctx.said].sort(), [1, 2]);
  await r.engine.deactivate();
});
