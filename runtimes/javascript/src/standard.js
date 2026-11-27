// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * noodlegraph runtime — the block types every host can use as they are (spec/SPEC.md,
 * "Standard blocks"). Triggers that need nothing but a clock, waiting, If / For / While, and
 * values. A host adds its own next to these: registry(STANDARD, mySetLamp, myTrigger).
 */
import { LOOP_OUTPUTS, MAX_LIST, defineBlock, hueColour, parseColour, roundHalfEven } from "./blocks.js";

export const MAX_WAIT_S = 3600;
const FLOW = { name: "in", type: "flow" };

/** The *number*-th of *items*, counting from 1; past the last it starts again at the first. */
export function nth(items, number, what = "item") {
  if (!items.length) throw new Error(`no ${what}`);
  const i = (roundHalfEven(Number(number)) - 1) % items.length;
  return items[(i + items.length) % items.length];
}

// ====================================================================== triggers
export const RunButton = defineBlock({
  role: "trigger", kind: "manual", title: "Run button",
  help: "Starts when you press Run on this block. For testing and for manual cues.",
  start() {},
});

export const OnStart = defineBlock({
  role: "trigger", kind: "start", title: "When started",
  help: "Starts once when the engine is activated (or this graph is switched on).",
  fields: [{ name: "delay_s", kind: "float", min: 0, max: 3600, default: 0.0, help: "Wait this long first." }],
  async watch({ options, emit, sleep }) { await sleep(options.delay_s); emit(); },
});

export const Interval = defineBlock({
  role: "trigger", kind: "interval", title: "Every interval",
  help: "Starts again and again, with this time between starts.",
  fields: [
    { name: "every_s", kind: "float", min: 0.2, max: 86400, default: 10.0, help: "Seconds between." },
    { name: "first_now", kind: "bool", default: true, help: "Also start right away." },
  ],
  async watch({ options, emit, sleep }) {
    if (!options.first_now) await sleep(options.every_s);
    for (;;) { emit(); await sleep(options.every_s); }
  },
});

