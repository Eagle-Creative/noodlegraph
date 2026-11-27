// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * noodlegraph runtime — runs graphs.
 *
 * Rules the engine enforces, whatever a graph contains (spec/SPEC.md, "Running"):
 *
 * - graphs run only while the engine is active; deactivate() cancels every chain, stops the
 *   triggers and calls Context.release(). Nothing resumes by itself;
 * - a trigger only emits; the engine applies its cooldown and its "if still running" setting
 *   and starts the chain;
 * - a chain can be cancelled at any step and ends after `maxRunS` at the latest (unless it
 *   has a loop); a failing block ends its chain and is reported, never the engine;
 * - every chain runs on its own, so chains do not wait for each other.
 */
import { LOOP_DONE, LOOP_EACH, coerce } from "./blocks.js";
import { check } from "./graph.js";

/** A graph that cannot do what was asked (shown to the user). */
export class GraphError extends Error {}
/** Thrown inside a chain that was cancelled; a block lets it pass. */
export class Cancelled extends Error {
  constructor() { super("cancelled"); }
}
class TimedOut extends Error {}
/** Why a chain was stopped when one of its branches failed. */
class BranchFailed extends Error {
  constructor(cause) { super("a branch failed"); this.cause = cause; }
}

/** How far a graph may go: the host sets what suits it (a show, a tool, a game). */
export const LIMITS = Object.freeze({
  maxRunS: 3600,       // the longest a chain without a loop may run; null: no end
  maxSteps: 10_000,    // steps of one chain, or of one round of a loop
  maxValueDepth: 64,   // value blocks feeding value blocks
  maxLoopDepth: 8,     // loops inside loops
  minRoundS: 0.02,     // the shortest round of a loop, so a loop cannot hog the host
  maxCallDepth: 16,    // graphs running graphs running graphs
});

/** The host as blocks see it. Extend it and add your own methods and fields. */
export class Context {
  /** Seconds that only go forward (for cooldowns and the pace of loops). */
  clock() { return globalThis.performance.now() / 1000; }
  /** The time of day (for triggers that fire at a time). */
  now() { return new Date(); }
  /** Wait; ends early (throws Cancelled) when *signal* is aborted. */
  sleep(seconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Cancelled()); return; }
      const stop = () => { clearTimeout(timer); reject(new Cancelled()); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, Math.max(seconds, 0) * 1000);
      signal?.addEventListener("abort", stop, { once: true });
    });
  }
  /** Let go of everything the graphs held: called when the engine is deactivated. */
  async release() {}
}

const result = (trigger, outcome, message = "") => ({ trigger, result: outcome, message, ts: Date.now() / 1000 });

/**
 * Loads graphs, starts their triggers while it is active and runs their chains.
 *
 *   new Engine({ context, registry, limits, onEvent, onStatus })
 *
 * onEvent(graphId, { event, trigger, node, message }): event is "started", "step" (the chain
 * reached this block), "finished", "failed" or "cancelled". onStatus(status) is called
 * whenever status() changes.
 */
export class Engine {
  constructor({ context = new Context(), registry, limits = {}, onEvent = null, onStatus = null } = {}) {
    if (!(registry instanceof Map)) throw new Error("the engine needs a registry: registry(STANDARD, ...yourBlocks)");
    this.ctx = context;
    this.registry = registry;
    this.limits = { ...LIMITS, ...limits };
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this._loaded = new Map();  // graph id -> { compiled, triggers: Map, runs: Map, firedAt: Map, last }
    this._active = false;
    this._queue = Promise.resolve();
  }

  // ------------------------------------------------------------------ lifecycle
  /** Triggers are listening and chains may run. */
  get active() { return this._active; }

  /** One change of state at a time (load, activate, deactivate). */
  _serial(fn) {
    const next = this._queue.then(fn);
    this._queue = next.catch(() => {});
    return next;
  }

  /** Start the triggers of every enabled, valid graph. */
  async activate() {
    await this._serial(async () => { if (this._active) return; this._active = true; await this._activate(); });
    await this._publishStatus();
  }

