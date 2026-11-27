// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * noodlegraph runtime — a graph as data, and the single gate it passes before it may run.
 *
 * check() makes sure block types exist, their settings are valid, wires connect an output to
 * an input of a fitting type, a value input carries at most one wire, and there is no circle,
 * so every chain ends.
 */
import { LOOP_DONE, LOOP_EACH, fits, readOptions } from "./blocks.js";

export const SCHEMA = "noodlegraph/1";
export const MAX_NODES = 200;
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** A graph document that cannot be used. */
export class GraphFileError extends Error {}

const only = (object, keys, where, errors) => {
  for (const key of Object.keys(object)) if (!keys.includes(key)) errors.push(`${where}${key}: Extra inputs are not permitted`);
};

/** A graph from a parsed document (or JSON text), in full form; throws GraphFileError. */
export function parse(document) {
  let doc = document;
  if (typeof doc === "string") {
    try { doc = JSON.parse(doc); } catch (err) { throw new GraphFileError(`not valid JSON: ${err.message}`); }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new GraphFileError("a graph file must be a mapping");
  const errors = [];
  only(doc, ["schema", "id", "name", "description", "enabled", "nodes", "wires", "notes"], "", errors);
  if (doc.schema !== undefined && doc.schema !== SCHEMA) errors.push(`schema: Input should be '${SCHEMA}'`);
  if (typeof doc.id !== "string" || !ID.test(doc.id)) errors.push("id: a short name of small letters, digits, _ and -");
  const name = doc.name ?? "", description = doc.description ?? "";
  if (typeof name !== "string" || name.length > 80) errors.push("name: String should have at most 80 characters");
  if (typeof description !== "string" || description.length > 400) errors.push("description: String should have at most 400 characters");
  if (doc.enabled !== undefined && typeof doc.enabled !== "boolean") errors.push("enabled: Input should be a valid boolean");
  const nodes = [], wires = [];
  if (!Array.isArray(doc.nodes ?? [])) errors.push("nodes: Input should be a valid list");
  else if ((doc.nodes ?? []).length > MAX_NODES) errors.push(`nodes: List should have at most ${MAX_NODES} items`);
  else {
    for (const [i, n] of (doc.nodes ?? []).entries()) {
      const where = `nodes.${i}.`;
      if (!n || typeof n !== "object") { errors.push(`nodes.${i}: Input should be a valid mapping`); continue; }
      only(n, ["id", "kind", "options", "position"], where, errors);
      if (typeof n.id !== "string" || !ID.test(n.id)) errors.push(`${where}id: a short name of small letters, digits, _ and -`);
      if (typeof n.kind !== "string") errors.push(`${where}kind: Field required`);
      const options = n.options ?? {};
      if (typeof options !== "object" || Array.isArray(options)) errors.push(`${where}options: Input should be a valid mapping`);
      const position = n.position ?? null;
      if (position !== null && !(Array.isArray(position) && position.length === 2 && position.every((x) => typeof x === "number"))) errors.push(`${where}position: Input should be two numbers`);
      nodes.push({ id: n.id, kind: n.kind, options: { ...options }, position });
    }
    const ids = nodes.map((n) => n.id);
    if (new Set(ids).size !== ids.length) errors.push("block ids must be unique");
  }
  if (!Array.isArray(doc.wires ?? [])) errors.push("wires: Input should be a valid list");
  else {
    for (const [i, w] of (doc.wires ?? []).entries()) {
      const keys = ["from_node", "from_port", "to_node", "to_port"];
      if (!w || typeof w !== "object") { errors.push(`wires.${i}: Input should be a valid mapping`); continue; }
      only(w, keys, `wires.${i}.`, errors);
      for (const key of keys) if (typeof w[key] !== "string") errors.push(`wires.${i}.${key}: Field required`);
      wires.push({ from_node: w.from_node, from_port: w.from_port, to_node: w.to_node, to_port: w.to_port });
    }
  }
  // notes are for people: an editor draws them, a runtime only carries them along
  const notes = [];
  if (!Array.isArray(doc.notes ?? [])) errors.push("notes: Input should be a valid list");
  else {
    for (const [i, n] of (doc.notes ?? []).entries()) {
      if (!n || typeof n !== "object" || typeof n.id !== "string" || typeof (n.text ?? "") !== "string") { errors.push(`notes.${i}: a note needs an id and a text`); continue; }
      only(n, ["id", "text", "position", "size"], `notes.${i}.`, errors);
      notes.push({ id: n.id, text: n.text ?? "", position: n.position ?? null, size: n.size ?? null });
    }
  }
  if (errors.length) throw new GraphFileError(errors.join("; "));
  const graph = { schema: SCHEMA, id: doc.id, name, description, enabled: doc.enabled ?? false, nodes, wires };
  if (notes.length) graph.notes = notes;
  return graph;
}

/** The file text of a graph (JSON). */
export const dump = (graph) => JSON.stringify(graph, null, 1);

const key = (node, portName) => `${node}\0${portName}`;
const portOf = (ports, name) => ports.find((p) => p.name === name);

/** A checked graph, ready to run. */
export class Compiled {
  constructor(graph) {
    this.graph = graph;
    this.blocks = new Map();     // node id -> block type
    this.options = new Map();    // node id -> its settings (defaults filled in)
    this.flowNext = new Map();   // "node\0port" of a flow output -> the nodes it continues at
    this.valueFrom = new Map();  // "node\0port" of a value input -> [node, port] it comes from
    this.problems = [];
  }
  /** It has a loop block: a run may last as long as the engine is active. */
  get loops() { return [...this.blocks.values()].some((b) => b.role === "loop"); }
  /** No problems: it may run. */
  get valid() { return this.problems.length === 0; }
  /** Ids of the trigger blocks. */
  get triggers() { return [...this.blocks].filter(([, b]) => b.role === "trigger").map(([id]) => id); }
  /** The nodes a flow output continues at: none, one, or several that run at the same time. */
  next(node, portName) { return this.flowNext.get(key(node, portName)) ?? []; }
  source(node, portName) { return this.valueFrom.get(key(node, portName)) ?? null; }
}

/** *graph* in today's form: settings and ports a block renamed since it was saved. */
export function upgrade(graph, registry) {
  const kinds = new Map(graph.nodes.map((n) => [n.id, registry.get(n.kind)]));
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const block = registry.get(n.kind);
      return block?.upgrade ? { ...n, options: block.upgrade({ ...n.options }) } : n;
    }),
    wires: graph.wires.map((w) => ({ ...w, to_port: kinds.get(w.to_node)?.renamed?.[w.to_port] ?? w.to_port })),
  };
}

