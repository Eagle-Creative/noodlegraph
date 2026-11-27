// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * noodlegraph runtime — block types, value types and settings.
 *
 * A block type is a plain object: what the editor needs to draw it (kind, title, ports,
 * fields) and what the engine needs to run it (one function, by its role):
 *
 *   trigger   start({ ctx, options, emit, sleep, signal, node }) -> stop function (optional),
 *             or watch({ ... }) : an async function that runs until it is stopped
 *   action    run({ ctx, options, inputs, sleep, signal, state, node }) -> name of a flow output
 *   loop      again({ inputs, rounds, ... }) -> bool, values({ inputs, rounds, ... }) -> {port: value}
 *   value     compute({ ctx, options, inputs, state, node }) -> { port: value }
 *
 * Blocks reach the host only through `ctx` (its Context). Nothing here touches a page: the
 * runtime works in a browser, in Node.js and wherever else JavaScript runs.
 */

export const FLOW_IN = "in";
export const FLOW_OUT = "out";
export const LOOP_EACH = "each";
export const LOOP_DONE = "done";
export const MAX_LIST = 64;  // items in a list setting

/** Python's round(): halves go to the even neighbour, so both runtimes pick the same item. */
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ---------------------------------------------------------------------- value types
/** `#rrggbb` (or [r, g, b]) -> [r, g, b]. */
export function parseColour(value) {
  if (Array.isArray(value) && value.length === 3) return value.map((x) => Math.trunc(Number(x)) & 255);
  const s = String(value).trim().replace(/^#+/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`not a colour: ${JSON.stringify(value)} (use #rrggbb)`);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/** A fully saturated colour from a hue (0-360) and a brightness (0-100). */
export function hueColour(hueDeg, brightnessPct) {
  const v = Math.min(Math.max(brightnessPct, 0), 100) / 100;
  const h = (((hueDeg % 360) + 360) % 360) / 360;
  const i = Math.trunc(h * 6), f = h * 6 - i;
  const q = v * (1 - f), t = v * f;
  const [r, g, b] = [[v, t, 0], [q, v, 0], [0, v, t], [0, q, v], [t, 0, v], [v, 0, q]][i % 6];
  return [roundHalfEven(r * 255), roundHalfEven(g * 255), roundHalfEven(b * 255)];
}

const isColour = (v) => typeof v === "string" || (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number"));
function toNumber(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  throw new Error(`not a number: ${JSON.stringify(value)}`);
}
function toText(value) {
  if (typeof value === "string") return value;
  throw new Error(`not a text: ${JSON.stringify(value)}`);
}
const listOf = (what, one, single) => (value) => {
  const items = single(value) ? [value] : value;
  if (!Array.isArray(items) || !items.length) throw new Error(`not a list of ${what}: ${JSON.stringify(value)}`);
  return items.map(one);
};

/** How a setting or a wire's value is brought into each value port type. */
const COERCE = new Map([
  ["number", toNumber],
  ["bool", (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v))],
  ["text", toText],
  ["colour", parseColour],
  ["numbers", listOf("numbers", toNumber, (v) => !Array.isArray(v))],
  ["texts", listOf("texts", toText, (v) => !Array.isArray(v))],
  ["colours", listOf("colours", parseColour, isColour)],
]);
/** List port types and the type of one item: an item may feed a list input (a list of one). */
export const LIST_OF = new Map([["colours", "colour"], ["numbers", "number"], ["texts", "text"]]);

/**
 * Add a value port type of the host's own (say "pose" or "sound"). *convert* brings a setting
 * or a wire's value into the type and throws for one that does not fit (default: as it is).
 * With `listOf` the type is a list of that item type. Tell the editor too (its `types` option).
 */
export function registerType(name, convert = (value) => value, { listOf: item = "" } = {}) {
  if (!name || name === "flow") throw new Error("'flow' is the order of steps, not a value type");
  COERCE.set(name, convert);
  if (item) LIST_OF.set(name, item);
}

/** Whether an output of *outType* may feed an input of *inType*. */
export const fits = (outType, inType) => outType === inType || LIST_OF.get(inType) === outType;

/** Bring an option or wire value into the type of a value port. */
export function coerce(value, portType) {
  const convert = COERCE.get(portType);
  if (!convert) throw new Error(`unknown port type '${portType}'`);
  return convert(value);
}

// ---------------------------------------------------------------------- block types
const ROLES = ["trigger", "action", "loop", "value"];
const DEFAULT_CATEGORY = { trigger: "trigger", action: "action", loop: "logic", value: "value" };
const FLOW_INPUT = { name: FLOW_IN, type: "flow" };
const DEFAULT_INPUTS = { trigger: [], action: [FLOW_INPUT], loop: [FLOW_INPUT], value: [] };
const DEFAULT_OUTPUTS = {
  trigger: [{ name: FLOW_OUT, type: "flow", label: "then" }],
  action: [{ name: FLOW_OUT, type: "flow", label: "then" }],
  loop: [{ name: LOOP_EACH, type: "flow", label: "each round" }, { name: LOOP_DONE, type: "flow", label: "done" }],
  value: [],
};
/** Settings every trigger has. */
const TRIGGER_FIELDS = [
  { name: "cooldown_s", kind: "float", min: 0, max: 86400, default: 0.0, help: "Do not start again for this long." },
  { name: "when_running", label: "If still running", kind: "select", options: ["ignore", "restart"], default: "ignore", help: "If its chain is still running when it fires again." },
];

/** What a setting is called in the editor: `hold_s` reads "Hold (s)". */
function labelOf(name) {
  const [words, unit] = name.endsWith("_s") ? [name.slice(0, -2), " (s)"] : [name, ""];
  const text = words.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() + unit;
}

const port = (p) => ({ ...p, label: p.label || p.name });

/**
 * A block type from its description. Ports and fields may be left out where the role has
 * usual ones: an action has the flow input "in" and the flow output "out" ("then"), a
 * trigger the output "out", a loop "each" and "done" (list a loop's own outputs after them
 * with `outputs: [...LOOP_OUTPUTS, ...]`). A trigger gets the settings every trigger has.
 */
export function defineBlock(spec) {
  const role = spec.role;
  if (!ROLES.includes(role)) throw new Error(`${spec.kind}: role must be one of ${ROLES.join(", ")}`);
  if (!spec.kind || !spec.title) throw new Error("a block needs a kind and a title");
  const need = { trigger: spec.start || spec.watch, action: spec.run, loop: spec.again, value: spec.compute }[role];
  if (typeof need !== "function") throw new Error(`${spec.kind}: a ${role} needs its function (see blocks.js)`);
  const own = (spec.fields ?? []).map((f) => ({ ...f, label: f.label ?? labelOf(f.name) }));
  const fields = role === "trigger" ? [...TRIGGER_FIELDS.map((f) => ({ ...f, label: f.label ?? labelOf(f.name) })), ...own] : own;
  for (const f of fields) {
    if (!("default" in f) && !f.required) throw new Error(`${spec.kind}: the setting '${f.name}' needs a default, or required: true`);
  }
  return Object.freeze({
    help: "", depends: {}, renamed: {}, fixed: false,
    ...spec,
    category: spec.category ?? DEFAULT_CATEGORY[role],
    inputs: Object.freeze((spec.inputs ?? DEFAULT_INPUTS[role]).map(port)),
    outputs: Object.freeze((spec.outputs ?? DEFAULT_OUTPUTS[role]).map(port)),
    fields: Object.freeze(fields),
  });
}
/** The flow outputs every loop has, for `outputs: [...LOOP_OUTPUTS, { name: "i", ... }]`. */
export const LOOP_OUTPUTS = DEFAULT_OUTPUTS.loop;

/** A registry (Map by kind) from block types, arrays of them or other registries; a later one wins. */
export function registry(...blocks) {
  const found = new Map();
  for (const item of blocks.map((b) => (b instanceof Map ? [...b.values()] : b)).flat(Infinity)) found.set(item.kind, item);
  return found;
}

/** The block types for the editor (its `blocks` option): ports and the settings form. */
export function catalogue(reg) {
  const plain = (f) => {
    const out = {};
    for (const key of ["name", "label", "kind", "options", "labels", "min", "max", "above", "below", "max_length", "required", "default", "min_items", "max_items", "help"]) {
      if (f[key] !== undefined && !(key === "required" && !f[key])) out[key] = f[key];
    }
    return out;
  };
  const side = (p) => (p.replaces ? { name: p.name, type: p.type, label: p.label, replaces: p.replaces } : { name: p.name, type: p.type, label: p.label });
  return [...reg.values()].map((b) => ({
    kind: b.kind, title: b.title, category: b.category, help: b.help,
    inputs: b.inputs.map(side), outputs: b.outputs.map(side), fields: b.fields.map(plain),
  }));
}

// ---------------------------------------------------------------------- settings
const ITEM_CHECK = {
  number: (v) => (typeof v === "number" && Number.isFinite(v) ? "" : "Input should be a valid number"),
  text: (v) => (typeof v === "string" ? "" : "Input should be a valid string"),
  colour: (v) => { try { parseColour(v); return typeof v === "string" ? "" : "Input should be #rrggbb"; } catch (err) { return err.message; } },
};

function checkField(f, v) {
  const number = () => {
    if (typeof v !== "number" || !Number.isFinite(v)) return "Input should be a valid number";
    if (f.kind === "int" && !Number.isInteger(v)) return "Input should be a valid integer";
    if (f.min !== undefined && v < f.min) return `Input should be greater than or equal to ${f.min}`;
    if (f.max !== undefined && v > f.max) return `Input should be less than or equal to ${f.max}`;
    if (f.above !== undefined && v <= f.above) return `Input should be greater than ${f.above}`;
    if (f.below !== undefined && v >= f.below) return `Input should be less than ${f.below}`;
    return "";
  };
  if (f.kind === "int" || f.kind === "float") return number();
  if (f.kind === "bool") return typeof v === "boolean" ? "" : "Input should be a valid boolean";
  if (f.kind === "select") return f.options.includes(v) ? "" : `Input should be ${f.options.map((o) => `'${o}'`).join(", ")}`;
  if (f.kind === "colour") return ITEM_CHECK.colour(v);
  if (f.kind === "time") return typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v) ? "" : "Input should be a time, HH:MM";
  if (LIST_OF.has(f.kind)) {
    if (!Array.isArray(v)) return "Input should be a valid list";
    const min = f.min_items ?? 0, max = f.max_items ?? MAX_LIST;
    if (v.length < min) return `List should have at least ${min} item${min === 1 ? "" : "s"}`;
    if (v.length > max) return `List should have at most ${max} items`;
    const one = ITEM_CHECK[LIST_OF.get(f.kind)];
    for (const [i, item] of v.entries()) { const why = one?.(item); if (why) return `${i}: ${why}`; }
    return "";
  }
  // text, and settings of the host's own kinds
  if (typeof v !== "string") return "Input should be a valid string";
  if (f.max_length !== undefined && v.length > f.max_length) return `String should have at most ${f.max_length} characters`;
  return "";
}

/**
 * The settings of a node as the block sees them: its options over the defaults, checked.
 * Returns { options, errors }; errors are "field: what is wrong" lines.
 */
export function readOptions(block, given = {}) {
  const errors = [];
  const options = {};
  const known = new Set(block.fields.map((f) => f.name));
  for (const name of Object.keys(given)) if (!known.has(name)) errors.push(`${name}: Extra inputs are not permitted`);
  for (const f of block.fields) {
    if (given[f.name] === undefined) {
      if (f.required) errors.push(`${f.name}: Field required`); else options[f.name] = f.default;
      continue;
    }
    const why = checkField(f, given[f.name]);
    if (why) errors.push(`${f.name}: ${why}`); else options[f.name] = given[f.name];
  }
  if (!errors.length && block.validate) {  // a rule across settings: return "field: why" lines
    try { errors.push(...(block.validate(options) ?? [])); } catch (err) { errors.push(`settings: ${err.message}`); }
  }
  return { options: Object.freeze(options), errors };
}