  /** Cancel every chain, stop the triggers and let go of everything (the STOP). */
  async deactivate() {
    await this._serial(async () => { if (!this._active) return; this._active = false; await this._deactivate(); });
    await this._publishStatus();
  }

  /** Replace the graphs (after a save); running chains are cancelled. Graphs as parse() returns them. */
  async load(graphs) {
    await this._serial(async () => {
      await this._deactivate();
      this._loaded = new Map([...graphs].map((g) => [g.id, { compiled: check(g, this.registry, this.ctx), triggers: new Map(), runs: new Map(), firedAt: new Map(), last: null, variables: new Map() }]));
      if (this._active) await this._activate();
    });
    await this._publishStatus();
  }

  /** The checked form of a loaded graph. */
  compiled(graphId) { return this._loaded.get(graphId)?.compiled ?? null; }

  // ------------------------------------------------------------------ activation
  async _activate() {
    for (const loaded of this._loaded.values()) {
      loaded.variables.clear();  // variables start empty with every activation
      const c = loaded.compiled;
      if (!(c.graph.enabled && c.valid)) continue;
      for (const nodeId of c.triggers) await this._startTrigger(loaded, nodeId);
    }
  }

  async _startTrigger(loaded, nodeId) {
    if (loaded.triggers.has(nodeId)) return;
    const c = loaded.compiled, block = c.blocks.get(nodeId);
    const controller = new AbortController();
    const entry = { controller, stop: null, task: null };
    loaded.triggers.set(nodeId, entry);
    const args = {
      ctx: this.ctx, options: c.options.get(nodeId), node: nodeId, signal: controller.signal, variables: loaded.variables,
      sleep: (seconds) => this.ctx.sleep(seconds, controller.signal),
      emit: (values = {}) => { if (!controller.signal.aborted) this._fire(loaded, nodeId, { at: this.ctx.clock(), values }); },
    };
    try {
      if (block.watch) {  // runs until it is stopped
        entry.task = Promise.resolve().then(() => block.watch(args)).catch((err) => {
          if (err instanceof Cancelled || controller.signal.aborted) return;
          loaded.last = result(nodeId, "failed", `trigger stopped: ${err.message}`);
          this._publishStatus();
        });
      } else {
        entry.stop = (await block.start(args)) ?? null;
      }
    } catch (err) {  // a block must not take the engine down
      loaded.last = result(nodeId, "failed", `trigger did not start: ${err.message}`);
    }
  }

  async _deactivate() {
    const waiting = [];
    for (const loaded of this._loaded.values()) {
      for (const run of loaded.runs.values()) { run.controller.abort(new Cancelled()); waiting.push(run.done); }
      for (const trigger of loaded.triggers.values()) {
        trigger.controller.abort(new Cancelled());
        try { await trigger.stop?.(); } catch { /* a trigger that cannot stop is left behind */ }
        if (trigger.task) waiting.push(trigger.task);
      }
      loaded.triggers.clear();
    }
    await Promise.allSettled(waiting);
    for (const loaded of this._loaded.values()) loaded.runs.clear();
    try { await this.ctx.release(); } catch { /* the host's release failed: nothing more to do here */ }
  }

  // ------------------------------------------------------------------ running
  _get(graphId) {
    const loaded = this._loaded.get(graphId);
    if (!loaded) throw new GraphError(`no graph '${graphId}'`);
    return loaded;
  }

  /** Start a chain from one of its triggers by hand (the editor's ▶). */
  async fire(graphId, nodeId) {
    const loaded = this._get(graphId), c = loaded.compiled;
    if (!c.valid) throw new GraphError(`fix the graph's problems first: ${c.problems.slice(0, 3).join("; ")}`);
    if (!c.triggers.includes(nodeId)) throw new GraphError(`'${nodeId}' is not a trigger block of this graph`);
    if (!this._active) throw new GraphError("the engine is not active: activate it to run a graph");
    this._fire(loaded, nodeId, { at: this.ctx.clock(), values: {} }, true);
  }

