// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
// The documentation page: a live editor at the top, and the list of standard blocks.
import { createEditor } from "../editors/web/noodlegraph.js";
import { Engine, STANDARD, VERSION, catalogue, check, parse, registry } from "../runtimes/javascript/src/index.js";
import { CHOICES, DEMO_BLOCKS, Stage } from "../demo/blocks.js";

const $ = (id) => document.getElementById(id);
$("version").textContent = VERSION;

// ---------------------------------------------------------------------- the live editor
const W = (a, b, c, d) => ({ from_node: a, from_port: b, to_node: c, to_port: d });
const GRAPH = {
  id: "try", name: "Try it", enabled: true,
  nodes: [
    { id: "button", kind: "button", options: {}, position: [10, 20] },
    { id: "for", kind: "for", options: { end: 3 }, position: [250, 20] },
    { id: "colours", kind: "colour_list", options: { colours: ["#ff3b30", "#ffcc00", "#34c759"] }, position: [250, 190] },
    { id: "lamp", kind: "set_lamp", options: { lamp: "left" }, position: [500, 60] },
    { id: "wait", kind: "wait", options: { seconds: 0.35 }, position: [740, 60] },
    { id: "say", kind: "say", options: { text: "Done!" }, position: [500, -70] },
    { id: "right", kind: "set_lamp", options: { lamp: "right", colour: "#0a84ff" }, position: [500, -200] },
  ],
  wires: [
    W("button", "out", "for", "in"), W("for", "each", "lamp", "in"), W("for", "i", "colours", "index"), W("colours", "item", "lamp", "colour"),
    W("lamp", "out", "wait", "in"), W("for", "done", "say", "in"), W("for", "done", "right", "in"),
  ],
};

function draw(stage) {
  for (const [id, colour] of Object.entries(stage.lamps)) {
    const lamp = $(`lamp-${id}`);
    lamp.style.background = colour;
    lamp.style.boxShadow = colour === "#000000" ? "none" : `0 0 18px 2px ${colour}`;
  }
  $("line").textContent = stage.line;
}

const stage = new Stage(draw);
const blocks = registry(STANDARD, DEMO_BLOCKS.filter((b) => b.kind !== "move_pointer" && b.kind !== "slider"));
let editor;
const engine = new Engine({
  context: stage, registry: blocks,
  onEvent: (_graph, event) => { if (event.event === "step") editor?.step(event.node); },
  onStatus: (status) => editor?.setRunning(status.graphs.try?.running ?? []),
});

/** What is drawn is what runs: every change goes to the engine. */
async function run(graph) {
  let parsed;
  try { parsed = parse({ ...graph, id: "try", enabled: true }); } catch (err) { $("state").textContent = err.message; return; }
  const problems = check(parsed, blocks, stage).problems;
  await engine.load([parsed]);
  $("state").textContent = problems.length
    ? `It cannot run yet: ${problems[0]}`
    : "This graph is running in your browser. Press Button, then change the graph: it runs as you edit.";
  $("state").classList.toggle("bad", problems.length > 0);
}

// on a small screen the canvas gets the room: Blocks starts folded (one tap opens it)
try { if (window.innerWidth < 700 && localStorage.getItem("noodlegraph.docs.drawer") === null) localStorage.setItem("noodlegraph.docs.drawer", "false"); } catch { /* no storage */ }
let waiting = 0;
editor = createEditor($("editor"), {
  blocks: catalogue(blocks),
  choices: CHOICES,
  graph: GRAPH,
  storageKey: "noodlegraph.docs",
  onChange: (graph) => { clearTimeout(waiting); waiting = setTimeout(() => run(graph), 250); },
  onRun: (node) => engine.fire("try", node).catch((err) => { $("state").textContent = err.message; }),
});
$("button").addEventListener("click", () => stage.press());
await run(GRAPH);
await engine.activate();
requestAnimationFrame(() => editor.fit());

// ---------------------------------------------------------------------- the standard blocks, from the runtime itself
const GROUPS = { trigger: "Triggers", action: "Actions", logic: "Logic", value: "Values" };
const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? "", textContent: text ?? "" });
const list = $("standard-list");
for (const [category, title] of Object.entries(GROUPS)) {
  const group = el("div", `blockgroup cat-${category}`);
  group.append(el("h3", "", title));
  for (const block of catalogue(registry(STANDARD)).filter((b) => b.category === category)) {
    const item = el("div", "blockitem");
    item.append(el("strong", "", block.title), el("code", "", block.kind), el("p", "", block.help || ""));
    group.append(item);
  }
  list.append(group);
}
