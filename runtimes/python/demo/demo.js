// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * The demo page: what a host application does around the editor.
 *
 *   load     GET  /api/state   -> blocks, choices, the graph, its problems
 *   save     POST /api/graph   -> the host checks the graph and runs it from now on
 *   run      POST /api/run     -> start a chain from a trigger block by hand
 *   live     GET  /api/events  -> which block a chain is at, what runs, the stage
 *
 * Without the demo server (the page opened from any static web server) the editor still
 * works on the example graph; nothing can be saved or run.
 */
import { createEditor } from "../../../editors/web/noodlegraph.js";

const $ = (id) => document.getElementById(id);
let saved = "";    // JSON of the graph as the host has it
let online = true;
let active = false;

async function call(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `The host answered ${res.status}.`);
  return data;
}

const say = (text, bad = false) => { $("notice").textContent = text; $("notice").classList.toggle("bad", bad); };
const dirty = () => JSON.stringify(editor.getGraph()) !== saved;
const mark = () => { $("save").textContent = dirty() ? "Save ●" : "Save"; };
const showProblems = (list) => $("problems").replaceChildren(...list.map((p) => Object.assign(document.createElement("li"), { textContent: p })));

const editor = createEditor($("editor"), {
  storageKey: "noodlegraph.demo",
  onChange: mark,
  onRun: async (node) => {
    if (!online) return say("Start the demo server to run a graph.", true);
    if (dirty()) return say("Save first: Run starts the saved graph.", true);
    try { await call("/api/run", { node }); say("Started."); } catch (err) { say(err.message, true); }
  },
  text: { how: [
    "A trigger starts a chain. Drag from the dot on the right of a block to the dot on the left of the next one, or click an open dot to pick what comes next. White wires are the order of steps; coloured wires carry a value into a setting.",
    "Save hands the graph to the host, which checks it and runs it while Active is on. Every chain runs on its own, so the button chain and the ticking chain do not wait for each other.",
  ] },
});

function open(graph) {
  editor.setGraph(graph);
  $("name").value = graph.name ?? "";
  mark();
  requestAnimationFrame(() => editor.fit());
}

async function save() {
  if (!online) return say("Start the demo server to save.", true);
  try {
    const res = await call("/api/graph", { graph: editor.getGraph() });
    editor.setGraph(res.graph, { keepView: true });
    saved = JSON.stringify(editor.getGraph());
    showProblems(res.problems);
    say(res.problems.length ? "Saved, but it cannot run yet: see the problems." : "Saved.", res.problems.length > 0);
  } catch (err) { say(err.message, true); }
  mark();
}

// ---------------------------------------------------------------------- the stage
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
  active = status.active;
  $("active").setAttribute("aria-checked", String(active));
  const mine = status.graphs?.demo;
  editor.setRunning(mine?.running ?? []);
  const last = mine?.last;
  $("last").textContent = last ? `Last run: ${last.result}${last.message ? ` (${last.message})` : ""}` : "";
}

// ---------------------------------------------------------------------- start
$("save").addEventListener("click", save);
$("name").addEventListener("input", () => {
  const graph = editor.getGraph();
  editor.setGraph({ ...graph, name: $("name").value }, { keepView: true });
  mark();
});
$("active").addEventListener("click", async () => {
  if (!online) return say("Start the demo server first.", true);
  try { await call("/api/active", { active: !active }); say(active ? "Stopped." : "Active."); } catch (err) { say(err.message, true); }
});
$("button").addEventListener("click", () => { if (online) call("/api/button", {}).catch(() => {}); });
$("slider").addEventListener("input", (ev) => {
  $("slider-value").textContent = ev.target.value;
  if (online) call("/api/slider", { value: Number(ev.target.value) }).catch(() => {});
});
$("export").addEventListener("click", () => {
  const graph = editor.getGraph();
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
  try { open(JSON.parse(await file.text())); say("Imported. Save to run it."); } catch { say("That file is not a graph (JSON).", true); }
});
window.addEventListener("beforeunload", (ev) => { if (online && dirty()) ev.preventDefault(); });

try {
  const state = await call("/api/state");
  editor.setBlocks(state.blocks);
  editor.setChoices(state.choices);
  open(state.graph);
  saved = JSON.stringify(editor.getGraph());
  mark();
  showProblems(state.problems);
  drawStage(state.stage);
  drawStatus(state.status);
  const events = new EventSource("/api/events");
  events.addEventListener("stage", (ev) => drawStage(JSON.parse(ev.data)));
  events.addEventListener("status", (ev) => drawStatus(JSON.parse(ev.data)));
  events.addEventListener("event", (ev) => { const e = JSON.parse(ev.data); if (e.event === "step") editor.step(e.node); });
} catch {
  // no host: the block catalogue and the example graph as files
  online = false;
  $("offline").hidden = false;
  const [blocks, graph] = await Promise.all([fetch("catalogue.json").then((r) => r.json()), fetch("example.json").then((r) => r.json())]);
  editor.setBlocks(blocks);
  editor.setChoices({ lamp: [{ value: "left", label: "Left lamp" }, { value: "right", label: "Right lamp" }] });
  open(graph);
  saved = JSON.stringify(editor.getGraph());
  mark();
}
