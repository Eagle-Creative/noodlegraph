// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * noodlegraph — an editor for behaviour built from blocks.
 *
 * A trigger block starts a chain of action blocks along the white "flow" wires; coloured
 * value wires feed a block's settings. The picture is the file: blocks (nodes) and wires are
 * kept as they are drawn, in one JSON document the host saves, checks and runs (the Python
 * package `noodlegraph` does that; any runner that reads the document will do).
 *
 *   import { createEditor } from "./noodlegraph.js";
 *   const editor = createEditor(document.querySelector("#editor"), {
 *     blocks,                       // the block types: catalogue(registry) of the Python package
 *     graph,                        // the document to edit, or null
 *     onChange: (graph) => { ... }, // after every edit
 *     onRun: (nodeId) => { ... },   // the ▶ on a trigger block (left out: no ▶)
 *   });
 *
 * Clicking a dot (or dropping a wire on empty canvas) lists the blocks that fit it. While a
 * wire is dragged the dots it may end at light up. An output may go to several places.
 * Undo and redo, Shift to select several blocks, copy, paste and duplicate, notes on the canvas.
 * A list setting (colours, numbers) is edited as rows: add, remove, move up / down; a list
 * wire is drawn thick, and one colour or number may feed a list input.
 *
 * No dependencies and no build step. Needs noodlegraph.css and panzoom.js next to it.
 */
import { attach as attachPanZoom } from "./panzoom.js";

export const SCHEMA = "noodlegraph/1";

const SVG_NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") { if (v) node.className = v; }
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
};
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  return node;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const port = (list, name) => list.find((p) => p.name === name);

/** The block groups every editor starts with, in the order Blocks lists them. */
const CATEGORIES = { trigger: { title: "Triggers" }, action: { title: "Actions" }, logic: { title: "Logic" }, value: { title: "Values" } };
/** The list types every editor starts with, and the type of one item. */
const TYPES = { colours: { listOf: "colour" }, numbers: { listOf: "number" }, texts: { listOf: "text" } };
/** Colours a new row of a colour list starts with: the first one not in the list yet. */
const NEW_COLOURS = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#ffffff", "#ff8800"];
/** What was copied: shared by every editor on the page. */
const clipboard = { piece: null, pastes: 0 };
/** Which groups come first in the suggestions: after a step the next steps; into a setting the values. */
const RANK = { out: ["action", "logic", "value", "trigger"], in: ["value", "trigger", "action", "logic"] };
/**
 * Every word the editor shows. Replace any of them with the `text` option (another language,
 * other terms: "node" for "block"). A function gets the parts it puts into its sentence.
 */
export const TEXT = {
  empty: "Start with a trigger: drag one from Blocks onto this canvas, or click it.",
  blocks: "Blocks",
  blocksLabel: "Blocks to add",
  settingsLabel: "Block settings",
  hint: "Drag a block onto the canvas, or click it. Click an open dot on a block to add what fits there.",
  readOnly: "This graph cannot be changed here.",
  howTitle: "How it works",
  how: [
    "A trigger starts a chain. Drag from the dot on the right of a block to the dot on the left of the next one, or click an open dot to pick what comes next. White wires are the order of steps; coloured wires carry a value into a setting.",
  ],
  hideBlocks: "Hide the blocks (more room for the canvas)",
  showBlocks: "Show the blocks to add",
  run: "Run this chain now",
  runNow: "Run now",
  unknownBlock: (kind) => `Unknown block: ${kind}`,
  addHere: "click to add a block here",
  // wiring
  feedsItself: "A block cannot feed itself.",
  noPort: "No such port.",
  cannotFeed: (outType, inType) => `A ${outType} output cannot feed a ${inType} input.`,
  // suggestions at a dot
  nextStep: "Next step",
  beforeStep: "Before this step",
  useIn: (label) => `Use “${label}” in`,
  from: (label) => `“${label}” from`,
  newBlock: "New block",
  inGraph: "In this graph",
  noFit: "No block fits.",
  find: "Find a block",
  // settings
  close: "Close the settings",
  closeHint: "Close (click empty canvas)",
  wire: "Wire",
  removeWire: "Remove wire",
  removeBlock: "Remove block",
  fromWire: "from the wire",
  fromWireNth: "from the wire: the n-th in this list (1 = the first)",
  choose: "choose…",
  nothingToChoose: "nothing to choose from",
  notThere: (value) => `${value} (not there)`,
  // lists
  moveUp: "Move up",
  moveDown: "Move down",
  remove: "Remove",
  add: { colour: "+ Colour", number: "+ Number", text: "+ Text", item: "+ Item" },
  ofUpTo: (count, max) => `${count} of up to ${max}`,
  colourCount: (count) => `${count} colour${count === 1 ? "" : "s"}`,
  // several blocks, history
  blocksCount: (count) => `${count} blocks`,
  removeBlocks: "Remove blocks",
  duplicate: "Duplicate",
  note: "Note",
  addNote: "Add a note to the canvas",
  notePlaceholder: "Write a note",
  removeNote: "Remove this note",
  noteLabel: "Note",
  undo: "Undo (Ctrl+Z)",
  redo: "Redo (Ctrl+Shift+Z)",
  // zoom
  zoomOut: "Zoom out (−)",
  zoomIn: "Zoom in (+)",
  zoomReset: "Zoom to 100 %",
  zoomFit: "Show everything (0)",
  fit: "Fit",
  zoomLabel: "Zoom",
};

/** A free id from *prefix* ("Wait" -> wait, wait2, ...), given the ids already *taken*. */
export function freeId(prefix, taken, fallback = "graph") {
  const stem = String(prefix).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || fallback;
  let id = stem;
  for (let n = 2; taken.has(id); n++) id = `${stem}${n}`;
  return id;
}

/** An empty graph document. */
export function emptyGraph(id = "graph", name = "New graph") {
  return { schema: SCHEMA, id, name, description: "", enabled: false, nodes: [], wires: [] };
}

/**
 * Put an editor into *root* (an element with a height) and return its handle.
 *
 * Options (all optional):
 *   blocks       the block types (see README: "The block catalogue")
 *   graph        the document to edit
 *   readOnly     look, select and pan, but change nothing
 *   categories   { id: { title, colour } } block groups of the host, after the four built in
 *   types        { name: { colour, listOf } } value types of the host (dot and wire colour)
 *   choices      { fieldKind: [{ value, label }] }, or (fieldKind, field, node) => list | null:
 *                what a setting of the host's own kind offers (its lamps, its motors)
 *   fields       { fieldKind: ({ node, field, value, set, disabled }) => Element }: a setting
 *                drawn by the host
 *   quiet        setting names left out of a block's summary line
 *   storageKey   name under which this browser remembers zoom and folded groups
 *   text         other wording: any entry of TEXT in this file (another language, other terms)
 *   onChange(graph), onSelect(selection), onRun(nodeId)
 */