  /** Ids of the graph's Run button blocks (trigger kind "manual"). */
  runButtons(graphId) { return this._get(graphId).compiled.graph.nodes.filter((n) => n.kind === "manual").map((n) => n.id); }

  /** Cancel the running chains of a graph; returns the triggers they started from. Its triggers keep listening. */
  async cancel(graphId) {
    const loaded = this._get(graphId);
    const stopped = [...loaded.runs.keys()];
    const waiting = [...loaded.runs.values()].map((run) => { run.controller.abort(new Cancelled()); return run.done; });
    await Promise.allSettled(waiting);
    return stopped;
  }

  /**
   * The value of an output of a value block right now, without running a chain: for graphs
   * that only calculate and for showing live values. Values of a trigger or of a loop exist
   * only inside a chain and cannot be asked for.
   */
  evaluate(graphId, nodeId, portName) {
    const loaded = this._get(graphId), c = loaded.compiled;
    if (!c.valid) throw new GraphError(`fix the graph's problems first: ${c.problems.slice(0, 3).join("; ")}`);
    const block = c.blocks.get(nodeId);
    if (block?.role !== "value") throw new GraphError(`'${nodeId}' is not a value block of this graph`);
    const out = block.outputs.find((p) => p.name === portName);
    if (!out) throw new GraphError(`'${nodeId}' has no output '${portName}'`);
    return this._output({ c, triggerId: "", event: { values: {} }, state: new Map(), loopValues: new Map(), variables: loaded.variables, calls: 0 }, nodeId, portName, out.type, 0);
  }

  _fire(loaded, nodeId, event, forced = false) {
    if (!this._active) return;
    const options = loaded.compiled.options.get(nodeId);
    const last = loaded.firedAt.get(nodeId);
    if (!forced && last !== undefined && event.at - last < (options.cooldown_s ?? 0)) return;
    const running = loaded.runs.get(nodeId);
    if (running) {
      if (!forced && (options.when_running ?? "ignore") === "ignore") return;
      running.controller.abort(new Cancelled());
    }
    loaded.firedAt.set(nodeId, event.at);
    const entry = { controller: new AbortController(), done: null };
    loaded.runs.set(nodeId, entry);
    entry.done = this._run(loaded, nodeId, event, entry);
  }

  async _run(loaded, triggerId, event, entry) {
    const gid = loaded.compiled.graph.id, signal = entry.controller.signal;
    const run = { c: loaded.compiled, triggerId, event, signal, controller: entry.controller, state: new Map(), loopValues: new Map(), variables: loaded.variables, calls: 0 };
    await this._event(gid, "started", triggerId, triggerId);
    await this._publishStatus();
    let outcome = "finished", message = "";
    // a graph with a loop may run as long as the engine is active; others have a limit
    const limit = loaded.compiled.loops ? null : this.limits.maxRunS;
    const timer = limit === null ? null : setTimeout(() => entry.controller.abort(new TimedOut()), limit * 1000);
    try {
      await this._follow(run, run.c.next(triggerId, "out"), 0);
    } catch (err) {
      const failed = signal.reason instanceof BranchFailed ? signal.reason.cause : null;
      if (failed) [outcome, message] = ["failed", failed?.message || String(failed)];
      else if (signal.aborted && signal.reason instanceof TimedOut) [outcome, message] = ["failed", `stopped after ${limit} s (the longest a chain may run)`];
      else if (signal.aborted || err instanceof Cancelled) outcome = "cancelled";
      else [outcome, message] = ["failed", err?.message || String(err)];  // a block must not take the engine down
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (loaded.runs.get(triggerId) === entry) loaded.runs.delete(triggerId);
      loaded.last = result(triggerId, outcome, message);
      await this._event(gid, outcome, triggerId, triggerId, message);
      await this._publishStatus();
    }
  }

