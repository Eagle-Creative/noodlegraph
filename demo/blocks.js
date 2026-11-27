// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * The demo's own blocks: what a host application adds next to the standard ones.
 *
 * The "host" is a tiny stage drawn in the page: two lamps, a pointer, a button, a slider and
 * a line of text. Stage is the context its blocks work through.
 */
import { Context, defineBlock } from "../runtimes/javascript/src/index.js";

export const LAMPS = { left: "Left lamp", right: "Right lamp" };
const FLOW = { name: "in", type: "flow" };
const hex = ([r, g, b]) => `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
const dark = () => Object.fromEntries(Object.keys(LAMPS).map((id) => [id, "#000000"]));

/** The demo stage: its state, and who to tell when it changes. */
export class Stage extends Context {
  constructor(changed) {
    super();
    this.lamps = dark();
    this.pointer = { angle: 0, seconds: 0 };
    this.slider = 50;
    this.line = "";
    this.changed = changed;
    this.buttonListeners = new Set();
  }
  /** The stage changed: draw it again. */
  tell() { this.changed(this); }
  /** Call *listener* at every press of the button; returns how to stop that. */
  onButton(listener) { this.buttonListeners.add(listener); return () => this.buttonListeners.delete(listener); }
  /** The button of the page was pressed. */
  press() { for (const listener of [...this.buttonListeners]) listener(); }
  /** Stopped: lamps off, pointer back. */
  async release() {
    this.lamps = dark();
    this.pointer = { angle: 0, seconds: 0.3 };
    this.line = "";
    this.tell();
  }
}

export const ButtonPressed = defineBlock({
  role: "trigger", kind: "button", title: "When the button is pressed",
  help: "Starts when you press the button on the stage.",
  start: ({ ctx, emit }) => ctx.onButton(() => emit()),  // what it returns stops it again
});

export const SetLamp = defineBlock({
  role: "action", kind: "set_lamp", title: "Set lamp", help: "Gives a lamp a colour. Black is off.",
  inputs: [FLOW, { name: "colour", type: "colour" }],
  fields: [
    { name: "lamp", kind: "lamp", required: true, help: "Which lamp." },
    { name: "colour", kind: "colour", default: "#ff8800" },
  ],
  run({ ctx, options, inputs }) { ctx.lamps[options.lamp] = hex(inputs.colour); ctx.tell(); return "out"; },
  problems: ({ options }) => (options.lamp in LAMPS ? [] : [`there is no lamp '${options.lamp}'`]),
});

export const MovePointer = defineBlock({
  role: "action", kind: "move_pointer", title: "Move pointer",
  help: "Turns the pointer to an angle (0 to 180) and waits until it is there.",
  inputs: [FLOW, { name: "angle", type: "number" }, { name: "seconds", type: "number" }],
  fields: [
    { name: "angle", kind: "float", min: 0, max: 180, default: 90 },
    { name: "seconds", kind: "float", min: 0, max: 60, default: 0.5, help: "How long the move takes." },
  ],
  async run({ ctx, inputs, sleep }) {
    const seconds = Math.min(Math.max(inputs.seconds, 0), 60);
    ctx.pointer = { angle: Math.min(Math.max(inputs.angle, 0), 180), seconds };
    ctx.tell();
    await sleep(seconds);
    return "out";
  },
});

export const Say = defineBlock({
  role: "action", kind: "say", title: "Say", help: "Shows a line of text on the stage.",
  inputs: [FLOW, { name: "text", type: "text" }],
  fields: [{ name: "text", kind: "text", max_length: 80, default: "Hello" }],
  run({ ctx, inputs }) { ctx.line = inputs.text; ctx.tell(); return "out"; },
});

export const Slider = defineBlock({
  role: "value", kind: "slider", title: "Slider", help: "Where the slider on the stage stands, 0 to 100.",
  outputs: [{ name: "value", type: "number" }],
  compute: ({ ctx }) => ({ value: ctx.slider }),
});

export const DEMO_BLOCKS = [ButtonPressed, SetLamp, MovePointer, Say, Slider];
/** What the settings of kind "lamp" offer in the editor. */
export const CHOICES = { lamp: Object.entries(LAMPS).map(([value, label]) => ({ value, label })) };