export function createEditor(root, options = {}) {
  const o = options;
  const text = { ...TEXT, ...(o.text ?? {}), add: { ...TEXT.add, ...(o.text?.add ?? {}) } };
  const storageKey = o.storageKey ?? "noodlegraph";
  const quiet = new Set(o.quiet ?? ["cooldown_s", "when_running"]);
  const categories = { ...CATEGORIES, ...(o.categories ?? {}) };
  const types = { ...TYPES, ...(o.types ?? {}) };
  const listOf = (type) => types[type]?.listOf;
  const fits = (outType, inType) => outType === inType || listOf(inType) === outType;

  const r = {
    blocks: new Map(),     // kind -> block type
    doc: null,             // the graph being edited (a working copy)
    selected: null,        // { node } or { wire }
    notice: "",            // why the last wire could not be made
    readOnly: Boolean(o.readOnly),
    running: new Set(),    // ids of blocks whose chain runs now
    choices: o.choices ?? {},
  };

  // ------------------------------------------------------------------ the frame
  const palette = el("aside", { class: "ng-palette", "aria-label": text.blocksLabel });
  const empty = el("p", { class: "ng-empty ng-help", hidden: true }, text.empty);
  const wires = svg("svg", { class: "ng-wires", "aria-hidden": "true" });
  const nodes = el("div", { class: "ng-nodes", role: "list", "aria-label": text.blocks });
  const notes = el("div", { class: "ng-notes" });
  const stage = el("div", { class: "ng-stage" }, notes, wires, nodes);
  const zoom = el("div", { class: "ng-zoom" });
  const noticeBox = el("p", { class: "ng-notice", role: "status", hidden: true });
  const tool = (action, label, title) => el("button", { type: "button", class: "ng-btn-quiet ng-btn-small ng-tool", dataset: { tool: action }, title, "aria-label": title }, label);
  const undoButton = tool("undo", "↶", text.undo), redoButton = tool("redo", "↷", text.redo);
  const noteButton = el("button", { type: "button", class: "ng-btn-quiet ng-btn-small ng-tool ng-tool-word", dataset: { tool: "note" }, title: text.addNote }, text.note);
  const tools = el("div", { class: "ng-tools", role: "group" }, undoButton, redoButton, noteButton);
  const marquee = el("div", { class: "ng-marquee", hidden: true });
  const canvas = el("div", { class: "ng-canvas", tabindex: "-1" }, empty, stage, marquee, tools, zoom, noticeBox);
  function showTools() {
    undoButton.disabled = !history.past.length || r.readOnly;
    redoButton.disabled = !history.future.length || r.readOnly;
    noteButton.disabled = !canEdit();
  }
  const inspector = el("aside", { class: "ng-inspector", "aria-label": text.settingsLabel });
  root.classList.add("ng");
  root.replaceChildren(palette, canvas, inspector);
  const $ = (sel) => root.querySelector(sel);

  // ------------------------------------------------------------------ data
  const canEdit = () => !r.readOnly && r.doc !== null;
  const blockOf = (node) => r.blocks.get(node?.kind);
  // history: the document after every change, so a step back is always one whole edit
  const history = { past: [], future: [], now: "null", tag: "", at: 0 };
  /** The document changed: remember it and tell the host. Quick changes with the same *tag* (typing in one field) are one step. */
  const changed = (tag = "") => {
    const time = Date.now();
    const joins = tag && tag === history.tag && time - history.at < 1000;
    if (!joins) { history.past.push(history.now); if (history.past.length > 200) history.past.shift(); }
    history.now = JSON.stringify(r.doc);
    history.future = [];
    history.tag = tag;
    history.at = time;
    showTools();
    o.onChange?.(structuredClone(r.doc));
  };
  function travel(from, to) {
    if (!from.length || r.readOnly) return;
    to.push(history.now);
    history.now = from.pop();
    history.tag = "";
    r.doc = JSON.parse(history.now);
    r.selected = null;
    r.notice = "";
    closeSuggest();
    render();
    showTools();
    o.onChange?.(structuredClone(r.doc));
    o.onSelect?.(null);
  }
  const undo = () => travel(history.past, history.future);
  const redo = () => travel(history.future, history.past);
  /** Ids of the selected blocks (none while a wire is selected). */
  const picked = () => (r.selected?.nodes ?? (r.selected?.node ? [r.selected.node] : []));
  const pickedHas = (id) => picked().includes(id);
  /** A selection of these blocks: none, one ({ node }) or several ({ nodes }). */
  const pick = (ids) => (ids.length === 0 ? null : ids.length === 1 ? { node: ids[0] } : { nodes: ids });
  const remember = (name, fallback, value) => {
    const key = `${storageKey}.${name}`;
    try {
      if (value !== undefined) localStorage.setItem(key, JSON.stringify(value));
      const kept = JSON.parse(localStorage.getItem(key) ?? "null");
      return kept ?? fallback;
    } catch { return value ?? fallback; }
  };
  /** What a setting of a host's own kind offers, or null if it is not such a setting. */
  const choicesFor = (f, node) => {
    const list = typeof r.choices === "function" ? r.choices(f.kind, f, node) : r.choices[f.kind];
    return Array.isArray(list) ? list : null;
  };
  /** Class, colour and list mark of a value type, for a dot or a wire. */
  const typeAttrs = (type) => ({
    "data-type": type, "data-list": listOf(type) ? true : undefined,
    style: types[type]?.colour ? `--ng-type:${types[type].colour}` : undefined,
  });
  const typeClass = (type) => `ng-type-${type}${listOf(type) ? ` ng-type-${listOf(type)}` : ""}`;
  const catStyle = (cat) => (categories[cat]?.colour ? `--ng-cat:${categories[cat].colour};` : "");

  function setGraph(doc, { keepView = false } = {}) {
    r.doc = doc ? structuredClone(doc) : null;
    if (r.doc) { r.doc.nodes ??= []; r.doc.wires ??= []; for (const n of r.doc.nodes) n.options ??= {}; if (!r.doc.notes?.length) delete r.doc.notes; }
    r.selected = null;
    r.notice = "";
    r.running = new Set();
    Object.assign(history, { past: [], future: [], now: JSON.stringify(r.doc), tag: "" });
    showTools();
    if (!keepView) pz.set({ x: 20, y: 20 });  // a graph opens at the top left, at the zoom of this browser
    render();
  }

  /** Show every block (the Fit button and 0). */
  function fit() {
    const boxes = [...nodes.querySelectorAll(".ng-node"), ...notes.querySelectorAll(".ng-note")];
    if (!boxes.length || !canvas.clientWidth) { pz.set({ x: 20, y: 20, k: 1 }); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of boxes) {
      x0 = Math.min(x0, b.offsetLeft); y0 = Math.min(y0, b.offsetTop);
      x1 = Math.max(x1, b.offsetLeft + b.offsetWidth); y1 = Math.max(y1, b.offsetTop + b.offsetHeight);
    }
    const pad = 24;
    const w = canvas.clientWidth - rightInset();  // the part of the canvas the settings panel leaves free
    const k = Math.min(1.25, Math.max(pz.min, Math.min((w - 2 * pad) / (x1 - x0), (canvas.clientHeight - 2 * pad - 44) / (y1 - y0))));  // room for the buttons at the bottom
    pz.set({ k, x: (w - (x1 - x0) * k) / 2 - x0 * k, y: pad - y0 * k });
  }

  /** Canvas width covered by the settings panel (over the right of the canvas). */
  const rightInset = () => (inspector.childElementCount ? inspector.offsetWidth + 12 : 0);

  function addNode(kind, x, y) {
    if (!canEdit() || !r.blocks.has(kind)) return null;
    const taken = new Set(r.doc.nodes.map((n) => n.id));
    const node = { id: freeId(kind, taken, "block"), kind, options: {}, position: [Math.round(x), Math.round(y)] };
    r.doc.nodes.push(node);
    r.selected = { node: node.id };
    render();
    changed();
    o.onSelect?.(r.selected);
    return node.id;
  }

  function removeSelected() {
    if (!r.selected || !canEdit()) return;
    const gone = new Set(picked());
    if (gone.size) {
      r.doc.nodes = r.doc.nodes.filter((n) => !gone.has(n.id));
      r.doc.wires = r.doc.wires.filter((w) => !gone.has(w.from_node) && !gone.has(w.to_node));
    } else if (r.selected.wire !== undefined) {
      r.doc.wires.splice(r.selected.wire, 1);
    }
    select(null);
    changed();
  }

  /** Connect an output to an input; replaces what the rules allow only once. Returns "" or why not. */
  function link(from, to) {
    const a = r.doc.nodes.find((n) => n.id === from.node), b = r.doc.nodes.find((n) => n.id === to.node);
    if (!a || !b || a === b) return text.feedsItself;
    const out = port(blockOf(a)?.outputs ?? [], from.port), inp = port(blockOf(b)?.inputs ?? [], to.port);
    if (!out || !inp) return text.noPort;
    if (!fits(out.type, inp.type)) return text.cannotFeed(out.type, inp.type);
    const same = (w) => w.from_node === from.node && w.from_port === from.port && w.to_node === to.node && w.to_port === to.port;
    // an output may go to several places; a value input has one wire, so a new one replaces it
    r.doc.wires = r.doc.wires.filter((w) => !same(w) && (inp.type === "flow" || !(w.to_node === to.node && w.to_port === to.port)));
    r.doc.wires.push({ from_node: from.node, from_port: from.port, to_node: to.node, to_port: to.port });
    return "";
  }
  /** link(), then say why not (or nothing) and tell the host. */
  function connect(from, to) {
    if (!canEdit()) return text.readOnly;
    const problem = link(from, to);
    r.notice = problem;
    render();
    if (!problem) changed();
    return problem;
  }

  // ------------------------------------------------------------------ suggestions at a dot
  const wiresAt = (nodeId, portName, dir) => r.doc.wires.filter((w) => dir === "out"
    ? w.from_node === nodeId && w.from_port === portName
    : w.to_node === nodeId && w.to_port === portName);
  const rank = (dir, cat) => { const i = RANK[dir].indexOf(cat); return i < 0 ? RANK[dir].length : i; };

  /** What fits the dot *from* ({node, port, dir, type}): new blocks, and free dots of blocks already there. */
  function suggestions(from) {
    const want = from.dir === "out" ? "inputs" : "outputs", dir = from.dir === "out" ? "in" : "out";
    const ok = (p) => from.dir === "out" ? fits(from.type, p.type) : fits(p.type, from.type);
    const many = (b) => b[want].filter(ok).length > 1;  // say which: "then" / "else", "list" / "item"
    const fresh = [];
    for (const b of r.blocks.values()) {
      // the setting it goes into ("seconds"), or which of several outputs ("then", "else")
      for (const p of b[want]) if (ok(p)) fresh.push({ block: b, port: p, sub: (want === "inputs" && p.type !== "flow") || many(b) ? p.label : "" });
    }
    fresh.sort((x, y) => rank(from.dir, x.block.category) - rank(from.dir, y.block.category));
    const here = [];
    for (const n of r.doc.nodes) {
      const b = blockOf(n);
      if (n.id === from.node || !b) continue;
      for (const p of b[want]) {
        if (!ok(p)) continue;
        const single = dir === "in" && p.type !== "flow";  // a value input takes one wire
        if (single && wiresAt(n.id, p.name, dir).length) continue;
        here.push({ node: n, block: b, port: p, sub: (want === "inputs" && p.type !== "flow") || many(b) ? p.label : "" });
      }
    }
    return { fresh, here };
  }

  /** Add block *s.block* with its dot *s.port* at stage point *at*, wired to the dot *from*. */
  function addLinked(from, s, at) {
    const taken = new Set(r.doc.nodes.map((n) => n.id));
    const node = { id: freeId(s.block.kind, taken, "block"), kind: s.block.kind, options: {}, position: [Math.round(at.x), Math.round(at.y)] };
    r.doc.nodes.push(node);
    r.notice = from.dir === "out"
      ? link({ node: from.node, port: from.port }, { node: node.id, port: s.port.name })
      : link({ node: node.id, port: s.port.name }, { node: from.node, port: from.port });
    r.selected = { node: node.id };
    render();
    const p = anchorPoint(node.id, s.port.name, from.dir === "out" ? "in" : "out");  // line its dot up with the point
    if (p) { node.position = [Math.round(node.position[0] + at.x - p.x), Math.round(node.position[1] + at.y - p.y)]; render(); }
    changed();
    o.onSelect?.(r.selected);
  }

  let menu = null;  // the open suggestions: { box }
  function closeSuggest() {
    if (!menu) return;
    menu.box.remove();
    menu = null;
    drawWires();
  }

  /**
   * The blocks that fit the dot *from*, at the pointer (*client*); a new block goes to the
   * stage point *at*. Type to narrow the list, Enter takes the first, Escape closes it.
   */
  function openSuggest(from, client, at, pointerType) {
    closeSuggest();
    const out = from.dir === "out";
    const own = blockOf(r.doc.nodes.find((n) => n.id === from.node));
    const label = port(own?.[out ? "outputs" : "inputs"] ?? [], from.port)?.label ?? from.port;
    const head = from.type === "flow" ? (out ? text.nextStep : text.beforeStep) : (out ? text.useIn(label) : text.from(label));
    const { fresh, here } = suggestions(from);
    const item = (cat, name, sub, onclick, data) => el("button", { type: "button", class: `ng-suggest-item ng-cat-${cat}`, style: catStyle(cat) || undefined, dataset: data, onclick },
      el("span", { class: "ng-suggest-name" }, name), sub ? el("small", {}, sub) : "");
    const take = (fn) => () => { closeSuggest(); fn(); };
    const items = fresh.map((s) => item(s.block.category, s.block.title, s.sub, take(() => addLinked(from, s, at)), { kind: s.block.kind, port: s.port.name }));
    const old = here.map((s) => item(s.block.category, `${s.block.title} · ${summary(s.node, s.block) || s.node.id}`, s.sub, take(() => {
      if (out) connect({ node: from.node, port: from.port }, { node: s.node.id, port: s.port.name });
      else connect({ node: s.node.id, port: s.port.name }, { node: from.node, port: from.port });
    }), { node: s.node.id, port: s.port.name }));
    const secNew = el("p", { class: "ng-suggest-sec" }, text.newBlock), secOld = el("p", { class: "ng-suggest-sec" }, text.inGraph);
    const none = el("p", { class: "ng-suggest-empty", hidden: !(items.length + old.length) ? undefined : true }, text.noFit);
    secNew.hidden = !items.length;
    const list = el("div", { class: "ng-suggest-list" }, secNew, ...items, old.length ? secOld : "", ...old, none);
    const find = el("input", { type: "search", class: "ng-suggest-find", placeholder: text.find, "aria-label": text.find, autocomplete: "off" });
    const box = el("div", { class: "ng-suggest", role: "dialog", "aria-label": head, dataset: { node: from.node, port: from.port, dir: from.dir } },
      el("div", { class: "ng-suggest-head" }, head), find, list);
    const shown = () => [...list.querySelectorAll(".ng-suggest-item")].filter((b) => !b.hidden);
    find.addEventListener("input", () => {
      const q = find.value.trim().toLowerCase();
      for (const b of list.querySelectorAll(".ng-suggest-item")) b.hidden = Boolean(q) && !b.textContent.toLowerCase().includes(q);
      secNew.hidden = !items.some((b) => !b.hidden);
      secOld.hidden = !old.some((b) => !b.hidden);
      none.hidden = shown().length > 0;
    });
    box.addEventListener("keydown", (ev) => {
      const all = shown(), i = all.indexOf(document.activeElement);
      if (ev.key === "Escape") { ev.preventDefault(); closeSuggest(); canvas.focus(); }
      else if (ev.key === "Enter" && ev.target === find) { ev.preventDefault(); all[0]?.click(); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); all[Math.min(i + 1, all.length - 1)]?.focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); if (i <= 0) find.focus(); else all[i - 1].focus(); }
    });
    box.addEventListener("wheel", (ev) => ev.stopPropagation(), { passive: true });  // scroll the list, not zoom
    canvas.append(box);
    menu = { box };
    // beside the pointer, on the side the new block goes (right of an output, left of an input), inside the canvas
    const cb = canvas.getBoundingClientRect(), w = box.offsetWidth;
    const right = client.x - cb.left + 12, left = client.x - cb.left - w - 12;
    let x = out ? (right + w <= canvas.clientWidth - 4 ? right : left) : (left >= 4 ? left : right);
    x = Math.max(4, Math.min(x, canvas.clientWidth - w - 4));
    let y = client.y - cb.top - 16;
    y = Math.max(4, Math.min(y, canvas.clientHeight - box.offsetHeight - 4));
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    const a = anchorPoint(from.node, from.port, from.dir);
    if (a) drawWires(out ? { a, b: at, type: from.type } : { a: at, b: a, type: from.type });
    if (pointerType !== "touch") find.focus({ preventScroll: true });  // no on-screen keyboard on a touch
  }

  // ------------------------------------------------------------------ rendering
  /**
   * Notes: words on the canvas, for people. They lie under the blocks, are moved by their
   * top edge and sized at their corner. The document keeps them; a runtime ignores them.
   */
  function renderNotes() {
    const edit = canEdit();
    notes.replaceChildren(...(r.doc?.notes ?? []).map((note) => {
      const [x, y] = note.position ?? [0, 0], [w, h] = note.size ?? [220, 110];
      const area = el("textarea", { class: "ng-note-text", placeholder: text.notePlaceholder, "aria-label": text.noteLabel, readonly: !edit, spellcheck: "false" });
      area.value = note.text ?? "";
      area.addEventListener("input", () => { note.text = area.value; changed(`note.${note.id}`); });
      const box = el("div", { class: "ng-note", dataset: { note: note.id }, style: `left:${x}px;top:${y}px;width:${w}px;height:${h}px` },
        el("div", { class: "ng-note-bar" },
          edit ? el("button", { type: "button", class: "ng-note-remove", title: text.removeNote, "aria-label": text.removeNote, onclick: () => { r.doc.notes = r.doc.notes.filter((n) => n !== note); if (!r.doc.notes.length) delete r.doc.notes; renderNotes(); changed(); } }, "×") : ""),
        area);
      return box;
    }));
  }
  function addNote() {
    if (!canEdit()) return;
    const v = pz.view, taken = new Set((r.doc.notes ?? []).map((n) => n.id));
    // the first free place in view: a note lies under the blocks, so it must not start beneath one
    const base = stage.getBoundingClientRect();
    const busy = [...nodes.querySelectorAll(".ng-node"), ...notes.querySelectorAll(".ng-note")].map((box) => {
      const b = box.getBoundingClientRect();
      return { x0: (b.left - base.left) / v.k - 12, y0: (b.top - base.top) / v.k - 12, x1: (b.right - base.left) / v.k + 12, y1: (b.bottom - base.top) / v.k + 12 };
    });
    const [w, h] = [220, 110];
    const left = (16 - v.x) / v.k, top = (16 - v.y) / v.k, right = (canvas.clientWidth - rightInset() - 16 - v.x) / v.k - w, bottom = (canvas.clientHeight - 64 - v.y) / v.k - h;
    let place = [left, top];
    search: for (let y = top; y <= bottom; y += 24) {
      for (let x = left; x <= right; x += 24) {
        if (!busy.some((b) => x < b.x1 && x + w > b.x0 && y < b.y1 && y + h > b.y0)) { place = [x, y]; break search; }
      }
    }
    const note = { id: freeId("note", taken, "note"), text: "", position: place.map(Math.round), size: [w, h] };
    (r.doc.notes ??= []).push(note);
    renderNotes();
    changed();
    notes.querySelector(`[data-note="${CSS.escape(note.id)}"] textarea`)?.focus();
  }

  function render() {
    renderNotes();
    renderCanvas();
    renderInspector();
    renderPalette();
    noticeBox.textContent = r.notice;
    noticeBox.hidden = !r.notice;
  }

  /** A block's settings in a few words, under its title. */
  function summary(node, block) {
    const parts = [];
    for (const f of block.fields) {
      const v = node.options[f.name] ?? (f.kind === "variable" ? f.default : undefined);  // a variable always shows its name
      if (v === undefined || v === "" || quiet.has(f.name)) continue;
      if (f.kind === "variable") { parts.push(String(v)); continue; }
      if (f.kind === "colours") { parts.push(text.colourCount(v.length)); continue; }  // the swatches show them
      if (listOf(f.kind)) { parts.push(v.join(", ")); continue; }
      // a choice of the host by the name it gave it ("Start"), else by its last part
      const choices = choicesFor(f, node);
      const named = choices?.find((c) => c.value === v)?.label;
      parts.push(choices ? named ?? String(v).split("/").pop() : `${f.label.toLowerCase()} ${f.labels?.[v] ?? v}`);
    }
    return parts.slice(0, 3).join(" · ");
  }

  /** The colours of a node's colour list, as a strip under its summary. */
  function swatches(node, block) {
    const f = block.fields.find((x) => x.kind === "colours");
    const wired = f && r.doc.wires.some((w) => w.to_node === node.id && w.to_port === f.name);
    const cols = f && !wired ? node.options[f.name] ?? f.default ?? [] : [];
    return el("div", { class: "ng-node-swatches", hidden: !cols.length }, ...cols.map((c) => el("span", { style: `background:${c}`, title: c })));
  }

  function renderCanvas() {
    nodes.replaceChildren();
    empty.hidden = !r.doc || Boolean(r.doc.nodes.length);
    if (!r.doc) { drawWires(); return; }
    for (const node of r.doc.nodes) {
      const block = blockOf(node);
      const [x, y] = node.position ?? [0, 0];
      const wired = new Set(r.doc.wires.filter((w) => w.to_node === node.id).map((w) => w.to_port));
      const anchor = (p, dir) => el("span", {
        ...typeAttrs(p.type),
        class: `ng-port ng-port-${dir} ${typeClass(p.type)}`, dataset: { node: node.id, port: p.name, dir, type: p.type },
        title: `${p.label} (${p.type})${canEdit() && (dir === "out" || !wired.has(p.name)) ? `: ${text.addHere}` : ""}`,
      });
      const rows = [];
      if (block) {
        const ins = block.inputs, outs = block.outputs;
        for (let i = 0; i < Math.max(ins.length, outs.length); i++) {
          const a = ins[i], b = outs[i];
          rows.push(el("div", { class: "ng-row" },
            a ? el("span", { class: "ng-in" }, anchor(a, "in"), el("span", { class: wired.has(a.name) ? "ng-label wired" : "ng-label" }, a.type === "flow" ? "" : a.label)) : el("span", {}),
            b ? el("span", { class: "ng-out" }, el("span", { class: "ng-label" }, b.label), anchor(b, "out")) : el("span", {})));
        }
      }
      const cat = block?.category ?? "unknown";
      const runnable = block?.category === "trigger" && Boolean(o.onRun);
      nodes.append(el("div", {
        class: `ng-node ng-cat-${cat} ${pickedHas(node.id) ? "selected" : ""}`,
        dataset: { node: node.id, running: String(r.running.has(node.id)) },
        style: `${catStyle(cat)}left:${x}px;top:${y}px`, role: "listitem",
      },
      el("div", { class: "ng-node-head" },
        el("span", { class: "ng-node-title" }, block?.title ?? text.unknownBlock(node.kind)),
        runnable ? el("button", { type: "button", class: "ng-node-run", title: text.run, dataset: { run: node.id }, onclick: (ev) => { ev.stopPropagation(); o.onRun(node.id); } }, "▶") : ""),
      block ? el("div", { class: "ng-node-sum" }, summary(node, block)) : "",
      block ? swatches(node, block) : "",
      ...rows));
    }
    drawWires();
  }

  function anchorPoint(nodeId, portName, dir) {
    const a = nodes.querySelector(`.ng-port[data-node="${CSS.escape(nodeId)}"][data-port="${CSS.escape(portName)}"][data-dir="${dir}"]`);
    if (!a) return null;
    const box = a.getBoundingClientRect(), base = stage.getBoundingClientRect();
    const k = pz?.view.k ?? 1;  // the wires are drawn inside the scaled stage
    return { x: (box.left + box.width / 2 - base.left) / k, y: (box.top + box.height / 2 - base.top) / k };
  }
  const curve = (a, b) => {
    const d = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`;
  };

  function drawWires(pending) {
    wires.replaceChildren();
    if (!r.doc) return;
    r.doc.wires.forEach((w, i) => {
      const a = anchorPoint(w.from_node, w.from_port, "out"), b = anchorPoint(w.to_node, w.to_port, "in");
      if (!a || !b) return;
      const from = r.doc.nodes.find((n) => n.id === w.from_node);
      const type = port(blockOf(from)?.outputs ?? [], w.from_port)?.type ?? "flow";
      const hit = svg("path", { d: curve(a, b), class: "ng-wire-hit" });
      hit.addEventListener("click", () => select({ wire: i }));
      wires.append(hit, svg("path", { ...typeAttrs(type), d: curve(a, b), class: `ng-wire ${typeClass(type)} ${r.selected?.wire === i ? "selected" : ""}`, "data-wire": i }));
    });
    if (pending) wires.append(svg("path", { ...typeAttrs(pending.type), d: curve(pending.a, pending.b), class: `ng-wire ng-wire-pending ${typeClass(pending.type)}` }));
  }

  // ------------------------------------------------------------------ settings of a block
  function field(node, f, wired) {
    const edit = canEdit();
    const value = node.options[f.name];
    const set = (v) => {
      if (v === undefined || v === "" || (same(v, f.default) && !f.required)) delete node.options[f.name]; else node.options[f.name] = v;
      const box = nodes.querySelector(`.ng-node[data-node="${CSS.escape(node.id)}"]`);
      if (box) {
        box.querySelector(".ng-node-sum").textContent = summary(node, blockOf(node));
        box.querySelector(".ng-node-swatches")?.replaceWith(swatches(node, blockOf(node)));
        drawWires();  // the block may have grown or shrunk
      }
      changed(`${node.id}.${f.name}`);
    };
    const choices = choicesFor(f, node);
    let input;
    if (wired === "number") {  // a choice made by a number wire (the n-th of the list)
      input = el("span", { class: "ng-wired" }, text.fromWireNth);
    } else if (wired) {
      input = el("span", { class: "ng-wired" }, text.fromWire);
    } else if (o.fields?.[f.kind]) {
      input = o.fields[f.kind]({ node, field: f, value: value ?? f.default, set, disabled: !edit });
    } else if (listOf(f.kind)) {
      input = listEditor(f, value ?? f.default ?? [], edit, set);
    } else if (choices) {
      const known = choices.some((c) => c.value === value);
      input = el("select", { disabled: !edit },
        el("option", { value: "" }, choices.length ? text.choose : text.nothingToChoose),
        ...choices.map((c) => el("option", { value: c.value, selected: c.value === value }, c.label ?? c.value)),
        value && !known ? el("option", { value, selected: true }, text.notThere(value)) : "");
      input.addEventListener("change", () => set(input.value));
    } else if (f.kind === "variable") {  // a name: type a new one, or take one this graph already uses
      const used = new Set();
      for (const n of r.doc.nodes) for (const g of blockOf(n)?.fields ?? []) if (g.kind === "variable") used.add(n.options[g.name] ?? g.default);
      const listId = `ng-names-${storageKey.replace(/[^a-z0-9]/gi, "-")}`;
      input = el("span", { class: "ng-name" },
        el("input", { type: "text", value: value ?? f.default ?? "", disabled: !edit, list: listId, autocomplete: "off", spellcheck: "false" }),
        el("datalist", { id: listId }, ...[...used].sort().map((name) => el("option", { value: name }))));
      input.firstChild.addEventListener("input", () => set(input.firstChild.value));
    } else if (f.kind === "select") {
      input = el("select", { disabled: !edit }, ...f.options.map((c) => el("option", { value: String(c), selected: String(c) === String(value ?? f.default) }, f.labels?.[c] ?? String(c))));
      input.addEventListener("change", () => set(f.options.find((c) => String(c) === input.value)));
    } else if (f.kind === "bool") {
      input = el("input", { type: "checkbox", checked: Boolean(value ?? f.default), disabled: !edit });
      input.addEventListener("change", () => set(input.checked));
    } else if (f.kind === "colour" || f.kind === "time") {
      input = el("input", { type: f.kind === "colour" ? "color" : "time", value: value ?? f.default, disabled: !edit });
      input.addEventListener("input", () => set(input.value));
    } else if (f.kind === "int" || f.kind === "float") {
      input = el("input", { type: "number", step: f.kind === "int" ? "1" : "any", min: f.min, max: f.max, value: value ?? f.default ?? "", disabled: !edit });
      input.addEventListener("input", () => set(input.value === "" ? undefined : Number(input.value)));
    } else {
      input = el("input", { type: "text", value: value ?? f.default ?? "", disabled: !edit });
      input.addEventListener("input", () => set(input.value));
    }
    // a list is a group of inputs, not one: a <label> around it would click its first row
    return el(input.classList?.contains("ng-list") ? "div" : "label", { class: "ng-field", dataset: { field: f.name } }, el("span", { class: "ng-field-label" }, f.label, f.required ? el("span", { class: "ng-req" }, " *") : ""),
      input, f.help ? el("small", { class: "ng-field-help ng-help" }, f.help) : "");
  }

  /**
   * A list setting as rows: number, value, move up / down, remove; "+" adds a row. *set* gets
   * the whole new list. A colour list adds the next colour not in it yet, a number list
   * repeats its last number, any other list starts the new row empty.
   */
  function listEditor(f, start, edit, set) {
    const item = listOf(f.kind);  // what one row holds
    const colours = item === "colour", numbers = item === "number";
    const items = [...start];
    const min = f.min_items ?? 1, max = f.max_items ?? 64;
    const box = el("div", { class: "ng-list", role: "group", "aria-label": f.label });
    const paint = () => {
      const row = (v, i) => {
        const value = colours
          ? el("input", { type: "color", value: v, disabled: !edit, "aria-label": `${f.label} ${i + 1}`, oninput: (ev) => { items[i] = ev.target.value; hex.textContent = ev.target.value; set([...items]); } })
          : numbers ? el("input", { type: "number", step: "any", value: String(v), disabled: !edit, "aria-label": `${f.label} ${i + 1}`,
            oninput: (ev) => { if (ev.target.value === "" || !Number.isFinite(Number(ev.target.value))) return; items[i] = Number(ev.target.value); set([...items]); } })
          : el("input", { type: "text", value: String(v), disabled: !edit, "aria-label": `${f.label} ${i + 1}`, oninput: (ev) => { items[i] = ev.target.value; set([...items]); } });
        const hex = colours ? el("span", { class: "ng-list-hex ng-mono" }, v) : "";
        const move = (to) => { [items[i], items[to]] = [items[to], items[i]]; set([...items]); paint(); box.querySelectorAll(".ng-list-row")[to]?.querySelector(`[data-action="${to < i ? "up" : "down"}"]`)?.focus(); };
        const tool = (action, label, title, disabled, onclick) => el("button", { type: "button", class: "ng-btn-quiet ng-btn-small ng-list-btn", "data-action": action, "aria-label": `${title} (${i + 1})`, title, disabled: !edit || disabled, onclick }, label);
        return el("div", { class: "ng-list-row", role: "listitem" },
          el("span", { class: "ng-list-no" }, String(i + 1)), value, hex,
          tool("up", "↑", text.moveUp, i === 0, () => move(i - 1)),
          tool("down", "↓", text.moveDown, i === items.length - 1, () => move(i + 1)),
          tool("remove", "×", text.remove, items.length <= min, () => { items.splice(i, 1); set([...items]); paint(); }));
      };
      const add = () => {
        items.push(colours ? NEW_COLOURS.find((c) => !items.includes(c)) ?? items.at(-1) : numbers ? items.at(-1) ?? 0 : "");
        set([...items]);
        paint();
        box.querySelector(".ng-list-row:last-of-type input")?.focus();
      };
      box.replaceChildren(el("div", { role: "list" }, ...items.map(row)),
        el("div", { class: "ng-list-foot" },
          el("button", { type: "button", class: "ng-btn-quiet ng-btn-small", "data-action": "add", disabled: !edit || items.length >= max, onclick: add }, text.add[item] ?? text.add.item),
          el("small", { class: "ng-help" }, text.ofUpTo(items.length, max))));
    };
    paint();
    return box;
  }

  /** The settings of the selected block or wire, in a panel over the right of the canvas; empty
   *  (hidden) while nothing is selected, so the canvas keeps its whole width. */
  function renderInspector() {
    if (!r.doc) { inspector.replaceChildren(); return; }
    const close = () => el("button", {
      type: "button", class: "ng-insp-close", "aria-label": text.close, title: text.closeHint,
      onclick: () => select(null),
    }, "×");
    if (r.selected?.wire !== undefined) {
      const w = r.doc.wires[r.selected.wire];
      inspector.replaceChildren(el("div", { class: "ng-insp-head" }, el("h3", {}, text.wire), close()),
        el("p", {}, w ? `${w.from_node} · ${w.from_port} → ${w.to_node} · ${w.to_port}` : ""),
        el("button", { type: "button", class: "ng-btn-quiet ng-btn-small", disabled: !canEdit(), dataset: { action: "remove-wire" }, onclick: removeSelected }, text.removeWire));
      return;
    }
    if (r.selected?.nodes) {
      inspector.replaceChildren(el("div", { class: "ng-insp-head" }, el("h3", {}, text.blocksCount(r.selected.nodes.length)), close()),
        el("div", { class: "ng-actions" },
          el("button", { type: "button", class: "ng-btn-quiet ng-btn-small", disabled: !canEdit(), dataset: { action: "duplicate" }, onclick: duplicate }, text.duplicate),
          el("button", { type: "button", class: "ng-btn-quiet ng-btn-small", disabled: !canEdit(), dataset: { action: "remove-block" }, onclick: removeSelected }, text.removeBlocks)));
      return;
    }
    const node = r.doc.nodes.find((n) => n.id === r.selected?.node);
    if (!node) { inspector.replaceChildren(); return; }
    const block = blockOf(node);
    const wired = new Set(r.doc.wires.filter((w) => w.to_node === node.id).map((w) => w.to_port));
    // a setting an input replaces while that input is wired ("light no." for the light)
    const chosen = new Map((block?.inputs ?? []).filter((p) => p.replaces && wired.has(p.name)).map((p) => [p.replaces, p.type]));
    inspector.replaceChildren(
      el("div", { class: "ng-insp-head" }, el("h3", {}, block?.title ?? node.kind), close()),
      block?.help ? el("p", { class: "ng-help" }, block.help) : "",
      el("div", { class: "ng-form" }, ...(block?.fields ?? []).map((f) => field(node, f, chosen.get(f.name) ?? wired.has(f.name)))),
      el("p", { class: "ng-mono ng-node-id" }, node.id),
      el("div", { class: "ng-actions" },
        block?.category === "trigger" && o.onRun ? el("button", { type: "button", class: "ng-btn-primary ng-btn-small", dataset: { action: "run" }, onclick: () => o.onRun(node.id) }, text.runNow) : "",
        el("button", { type: "button", class: "ng-btn-quiet ng-btn-small", disabled: !canEdit(), dataset: { action: "duplicate" }, onclick: duplicate }, text.duplicate),
        el("button", { type: "button", class: "ng-btn-quiet ng-btn-small", disabled: !canEdit(), dataset: { action: "remove-block" }, onclick: removeSelected }, text.removeBlock)));
  }

  /** Blocks: a column on the left of the editor, folded to a narrow tab with one click. */
  function renderPalette() {
    palette.hidden = !r.doc;
    if (palette.hidden) { palette.replaceChildren(); return; }
    const edit = canEdit();
    const open = { trigger: true, ...remember("palette", {}) };  // which groups are open; Triggers to start with
    const shown = remember("drawer", true);
    palette.dataset.open = String(shown);
    const toggle = el("button", {
      type: "button", class: "ng-drawer-toggle", "aria-expanded": String(shown),
      title: shown ? text.hideBlocks : text.showBlocks,
      onclick: () => { remember("drawer", true, !shown); renderPalette(); drawWires(); },
    }, el("span", {}, text.blocks), el("span", { class: "ng-drawer-arrow", "aria-hidden": "true" }, shown ? "◂" : "▸"));
    if (!shown) { palette.replaceChildren(toggle); return; }
    const add = (b) => {
      const n = r.doc.nodes.length, v = pz.view;
      addNode(b.kind, Math.round((40 - v.x) / v.k) + (n % 4) * 30, Math.round((40 - v.y) / v.k) + n * 26);
    };
    const cats = new Set([...Object.keys(categories), ...[...r.blocks.values()].map((b) => b.category)]);
    const groups = [...cats].map((cat) => {
      const blocks = [...r.blocks.values()].filter((b) => b.category === cat);
      if (!blocks.length) return "";
      const buttons = blocks.map((b) => el("button", {
        type: "button", class: `ng-pal ng-cat-${cat}`, style: catStyle(cat) || undefined, draggable: edit ? "true" : undefined, disabled: !edit, title: b.help, dataset: { kind: b.kind },
        ondragstart: (ev) => ev.dataTransfer.setData("text/plain", b.kind),
        onclick: () => add(b),
      }, b.title));
      const group = el("details", { class: `ng-pal-group ng-cat-${cat}`, style: catStyle(cat) || undefined, open: Boolean(open[cat]), dataset: { category: cat } },
        el("summary", {}, el("span", { class: "ng-pal-title" }, categories[cat]?.title ?? cat), el("span", { class: "ng-pal-count" }, String(blocks.length))),
        ...buttons);
      group.addEventListener("toggle", () => remember("palette", {}, { ...remember("palette", {}), [cat]: group.open }));
      return group;
    });
    palette.replaceChildren(toggle, el("div", { class: "ng-drawer-body" },
      el("p", { class: "ng-help" }, edit ? text.hint : text.readOnly),
      ...groups,
      text.how.length ? el("details", { class: "ng-drawer-how" }, el("summary", {}, text.howTitle), ...text.how.map((p) => el("p", { class: "ng-help" }, p))) : ""));
  }

  function select(selection) {
    r.selected = selection;
    render();
    o.onSelect?.(selection);
  }

  // ------------------------------------------------------------------ copy, paste, duplicate
  /** The selected blocks and the wires among them, as a piece that can be put in again. */
  function cut() {
    const ids = new Set(picked());
    if (!ids.size) return null;
    return structuredClone({ nodes: r.doc.nodes.filter((n) => ids.has(n.id)), wires: r.doc.wires.filter((w) => ids.has(w.from_node) && ids.has(w.to_node)) });
  }
  /** Put a piece into the graph, moved a little, under new ids; it becomes the selection. */
  function putIn(piece, shift = 30) {
    if (!piece?.nodes.length || !canEdit()) return;
    const taken = new Set(r.doc.nodes.map((n) => n.id)), ids = new Map();
    for (const n of piece.nodes) {
      if (!r.blocks.has(n.kind)) continue;  // from an editor with other blocks
      const id = freeId(n.kind, taken, "block");
      taken.add(id);
      ids.set(n.id, id);
      r.doc.nodes.push({ ...structuredClone(n), id, position: [(n.position?.[0] ?? 0) + shift, (n.position?.[1] ?? 0) + shift] });
    }
    for (const w of piece.wires) if (ids.has(w.from_node) && ids.has(w.to_node)) r.doc.wires.push({ ...w, from_node: ids.get(w.from_node), to_node: ids.get(w.to_node) });
    if (!ids.size) return;
    r.selected = pick([...ids.values()]);
    render();
    changed();
    o.onSelect?.(r.selected);
  }
  const copy = () => { const piece = cut(); if (piece) { clipboard.piece = piece; clipboard.pastes = 0; } return Boolean(piece); };
  const paste = () => { clipboard.pastes += 1; putIn(clipboard.piece, 30 * clipboard.pastes); };
  function duplicate() { putIn(cut()); }
  const selectAll = () => select(pick(r.doc.nodes.map((n) => n.id)));

  // ------------------------------------------------------------------ pointer: move, wire, pan, select
  canvas.addEventListener("dragover", (ev) => ev.preventDefault());
  canvas.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const kind = ev.dataTransfer.getData("text/plain");
    if (!r.blocks.has(kind)) return;
    const p = pz.toStage(ev.clientX, ev.clientY);
    addNode(kind, Math.round(p.x - 60), Math.round(p.y - 14));
  });
  let inside = false;  // the last press was in this editor: the keys are meant for it
  const pz = attachPanZoom({
    canvas, stage, controls: zoom, key: storageKey, min: 0.25, max: 2,
    fit, text, active: () => inside && root.isConnected && Boolean(r.doc), onChange: () => closeSuggest(),
  });
  pz.set({ x: 20, y: 20, k: pz.remembered ?? 1 });
  noteButton.addEventListener("click", addNote);
  undoButton.addEventListener("click", undo);
  redoButton.addEventListener("click", redo);

  // a press anywhere outside the suggestions closes them
  const onDocDown = (ev) => {
    inside = root.contains(ev.target);
    if (menu && !menu.box.contains(ev.target)) closeSuggest();
  };
  document.addEventListener("pointerdown", onDocDown, true);

  /**
   * While a wire is dragged from the dot *from*: the dots it may end at light up, the others
   * fade. Returns those dots with their place on the screen, for snapping.
   */
  function showFits(from) {
    const fitting = [];
    for (const dot of nodes.querySelectorAll(".ng-port")) {
      const d = dot.dataset;
      const ok = d.dir !== from.dir && d.node !== from.node && (from.dir === "out" ? fits(from.type, d.type) : fits(d.type, from.type));
      dot.classList.toggle("ng-port-fits", ok);
      if (ok) { const box = dot.getBoundingClientRect(); fitting.push({ dot, x: box.left + box.width / 2, y: box.top + box.height / 2 }); }
    }
    root.classList.add("ng-wiring");
    return fitting;
  }
  function hideFits() {
    root.classList.remove("ng-wiring");
    for (const dot of nodes.querySelectorAll(".ng-port-fits, .ng-port-near")) dot.classList.remove("ng-port-fits", "ng-port-near");
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || !r.doc || pz.pinching || ev.target.closest(".ng-zoom-controls, .ng-tools, .ng-suggest")) return;
    if (r.notice) { r.notice = ""; noticeBox.hidden = true; }
    const anchor = ev.target.closest(".ng-port");
    const head = ev.target.closest(".ng-node");
    const paper = ev.target.closest(".ng-note");
    if (paper) {  // a note: its bar moves it; its text is typed in and sized at the corner
      const note = r.doc.notes?.find((n) => n.id === paper.dataset.note);
      if (!note || !canEdit() || ev.target.closest("button")) return;
      const bar = Boolean(ev.target.closest(".ng-note-bar"));
      const start = { px: note.position?.[0] ?? 0, py: note.position?.[1] ?? 0, w: paper.offsetWidth, h: paper.offsetHeight };
      const move = (e) => {
        if (!bar || pz.pinching) return;
        const k = pz.view.k;
        note.position = [Math.round(start.px + (e.clientX - ev.clientX) / k), Math.round(start.py + (e.clientY - ev.clientY) / k)];
        paper.style.left = `${note.position[0]}px`;
        paper.style.top = `${note.position[1]}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        const moved = note.position?.[0] !== start.px || note.position?.[1] !== start.py;
        const sized = paper.offsetWidth !== start.w || paper.offsetHeight !== start.h;  // dragged at its corner
        if (sized) note.size = [paper.offsetWidth, paper.offsetHeight];
        if (moved || sized) changed();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      if (bar) ev.preventDefault();
      return;
    }
    if (anchor && canEdit()) {
      ev.preventDefault();
      const from = { node: anchor.dataset.node, port: anchor.dataset.port, dir: anchor.dataset.dir, type: anchor.dataset.type };
      const a = anchorPoint(from.node, from.port, from.dir);
      const fitting = showFits(from);
      let near = null;  // the fitting dot the wire snaps to
      const move = (e) => {
        const best = fitting.map((f) => ({ f, d: Math.hypot(f.x - e.clientX, f.y - e.clientY) })).sort((x, y) => x.d - y.d)[0];
        const next = best && best.d < 22 ? best.f : null;
        if (next !== near) { near?.dot.classList.remove("ng-port-near"); next?.dot.classList.add("ng-port-near"); near = next; }
        const b = near ? anchorPoint(near.dot.dataset.node, near.dot.dataset.port, near.dot.dataset.dir) : pz.toStage(e.clientX, e.clientY);
        drawWires(from.dir === "out" ? { a, b, type: from.type } : { a: b, b: a, type: from.type });
      };
      const up = (e) => {
        window.removeEventListener("pointermove", move);
        hideFits();
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const still = Math.abs(e.clientX - ev.clientX) + Math.abs(e.clientY - ev.clientY) < 4;
        const target = still ? under?.closest(".ng-port") : near?.dot ?? under?.closest(".ng-port");
        // an output takes any number of wires, so a click on it always offers what fits
        const clicked = still && target === anchor && (from.dir === "out" || !wiresAt(from.node, from.port, from.dir).length);
        const dropped = !still && !target && under?.closest(".ng-canvas") === canvas && !under.closest(".ng-node, .ng-zoom-controls, .ng-tools");
        if (target && nodes.contains(target) && target.dataset.dir !== from.dir) {
          const out = from.dir === "out" ? from : target.dataset, inp = from.dir === "out" ? target.dataset : from;
          connect({ node: out.node, port: out.port }, { node: inp.node, port: inp.port });
        } else {
          render();
        }
        // a click on a dot, or a wire let go on empty canvas: what fits there
        if (clicked) {
          const p = anchorPoint(from.node, from.port, from.dir);
          if (p) openSuggest(from, { x: e.clientX, y: e.clientY }, { x: p.x + (from.dir === "out" ? 90 : -90), y: p.y + 26 * wiresAt(from.node, from.port, from.dir).length }, e.pointerType);
        } else if (dropped) {
          openSuggest(from, { x: e.clientX, y: e.clientY }, pz.toStage(e.clientX, e.clientY), e.pointerType);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      return;
    }
    if (head) {
      if (ev.target.closest("button")) return;
      const id = head.dataset.node;
      const before = JSON.stringify(r.selected);
      if (ev.shiftKey) {  // add it to the selection, or take it out
        select(pick(pickedHas(id) ? picked().filter((x) => x !== id) : [...picked(), id]));
        return;
      }
      if (!pickedHas(id)) r.selected = { node: id };  // a block of a selection moves all of it
      if (!canEdit()) { if (JSON.stringify(r.selected) !== before) select(r.selected); return; }
      const moving = picked().map((x) => {
        const node = r.doc.nodes.find((n) => n.id === x);
        return { node, box: nodes.querySelector(`.ng-node[data-node="${CSS.escape(x)}"]`), px: node.position?.[0] ?? 0, py: node.position?.[1] ?? 0 };
      });
      for (const m of moving) m.box?.classList.add("selected");
      let moved = false;
      const move = (e) => {
        if (pz.pinching) return;
        moved = true;
        const k = pz.view.k;
        for (const m of moving) {
          m.node.position = [Math.round(m.px + (e.clientX - ev.clientX) / k), Math.round(m.py + (e.clientY - ev.clientY) / k)];
          if (m.box) { m.box.style.left = `${m.node.position[0]}px`; m.box.style.top = `${m.node.position[1]}px`; }
        }
        drawWires();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        if (!moved && picked().length > 1) r.selected = { node: id };  // a plain click on one of several: only that one
        render();
        if (moved) changed();
        if (JSON.stringify(r.selected) !== before) o.onSelect?.(r.selected);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      return;
    }
    if (ev.target.closest(".ng-wire-hit")) return;
    if (ev.shiftKey) {  // Shift and drag on the canvas: a frame around the blocks to select
      const cb = canvas.getBoundingClientRect();
      const frame = (e) => ({ x: Math.min(ev.clientX, e.clientX), y: Math.min(ev.clientY, e.clientY), w: Math.abs(e.clientX - ev.clientX), h: Math.abs(e.clientY - ev.clientY) });
      const move = (e) => {
        const f = frame(e);
        Object.assign(marquee.style, { left: `${f.x - cb.left}px`, top: `${f.y - cb.top}px`, width: `${f.w}px`, height: `${f.h}px` });
        marquee.hidden = false;
      };
      const up = (e) => {
        window.removeEventListener("pointermove", move);
        marquee.hidden = true;
        const f = frame(e);
        const inFrame = [...nodes.querySelectorAll(".ng-node")].filter((box) => {
          const b = box.getBoundingClientRect();
          return b.left < f.x + f.w && b.right > f.x && b.top < f.y + f.h && b.bottom > f.y;
        }).map((box) => box.dataset.node);
        select(pick([...new Set([...picked(), ...inFrame])]));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      return;
    }
    const v = pz.view;
    const start = { x: ev.clientX, y: ev.clientY, px: v.x, py: v.y };
    const move = (e) => {
      if (pz.pinching) return;  // two fingers: panzoom.js pans and zooms
      pz.set({ x: start.px + e.clientX - start.x, y: start.py + e.clientY - start.y });
    };
    const up = (e) => {
      window.removeEventListener("pointermove", move);
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 4 && r.selected) select(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  });
  const onKey = (ev) => {
    if (!inside || !root.isConnected || !r.doc) return;
    if (ev.target.closest?.("input, select, textarea, [contenteditable]")) return;
    const mod = ev.ctrlKey || ev.metaKey, key = ev.key.toLowerCase();
    if (ev.key === "Delete" || ev.key === "Backspace") removeSelected();
    else if (ev.key === "Escape" && r.selected) select(null);
    else if (mod && key === "z" && !ev.shiftKey) undo();
    else if (mod && (key === "y" || (key === "z" && ev.shiftKey))) redo();
    else if (mod && key === "a") selectAll();
    else if (mod && key === "c") { if (!copy()) return; }
    else if (mod && key === "v") paste();
    else if (mod && key === "d") duplicate();
    else return;
    ev.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  const redraw = () => drawWires();
  window.addEventListener("resize", redraw);
  const sizes = typeof ResizeObserver === "function" ? new ResizeObserver(redraw) : null;
  sizes?.observe(canvas);
  document.fonts?.ready.then(redraw);  // the dots move when the fonts arrive

  // ------------------------------------------------------------------ the handle
  const setBlocks = (blocks) => { r.blocks = new Map((blocks ?? []).map((b) => [b.kind, b])); render(); };
  r.blocks = new Map((o.blocks ?? []).map((b) => [b.kind, b]));
  setGraph(o.graph ?? null);

  return {
    /** The document as it is now (a copy). */
    getGraph: () => (r.doc ? structuredClone(r.doc) : null),
    /** Edit another document (or none: null). `{ keepView: true }` leaves pan and zoom alone. */
    setGraph,
    setBlocks,
    /** What the settings of the host's own kinds offer: see the `choices` option. */
    setChoices: (choices) => { r.choices = choices ?? {}; render(); },
    setReadOnly: (on) => { r.readOnly = Boolean(on); closeSuggest(); render(); showTools(); },
    get readOnly() { return r.readOnly; },
    /** Light up the blocks whose chain runs now (ids of nodes; none: []). */
    setRunning(ids) {
      r.running = new Set(ids ?? []);
      for (const box of nodes.querySelectorAll(".ng-node")) box.dataset.running = String(r.running.has(box.dataset.node));
    },
    /** Flash a block: its chain just reached it. */
    step(nodeId) {
      const box = nodes.querySelector(`.ng-node[data-node="${CSS.escape(nodeId)}"]`);
      if (!box) return;
      box.classList.remove("stepped");
      void box.offsetWidth;  // restart the animation
      box.classList.add("stepped");
    },
    get selection() { return r.selected; },
    select,
    addNode,
    /** Wire an output `{ node, port }` to an input `{ node, port }`; returns "" or why not. */
    connect,
    removeSelected,
    /** One edit back, and forward again. */
    undo,
    redo,
    get canUndo() { return history.past.length > 0; },
    get canRedo() { return history.future.length > 0; },
    /** Copy the selected blocks, put the copied ones in, or do both at once. */
    copy,
    paste,
    duplicate,
    selectAll,
    /** Put an empty note on the canvas. */
    addNote,
    fit,
    render,
    get view() { return pz.view; },
    /** Take the editor out of the page again. */
    destroy() {
      closeSuggest();
      document.removeEventListener("pointerdown", onDocDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", redraw);
      sizes?.disconnect();
      pz.detach();
      root.replaceChildren();
      root.classList.remove("ng");
    },
  };
}