  /**
   * Continue at *nodes*: nowhere, at one, or at several at the same time. With several the
   * chain goes on when all of them reached their end; one that fails stops the others.
   */
  async _follow(run, nodes, depth) {
    if (nodes.length === 0) return;
    if (nodes.length === 1) { await this._walk(run, nodes[0], depth); return; }
    const ends = await Promise.allSettled(nodes.map((node) => this._walk(run, node, depth).catch((err) => {
      if (!(err instanceof Cancelled) && !run.signal.aborted) run.controller.abort(new BranchFailed(err));
      throw err;
    })));
    const bad = ends.filter((e) => e.status === "rejected").map((e) => e.reason);
    if (bad.length) throw bad.find((err) => !(err instanceof Cancelled)) ?? bad[0];
  }

  /** Run the steps from *start* to the end of its branch (a loop's rounds included). */
  async _walk(run, start, depth) {
    if (depth > this.limits.maxLoopDepth) throw new GraphError("loops nested too deep");
    const c = run.c;
    let node = start, steps = 0;
    while (node !== null) {
      if (run.signal.aborted) throw new Cancelled();
      if (++steps > this.limits.maxSteps) throw new GraphError("too many steps");
      const block = c.blocks.get(node);
      if (block.role !== "action" && block.role !== "loop") throw new GraphError(`${node}: not an action`);
      await this._event(c.graph.id, "step", run.triggerId, node);
      let nexts;
      if (block.role === "loop") {
        await this._rounds(run, node, block, depth);
        nexts = c.next(node, LOOP_DONE);
      } else {
        const out = await block.run(this._args(run, node, { inputs: this._inputs(run, node, block) }));
        if (run.signal.aborted) throw new Cancelled();
        nexts = c.next(node, out ?? "out");
      }
      if (nexts.length > 1) { await this._follow(run, nexts, depth); return; }  // branches
      node = nexts[0] ?? null;
    }
  }

  async _rounds(run, node, block, depth) {
    const body = run.c.next(node, LOOP_EACH);
    let inputs = this._inputs(run, node, block), rounds = 0;
    try {
      while (block.again(this._args(run, node, { inputs, rounds }))) {
        const values = block.values?.(this._args(run, node, { inputs, rounds })) ?? {};
        for (const [name, value] of Object.entries(values)) run.loopValues.set(`${node}\0${name}`, value);
        const started = this.ctx.clock();
        await this._follow(run, body, depth + 1);
        rounds += 1;
        const took = this.ctx.clock() - started;
        await this.ctx.sleep(Math.max(this.limits.minRoundS - took, 0), run.signal);  // lets others run
        if (took >= 0.2 || rounds % 10 === 0) await this._event(run.c.graph.id, "step", run.triggerId, node);  // the editor lights the loop up, not too often
        if (!block.fixed) inputs = this._inputs(run, node, block);
      }
    } finally {
      for (const p of block.outputs) run.loopValues.delete(`${node}\0${p.name}`);  // known only inside the rounds
    }
  }

  /**
   * What a block's function gets. `state` is the block's own memory for this chain,
   * `variables` the variables of its graph (a Map by name), `call(graphId)` runs another graph.
   */
  _args(run, node, more) {
    if (!run.state.has(node)) run.state.set(node, {});
    return {
      ctx: this.ctx, options: run.c.options.get(node), node, state: run.state.get(node), signal: run.signal, variables: run.variables,
      sleep: (seconds) => this.ctx.sleep(seconds, run.signal), call: (graphId) => this._call(run, graphId), ...more,
    };
  }