function hasCycle(edges) {
  const state = new Map();
  const visit = (node) => {
    if (state.get(node) === 1) return true;
    if (state.get(node) === 2) return false;
    state.set(node, 1);
    if ((edges.get(node) ?? []).some(visit)) return true;
    state.set(node, 2);
    return false;
  };
  return [...edges.keys()].some(visit);
}

/**
 * Validate *graph* (as parse() returns it); with *ctx* also against the host (what the
 * blocks refer to). Returns a Compiled; its `problems` say what is wrong, in words for the user.
 */
export function check(graphIn, registry, ctx = null) {
  const graph = upgrade(graphIn, registry);
  const c = new Compiled(graph);
  // every block: a known type and valid settings (and, with ctx, fits the host)
  for (const node of graph.nodes) {
    const block = registry.get(node.kind);
    if (!block) { c.problems.push(`${node.id}: unknown block type '${node.kind}'`); continue; }
    c.blocks.set(node.id, block);
    const { options, errors } = readOptions(block, node.options);
    if (errors.length) { for (const e of errors) c.problems.push(`${node.id} (${block.title}): ${e}`); continue; }
    c.options.set(node.id, options);
    if (ctx !== null && block.problems) for (const p of block.problems({ options, ctx }) ?? []) c.problems.push(`${node.id} (${block.title}): ${p}`);
  }
  // every wire: both blocks and ports exist, the types fit, one wire per input
  const edges = new Map();  // port -> ports it feeds, for the circle check
  const edge = (a, b) => { if (!edges.has(a)) edges.set(a, []); edges.get(a).push(b); };
  for (const w of graph.wires) {
    const src = c.blocks.get(w.from_node), dst = c.blocks.get(w.to_node);
    const label = `wire ${w.from_node}.${w.from_port} -> ${w.to_node}.${w.to_port}`;
    if (!src || !dst) { c.problems.push(`${label}: a block is missing`); continue; }
    const out = portOf(src.outputs, w.from_port), inp = portOf(dst.inputs, w.to_port);
    if (!out || !inp) { c.problems.push(`${label}: no such port`); continue; }
    if (!fits(out.type, inp.type)) { c.problems.push(`${label}: ${out.type} cannot feed ${inp.type}`); continue; }
    edge(`${key(w.from_node, w.from_port)}\0out`, `${key(w.to_node, w.to_port)}\0in`);
    if (out.type === "flow") {
      const k = key(w.from_node, w.from_port);  // a flow output may continue in several places
      if (!c.flowNext.has(k)) c.flowNext.set(k, []);
      if (!c.flowNext.get(k).includes(w.to_node)) c.flowNext.get(k).push(w.to_node);
    } else {
      if (c.valueFrom.has(key(w.to_node, w.to_port))) c.problems.push(`${label}: this input already has a wire`);
      c.valueFrom.set(key(w.to_node, w.to_port), [w.from_node, w.from_port]);
    }
  }
  // a setting left empty because a wire was meant to choose it, but no wire does
  for (const node of graph.nodes) {
    const block = c.blocks.get(node.id), options = c.options.get(node.id);
    if (!block || !options) continue;
    for (const p of block.inputs) {
      if (!p.replaces || c.valueFrom.has(key(node.id, p.name)) || options[p.replaces]) continue;
      const what = (block.fields.find((f) => f.name === p.replaces)?.label ?? p.replaces).toLowerCase();
      c.problems.push(`${node.id} (${block.title}): choose the ${what}, or wire a number into '${p.label || p.name}'`);
    }
  }
  // inside a block: an output from the inputs it is computed from (all, unless it says less)
  for (const [nodeId, block] of c.blocks) {
    for (const out of block.outputs) {
      for (const name of block.depends[out.name] ?? block.inputs.map((p) => p.name)) edge(`${key(nodeId, name)}\0in`, `${key(nodeId, out.name)}\0out`);
    }
  }
  if (hasCycle(edges)) c.problems.push("the wires form a circle; a chain must end (use For or While to repeat steps)");
  return c;
}

export { LOOP_DONE, LOOP_EACH };
