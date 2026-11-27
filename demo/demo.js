// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * The demo page: a small host application, all of it in the browser.
 *
 *   editor    ../editors/web            draws the graph
 *   runtime   ../runtimes/javascript    checks it and runs it, in this page
 *   blocks    ./blocks.js               the host's own blocks and its context (the stage)
 *
 * Save hands the graph from the editor to the engine (and keeps it in this browser). There
 * is no server behind it: any static web server will do.
 */
import { createEditor } from "../editors/web/noodlegraph.js";
import { Engine, STANDARD, catalogue, check, parse, registry } from "../runtimes/javascript/src/index.js";
import { CHOICES, DEMO_BLOCKS, Stage } from "./blocks.js";

const $ = (id) => document.getElementById(id);
const GRAPH_ID = "demo";
const STORE = "noodlegraph.demo.graph";
let saved = "";  // JSON of the graph as the engine has it

const say = (text, bad = false) => { $("notice").textContent = text; $("notice").classList.toggle("bad", bad); };
/** The graph as the page has it: what the editor holds, under the name in the bar. */
const current = () => ({ ...editor.getGraph(), name: $("name").value });
const dirty = () => JSON.stringify(current()) !== saved;
const mark = () => { $("save").textContent = dirty() ? "Save ●" : "Save"; };
const showProblems = (list) => $("problems").replaceChildren(...list.map((p) => Object.assign(document.createElement("li"), { textContent: p })));

// ---------------------------------------------------------------------- the host: stage, blocks, engine
function drawStage(stage) {
  for (const [id, colour] of Object.entries(stage.lamps)) {
    const lamp = $(`lamp-${id}`);
    lamp.style.background = colour;
    lamp.style.boxShadow = colour === "#000000" ? "none" : `0 0 18px 2px ${colour}`;
  }
  const hand = $("pointer");
  hand.style.transitionDuration = `${stage.pointer.seconds}s`;
  hand.style.transform = `rotate(${stage.pointer.angle}deg)`;
  $("line").textContent = stage.line;
}

function drawStatus(status) {
  $("active").setAttribute("aria-checked", String(status.active));
  const mine = status.graphs[GRAPH_ID];
  editor.setRunning(mine?.running ?? []);
  const last = mine?.last;
  $("last").textContent = last ? `Last run: ${last.result}${last.message ? ` (${last.message})` : ""}` : "";
}

const stage = new Stage(drawStage);
const blocks = registry(STANDARD, DEMO_BLOCKS);
const engine = new Engine({
  context: stage, registry: blocks,
  onEvent: (_graph, event) => { if (event.event === "step") editor.step(event.node); },
  onStatus: drawStatus,
});

// ---------------------------------------------------------------------- the editor
const editor = createEditor($("editor"), {
  blocks: catalogue(blocks),
  choices: CHOICES,
  storageKey: "noodlegraph.demo",
  onChange: mark,
  onRun: async (node) => {
    if (dirty()) return say("Save first: Run starts the saved graph.", true);
    try { await engine.fire(GRAPH_ID, node); say("Started."); } catch (err) { say(err.message, true); }
  },
  text: { how: [
    "A trigger starts a chain. Drag from the dot on the right of a block to the dot on the left of the next one, or click an open dot to pick what comes next. White wires are the order of steps; coloured wires carry a value into a setting.",
    "Save hands the graph to the engine, which checks it and runs it while Active is on. Every chain runs on its own, so the button chain and the ticking chain do not wait for each other. Two wires from one white dot: both ways run at the same time.",
  ] },
});

function open(graph) {
  $("name").value = graph.name ?? "";
  editor.setGraph(graph);
  mark();
  requestAnimationFrame(() => editor.fit());
}

/** Check the editor's graph, hand it to the engine and keep it in this browser. */
async function save() {
  let graph;
  try {
    graph = parse({ ...current(), id: GRAPH_ID, enabled: true });
  } catch (err) { say(err.message, true); return; }
  const problems = check(graph, blocks, stage).problems;
  await engine.load([graph]);
  saved = JSON.stringify(current());
  try { localStorage.setItem(STORE, saved); } catch { /* no storage: it runs, but is not kept */ }
  showProblems(problems);
  say(problems.length ? "Saved, but it cannot run yet: see the problems." : "Saved.", problems.length > 0);
  mark();
}

// ---------------------------------------------------------------------- the page
$("save").addEventListener("click", save);
$("name").addEventListener("input", mark);
$("active").addEventListener("click", async () => {
  if (engine.active) { await engine.deactivate(); say("Stopped."); } else { await engine.activate(); say("Active."); }
});
$("button").addEventListener("click", () => stage.press());
$("slider").addEventListener("input", (ev) => { $("slider-value").textContent = ev.target.value; stage.slider = Number(ev.target.value); });
$("export").addEventListener("click", () => {
  const graph = current();
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([JSON.stringify(graph, null, 1)], { type: "application/json" })),
    download: `${graph.id}.json`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
});
$("import").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try { open(parse(await file.text())); say("Imported. Save to run it."); } catch (err) { say(`That file is not a graph: ${err.message}`, true); }
});
$("reset").addEventListener("click", async () => {
  open(parse(await (await fetch("example.json")).json()));
  await save();
  say("Back to the example.");
});

// start: the graph this browser kept, else the example
let first = null;
try { first = parse(localStorage.getItem(STORE) ?? ""); } catch { /* none kept, or not a graph any more */ }
first ??= parse(await (await fetch("example.json")).json());
open(first);
await save();
say("");
drawStage(stage);
await engine.activate();