  /**
   * Run another graph as a step of this chain: the chain after its "When run by another
   * graph" block, to its end. It is part of the calling chain (cancelled and limited with
   * it) but works on its own graph's variables.
   */
  async _call(run, graphId) {
    const loaded = this._loaded.get(graphId);
    if (!loaded) throw new GraphError(`there is no graph '${graphId}' to run`);
    const c = loaded.compiled;
    if (!c.valid) throw new GraphError(`the graph '${graphId}' has problems and cannot be run`);
    const entries = c.graph.nodes.filter((n) => n.kind === "called").map((n) => n.id);
    if (entries.length !== 1) throw new GraphError(`the graph '${graphId}' needs one 'When run by another graph' block (it has ${entries.length})`);
    if (run.calls + 1 > this.limits.maxCallDepth) throw new GraphError("graphs run each other too deep");
    const inner = { ...run, c, triggerId: entries[0], event: { values: {} }, state: new Map(), loopValues: new Map(), variables: loaded.variables, calls: run.calls + 1 };
    await this._follow(inner, c.next(entries[0], "out"), 0);
  }

  /** The values of a step's inputs; one that replaces a setting only when it is wired. */
  _inputs(run, node, block) {
    const inputs = {};
    for (const p of block.inputs) {
      if (p.type === "flow" || (p.replaces && !run.c.source(node, p.name))) continue;
      inputs[p.name] = this._value(run, node, p.name, 0);
    }
    return inputs;
  }

  /** The value of an input port: its wire, or else the block's own setting. */
  _value(run, nodeId, portName, depth) {
    if (depth > this.limits.maxValueDepth) throw new GraphError("value wires nested too deep");
    const c = run.c;
    const type = c.blocks.get(nodeId).inputs.find((p) => p.name === portName).type;
    const source = c.source(nodeId, portName);
    if (source === null) {
      const options = c.options.get(nodeId);
      if (!(portName in options)) throw new GraphError(`${nodeId}: nothing is wired into '${portName}' and it has no setting of that name`);
      return coerce(options[portName], type);
    }
    const [srcNode, srcPort] = source;
    const src = c.blocks.get(srcNode);
    if (src.role === "trigger") {
      if (srcNode !== run.triggerId || !(srcPort in (run.event.values ?? {}))) throw new GraphError(`${nodeId}: the value of ${srcNode} is only known in its own chain`);
      return coerce(run.event.values[srcPort], type);
    }
    if (src.role === "loop") {
      const k = `${srcNode}\0${srcPort}`;
      if (!run.loopValues.has(k)) throw new GraphError(`${nodeId}: the ${srcPort} of ${srcNode} is only known inside its rounds`);
      return coerce(run.loopValues.get(k), type);
    }
    return this._output(run, srcNode, srcPort, type, depth);
  }

  /** The value of an output port of a value block, brought into *type*. */
  _output(run, nodeId, portName, type, depth) {
    const block = run.c.blocks.get(nodeId);
    if (block.role !== "value") throw new GraphError(`${nodeId}: not a value block`);
    const need = block.depends[portName];  // only what this output is computed from
    const inputs = {};
    for (const p of block.inputs) if (!need || need.includes(p.name)) inputs[p.name] = this._value(run, nodeId, p.name, depth + 1);
    return coerce(block.compute(this._args(run, nodeId, { inputs }))[portName], type);
  }

  // ------------------------------------------------------------------ reporting
  /** State of every loaded graph (also handed to onStatus whenever it changes). */
  status() {
    const graphs = {};
    for (const [gid, loaded] of this._loaded) {
      const c = loaded.compiled;
      graphs[gid] = {
        name: c.graph.name, enabled: c.graph.enabled, valid: c.valid, problems: [...c.problems],
        listening: [...loaded.triggers.keys()].sort(), running: [...loaded.runs.keys()].sort(), last: loaded.last,
      };
    }
    return { active: this._active, graphs };
  }

  _publishStatus() { return this._tell(this.onStatus, this.status()); }
  _event(gid, event, trigger, node, message = "") { return this._tell(this.onEvent, gid, { event, trigger, node, message }); }

  /** Call a listener of the host; one that fails is reported on the console, never ends a chain. */
  async _tell(listener, ...args) {
    if (!listener) return;
    try { await listener(...args); } catch (err) { globalThis.console?.error("noodlegraph: a listener of the engine failed", err); }
  }
}
