// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
// The shared test graphs (spec/tests): every runtime must treat them the same way.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Context, Engine, STANDARD, catalogue, check, defineBlock, parse, registry } from "../src/index.js";

const spec = new URL("../../../spec/tests/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, spec), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));

/** The test blocks of the spec: they write what they get into ctx.log. */
const FLOW = { name: "in", type: "flow" };
const logger = (kind, title, name, type, fieldKind, start) => defineBlock({
  role: "action", kind, title, inputs: [FLOW, { name, type }], fields: [{ name, kind: fieldKind, default: start }],
  run({ ctx, inputs }) { ctx.log.push(inputs[name]); return "out"; },
});
export const TEST_BLOCKS = [
  logger("test_log", "Log", "value", "number", "float", 0),
  logger("test_show", "Show", "text", "text", "text", ""),
  logger("test_paint", "Paint", "colour", "colour", "colour", "#000000"),
  logger("test_paints", "Paints", "colours", "colours", "colours", ["#000000"]),
  defineBlock({ role: "action", kind: "test_fail", title: "Fail", run() { throw new Error("it broke"); } }),
];
const REG = registry(STANDARD, TEST_BLOCKS);

test("the standard blocks are described exactly as the spec says", () => {
  assert.deepEqual(plain(catalogue(registry(STANDARD))), read("standard-catalogue.json"));
});

for (const c of read("cases.json").cases) {
  test(c.name, async () => {
    const graph = parse(c.graph);
    if (c.problems) {
      const problems = check(graph, REG).problems;
      for (const want of c.problems) assert.ok(problems.some((p) => p.includes(want)), `missing "${want}" in:\n${problems.join("\n")}`);
      return;
    }
    assert.deepEqual(check(graph, REG).problems, []);
    const ctx = Object.assign(new Context(), { log: [] });
    const steps = [];
    let done;
    const ended = new Promise((resolve) => { done = resolve; });
    const engine = new Engine({ context: ctx, registry: REG, onEvent: (_gid, e) => {
      if (e.event === "step") steps.push(e.node);
      if (["finished", "failed", "cancelled"].includes(e.event)) done(e);
    } });
    await engine.load([graph, ...(c.with ?? []).map(parse)]);
    await engine.activate();
    if (c.evaluate) {
      assert.deepEqual(plain(engine.evaluate(graph.id, ...c.evaluate)), c.value);
    } else {
      await engine.fire(graph.id, c.fire);
      const end = await ended;
      assert.equal(end.event, c.expect.result, end.message);
      if (c.expect.message !== undefined) assert.equal(end.message, c.expect.message);
      if (c.expect.message_contains) assert.ok(end.message.includes(c.expect.message_contains), end.message);
      const order = (list) => (c.expect.log_any_order ? [...list].map((x) => JSON.stringify(x)).sort() : list);
      assert.deepEqual(order(plain(ctx.log)), order(c.expect.log));
      if (c.expect.steps) assert.deepEqual(steps, c.expect.steps);
    }
    await engine.deactivate();
  });
}