export const TimeOfDay = defineBlock({
  role: "trigger", kind: "time_of_day", title: "At a time of day",
  help: "Starts at this time, every day, by the clock of the host computer.",
  fields: [{ name: "time", kind: "time", default: "18:00", help: "HH:MM" }],
  async watch({ ctx, options, emit, sleep }) {
    const [hh, mm] = options.time.split(":").map(Number);
    for (;;) {
      const now = ctx.now(), target = new Date(now);
      target.setHours(hh, mm, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      await sleep((target - now) / 1000);
      emit();
      await sleep(1);  // leave the minute before looking again
    }
  },
});

// ====================================================================== actions
export const Wait = defineBlock({
  role: "action", kind: "wait", title: "Wait", help: "Pauses the chain.",
  inputs: [FLOW, { name: "seconds", type: "number" }],
  fields: [{ name: "seconds", kind: "float", min: 0, max: MAX_WAIT_S, default: 1.0 }],
  async run({ inputs, sleep }) { await sleep(Math.min(Math.max(inputs.seconds, 0), MAX_WAIT_S)); return "out"; },
});

// ====================================================================== logic
function bounds(inputs) {
  const start = inputs.start, end = inputs.end, step = Math.abs(inputs.step);
  if (step === 0) throw new Error("For: a step of 0 never gets from 'from' to 'to'");
  return [start, end, end >= start ? step : -step];
}

export const For = defineBlock({
  role: "loop", kind: "for", title: "For",
  help: "Counts i from 'from' to 'to' (both included) in steps of 'step' and runs the blocks "
    + "on 'each round' once for every i, then continues on 'done'. Wire i into a setting "
    + "(a brightness, a position, a hue; Map range scales it). If 'from' is larger than "
    + "'to' it counts down. Put a Wait in the round to set its pace.",
  inputs: [FLOW, { name: "start", type: "number", label: "from" }, { name: "end", type: "number", label: "to" }, { name: "step", type: "number", label: "step" }],
  outputs: [...LOOP_OUTPUTS, { name: "i", type: "number", label: "i" }],
  fixed: true,  // the bounds are read once, when the loop starts
  fields: [
    { name: "start", label: "From", kind: "float", default: 1, help: "The first i." },
    { name: "end", label: "To", kind: "float", default: 5, help: "The last i (included)." },
    { name: "step", kind: "float", above: 0, default: 1, help: "How much i changes each round." },
  ],
  again({ inputs, rounds }) { const [start, end, step] = bounds(inputs); return rounds <= Math.trunc(Math.abs(end - start) / Math.abs(step) + 1e-9); },
  values({ inputs, rounds }) { const [start, , step] = bounds(inputs); return { i: Number((start + rounds * step).toFixed(9)) }; },
});

export const While = defineBlock({
  role: "loop", kind: "while", title: "While",
  help: "Runs the blocks on 'each round' again and again while the condition is true "
    + "(checked before every round), then continues on 'done'. With nothing wired and the "
    + "condition ticked it runs for ever (until the engine is deactivated). 'round' counts 1, 2, 3 "
    + "and can be wired into a setting. Put a Wait in the round to set its pace.",
  inputs: [FLOW, { name: "condition", type: "bool" }],
  outputs: [...LOOP_OUTPUTS, { name: "round", type: "number", label: "round" }],
  fields: [{ name: "condition", kind: "bool", default: true, help: "Wire a condition here (Compare)." }],
  again: ({ inputs }) => Boolean(inputs.condition),
  values: ({ rounds }) => ({ round: rounds + 1 }),
});

export const Branch = defineBlock({
  role: "action", kind: "branch", title: "If", category: "logic",
  help: "Continues on 'then' if the condition is true, otherwise on 'else'.",
  inputs: [FLOW, { name: "condition", type: "bool" }],
  outputs: [{ name: "then", type: "flow" }, { name: "else", type: "flow" }],
  fields: [{ name: "condition", kind: "bool", default: true }],
  run: ({ inputs }) => (inputs.condition ? "then" : "else"),
});

// ====================================================================== values
export const NumberBlock = defineBlock({
  role: "value", kind: "number", title: "Number",
  outputs: [{ name: "value", type: "number" }],
  fields: [{ name: "value", kind: "float", default: 0.0 }],
  compute: ({ options }) => ({ value: options.value }),
});

/** A list block's outputs; 'item' only when its 'no.' was asked for. */
function listValues(items, inputs) {
  const out = { list: items, count: items.length };
  if ("index" in inputs) out.item = nth(items, inputs.index);
  return out;
}
const LIST_HELP = "'item' is the one at 'no.' (1 = the first; past the last it starts again), so a For's i "
  + "goes through them; 'count' is how many there are (wire it into a For's 'to').";
const listBlock = (kind, title, help, type, itemType, field, start, read = (x) => x) => defineBlock({
  role: "value", kind, title, help: help + LIST_HELP,
  inputs: [{ name: "index", type: "number", label: "no." }],
  outputs: [{ name: "list", type, label: "list" }, { name: "item", type: itemType, label: "item" }, { name: "count", type: "number", label: "count" }],
  depends: { list: [], count: [] },
  fields: [
    { name: field, kind: type, default: start, min_items: 1, max_items: MAX_LIST },
    { name: "index", label: "No.", kind: "float", default: 1, help: "Which one 'item' is; 1 = the first." },
  ],
  compute: ({ options, inputs }) => listValues(options[field].map(read), inputs),
});

export const NumberList = listBlock("number_list", "Number list", "Numbers in order: positions to step through, brightness levels, waiting times. ", "numbers", "number", "values", [0.0, 50.0, 100.0]);
export const TextList = listBlock("text_list", "Text list", "Texts in order: lines to say, names to go through. ", "texts", "text", "texts", ["one", "two", "three"]);
export const ColourList = listBlock("colour_list", "Colour list", "Colours in order. 'list' feeds a setting that takes several colours; ", "colours", "colour", "colours", ["#ff0000", "#00ff00", "#0000ff"], parseColour);

export const Text = defineBlock({
  role: "value", kind: "text", title: "Text",
  outputs: [{ name: "value", type: "text" }],
  fields: [{ name: "value", kind: "text", default: "" }],
  compute: ({ options }) => ({ value: options.value }),
});

export const MapRange = defineBlock({
  role: "value", kind: "map_range", title: "Map range",
  help: "Scales a number: in min..in max becomes out min..out max.",
  inputs: [{ name: "value", type: "number" }],
  outputs: [{ name: "result", type: "number" }],
  fields: [
    { name: "value", kind: "float", default: 0.0 }, { name: "in_min", kind: "float", default: 0.0 }, { name: "in_max", kind: "float", default: 1.0 },
    { name: "out_min", kind: "float", default: 0.0 }, { name: "out_max", kind: "float", default: 100.0 }, { name: "clamp", kind: "bool", default: true },
  ],
  compute({ options: o, inputs }) {
    const span = o.in_max - o.in_min;
    let t = span === 0 ? 0 : (inputs.value - o.in_min) / span;
    if (o.clamp) t = Math.min(Math.max(t, 0), 1);
    return { result: o.out_min + (o.out_max - o.out_min) * t };
  },
});

export const Compare = defineBlock({
  role: "value", kind: "compare", title: "Compare",
  inputs: [{ name: "a", type: "number" }, { name: "b", type: "number" }],
  outputs: [{ name: "result", type: "bool" }],
  fields: [{ name: "a", kind: "float", default: 0.0 }, { name: "op", kind: "select", options: [">", "<", ">=", "<=", "="], default: ">" }, { name: "b", kind: "float", default: 0.0 }],
  compute({ options, inputs: { a, b } }) { return { result: { ">": a > b, "<": a < b, ">=": a >= b, "<=": a <= b, "=": a === b }[options.op] }; },
});

export const ColourFromHue = defineBlock({
  role: "value", kind: "colour_hue", title: "Colour from hue",
  help: "Hue 0-360 (0 red, 120 green, 240 blue) and brightness 0-100 make a colour.",
  inputs: [{ name: "hue", type: "number" }, { name: "brightness", type: "number" }],
  outputs: [{ name: "colour", type: "colour" }],
  fields: [{ name: "hue", kind: "float", default: 0.0 }, { name: "brightness", kind: "float", min: 0, max: 100, default: 50.0 }],
  compute: ({ inputs }) => ({ colour: hueColour(inputs.hue, inputs.brightness) }),
});

export const Random = defineBlock({
  role: "value", kind: "random", title: "Random",
  outputs: [{ name: "value", type: "number" }],
  fields: [{ name: "min", kind: "float", default: 0.0 }, { name: "max", kind: "float", default: 100.0 }],
  compute: ({ options }) => ({ value: options.min + Math.random() * (options.max - options.min) }),
});

// ====================================================================== variables
// A variable is a named value of its graph. It keeps what a chain stored in it until the
// engine is deactivated; one that was never set reads as 0, no, "" or black.
const NAME = { name: "name", kind: "variable", default: "x", help: "Which variable. Blocks with the same name share it." };
const setter = (kind, title, type, fieldKind, start, help) => defineBlock({
  role: "action", kind, title, help,
  inputs: [FLOW, { name: "value", type }],
  fields: [NAME, { name: "value", kind: fieldKind, default: start }],
  run({ variables, options, inputs }) { variables.set(options.name, inputs.value); return "out"; },
});
const getter = (kind, title, type, unset, help) => defineBlock({
  role: "value", kind, title, help,
  outputs: [{ name: "value", type }],
  fields: [NAME],
  compute: ({ variables, options }) => ({ value: variables.has(options.name) ? variables.get(options.name) : unset }),
});

export const SetNumber = setter("set_number", "Set number", "number", "float", 0.0, "Stores a number in a variable.");
export const ChangeNumber = defineBlock({
  role: "action", kind: "change_number", title: "Change number", help: "Adds to the number in a variable (a negative number takes away). Counts things.",
  inputs: [FLOW, { name: "by", type: "number" }],
  fields: [NAME, { name: "by", kind: "float", default: 1.0 }],
  run({ variables, options, inputs }) {
    const now = variables.has(options.name) ? variables.get(options.name) : 0;
    if (typeof now !== "number") throw new Error(`the variable '${options.name}' is not a number`);
    variables.set(options.name, now + inputs.by);
    return "out";
  },
});
export const GetNumber = getter("get_number", "Number variable", "number", 0, "The number stored in a variable; 0 if nothing was stored yet.");
export const SetText = setter("set_text", "Set text", "text", "text", "", "Stores a text in a variable.");
export const GetText = getter("get_text", "Text variable", "text", "", "The text stored in a variable; empty if nothing was stored yet.");
export const SetBool = setter("set_bool", "Set yes / no", "bool", "bool", true, "Stores yes or no in a variable.");
export const GetBool = getter("get_bool", "Yes / no variable", "bool", false, "The yes or no stored in a variable; no if nothing was stored yet.");
export const SetColour = setter("set_colour", "Set colour", "colour", "colour", "#ff8800", "Stores a colour in a variable.");
export const GetColour = getter("get_colour", "Colour variable", "colour", [0, 0, 0], "The colour stored in a variable; black if nothing was stored yet.");

// ====================================================================== graphs running graphs
export const Called = defineBlock({
  role: "trigger", kind: "called", title: "When run by another graph",
  help: "Starts when a 'Run graph' block of another graph runs this graph. A graph has at most one of these.",
  start() {},
});
export const Call = defineBlock({
  role: "action", kind: "call", title: "Run graph",
  help: "Runs another graph from its 'When run by another graph' block, waits until it is done, then continues. Build a sequence once and use it in several places.",
  fields: [{ name: "graph", kind: "graph", required: true, help: "Which graph to run." }],
  async run({ options, call }) { await call(options.graph); return "out"; },
});

/** The standard blocks, in the order the editor lists them. */
export const STANDARD = Object.freeze([
  RunButton, OnStart, Interval, TimeOfDay, Called,
  Wait, Call, SetNumber, ChangeNumber, SetText, SetBool, SetColour, Branch, For, While,
  NumberBlock, NumberList, Text, TextList, ColourList, MapRange, Compare, ColourFromHue, Random,
  GetNumber, GetText, GetBool, GetColour,
]);
