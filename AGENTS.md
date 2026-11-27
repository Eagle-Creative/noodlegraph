# Noodlegraph for coding agents

You are an AI coding agent. This file tells you how to put Noodlegraph into an application, and
how to work on Noodlegraph itself. It is written to be followed step by step. Everything in it
is checked against the code in this repository; when in doubt, the code and `spec/SPEC.md` win.

Noodlegraph is a block coding framework. People draw a graph of blocks and wires in an
**editor**; an **engine** checks the graph and runs it. The application supplies the blocks.

## Part 1: Put Noodlegraph into an application

### Before you write code, find out

Ask the person, or read their code, until you can answer these:

1. **What should a graph be able to do?** List the actions (things to do), the triggers (things
   that start a chain) and the values (things to read) of their application. These become blocks.
2. **Where does the graph run?** In the browser page (use `runtimes/javascript`), in Node.js
   (same), or in a Python process (use `runtimes/python`).
3. **Where is the graph kept?** A file, a database, a server, `localStorage`.
4. **Does the page already have a framework** (React, Vue, Svelte)? The editor is plain DOM:
   mount it into an element once and keep the handle; do not re-create it on every render.

### Files to bring in

Copy these folders unchanged. Do not edit them, do not bundle them, do not add a build step.

| Need | Folder | Entry point |
|---|---|---|
| The editor (always, if people draw graphs) | `editors/web/` | `noodlegraph.js`, `noodlegraph.css` (`panzoom.js` must sit next to them) |
| Run graphs in JavaScript | `runtimes/javascript/src/` | `index.js` |
| Run graphs in Python | `runtimes/python/` | `pip install -e runtimes/python` into the application's own environment (a venv, not the system's Python), then `import noodlegraph` |

Keep `LICENSE` and the notice that the application uses Noodlegraph by Eagle Creative. The
licence is AGPL-3.0-or-later or commercial (`LICENSE.md`); tell the person if their project is
closed source, because then they need the commercial licence.

### The smallest working integration (browser)

```html
<link rel="stylesheet" href="editors/web/noodlegraph.css">
<div id="editor" style="height: 70vh"></div>

<script type="module">
  import { createEditor } from "./editors/web/noodlegraph.js";
  import { Context, Engine, STANDARD, catalogue, check, defineBlock, parse, registry }
    from "./runtimes/javascript/src/index.js";

  // 1. The application, as blocks see it. Put what blocks need on it.
  class App extends Context {
    setLamp(rgb) { /* ... */ }
    async release() { /* the engine was stopped: return to a safe state */ }
  }

  // 2. The application's own blocks.
  const SetLamp = defineBlock({
    role: "action", kind: "set_lamp", title: "Set lamp", help: "Gives the lamp a colour.",
    inputs: [{ name: "in", type: "flow" }, { name: "colour", type: "colour" }],
    fields: [{ name: "colour", kind: "colour", default: "#ff8800" }],
    run({ ctx, inputs }) { ctx.setLamp(inputs.colour); return "out"; },
  });

  // 3. One registry for both halves.
  const GRAPH_ID = "main";
  const blocks = registry(STANDARD, SetLamp);
  const engine = new Engine({
    context: new App(), registry: blocks,
    onEvent(graphId, e) { if (e.event === "step") editor.step(e.node); },
    onStatus(s) { editor.setRunning(s.graphs[GRAPH_ID]?.running ?? []); },
  });

  // 4. Every change goes from the editor to the engine (and to wherever graphs are kept).
  async function load(graph) {
    const parsed = parse({ ...graph, id: GRAPH_ID, enabled: true });   // throws on a malformed document
    const problems = check(parsed, blocks, engine.ctx).problems;       // show these to the person
    await engine.load([parsed]);
    return problems;
  }

  const editor = createEditor(document.querySelector("#editor"), {
    blocks: catalogue(blocks),
    graph: { id: GRAPH_ID, enabled: true, nodes: [], wires: [] },
    onChange: load,
    onRun: (nodeId) => engine.fire(GRAPH_ID, nodeId),
  });

  await load(editor.getGraph());
  await engine.activate();
</script>
```

Working versions of this, smallest first: `examples/first-app/step1.html`, `step2.html`,
`step3.html`. A fuller application: `demo/demo.js` with `demo/blocks.js`.

### Writing blocks

A block is a description plus one function. The function depends on `role`.

| `role` | Write | It must |
|---|---|---|
| `"action"` | `run({ ctx, options, inputs, sleep, signal, variables, state })` | Return the **name** of the flow output to continue on (usually `"out"`). May be `async`. |
| `"trigger"` | `start({ ctx, options, emit })` returning a stop function, **or** `async watch({ ctx, options, emit, sleep })` that loops until stopped | Call `emit()` when its thing happens. Never run anything itself. |
| `"value"` | `compute({ ctx, options, inputs, variables })` | Return `{ outputName: value }`. No side effects. |
| `"loop"` | `again({ inputs, rounds })` and `values({ inputs, rounds })` | Say whether another round runs; give the loop's value outputs for that round. |

Ports left out get the usual ones for the role: an action has the flow input `in` and the flow
output `out`; a trigger has the flow output `out`; a loop has `each` and `done`. **If you list
`inputs` for an action, include `{ name: "in", type: "flow" }` yourself.**

```js
// a trigger that listens to the application
defineBlock({
  role: "trigger", kind: "door_opened", title: "When the door opens",
  start: ({ ctx, emit }) => ctx.onDoor(() => emit()),          // returns the function that stops listening
});

// a trigger that polls
defineBlock({
  role: "trigger", kind: "every_minute", title: "Every minute",
  async watch({ emit, sleep }) { for (;;) { await sleep(60); emit(); } },
});

// a value
defineBlock({
  role: "value", kind: "temperature", title: "Temperature",
  outputs: [{ name: "value", type: "number" }],
  compute: ({ ctx }) => ({ value: ctx.temperature }),
});

// an action with two ways out
defineBlock({
  role: "action", kind: "ask", title: "Ask", category: "logic",
  inputs: [{ name: "in", type: "flow" }, { name: "question", type: "text" }],
  outputs: [{ name: "yes", type: "flow" }, { name: "no", type: "flow" }],
  fields: [{ name: "question", kind: "text", default: "Continue?" }],
  async run({ ctx, inputs }) { return (await ctx.confirm(inputs.question)) ? "yes" : "no"; },
});
```

Rules that are easy to get wrong:

- **A value input must have a field of the same name.** `inputs: [{ name: "colour", ... }]` needs
  `fields: [{ name: "colour", ... }]`. Wired, the wire's value is used; otherwise the field.
- **Every field needs `default` or `required: true`.** `defineBlock` throws otherwise.
- **Colours** are `"#rrggbb"` in fields and `[r, g, b]` (0 to 255) in `inputs`.
- **Wait with `await sleep(seconds)`**, never `setTimeout` or a busy loop: `sleep` ends at once
  when the chain is cancelled. For your own async work, honour `signal` (an `AbortSignal`).
- **Reach the application only through `ctx`.** Do not capture page globals in blocks.
- **`kind` is permanent.** Saved graphs refer to it. Rename the `title` freely, never the `kind`.
- **Throwing fails the chain** with the error's message, which the person sees. Write messages
  for them: `"the lamp is not connected"`, not `"ECONNREFUSED"`.

Field kinds: `int`, `float` (`min`, `max`, `above`, `below`), `bool`, `text` (`max_length`),
`select` (`options`, `labels`), `colour`, `time`, lists `numbers` / `texts` / `colours`
(`min_items`, `max_items`), `variable`, or a kind of the application's own.

Port types: `flow`, `number`, `bool`, `text`, `colour`, `numbers`, `texts`, `colours`, or one
added with `registerType("pose", convert)` (and given a colour in the editor's `types` option).

**A setting that picks one of the application's things** (a lamp, a motor, a scene): give the
field a kind of your own and tell the editor what it offers. Add `problems` so a graph that
names something missing is refused before it runs.

```js
defineBlock({
  role: "action", kind: "set_lamp", title: "Set lamp",
  fields: [{ name: "lamp", kind: "lamp", required: true }],
  run({ ctx, options }) { ctx.lamps[options.lamp].on(); return "out"; },
  problems: ({ options, ctx }) => (options.lamp in ctx.lamps ? [] : [`there is no lamp '${options.lamp}'`]),
});

createEditor(element, { choices: { lamp: [{ value: "left", label: "Left lamp" }] }, /* ... */ });
```

### The parts the application must supply

The editor has no Save button, no name field and no list of graphs. Build what the application
needs around these:

| Need | Use |
|---|---|
| Save | `editor.getGraph()` returns the document (plain JSON). Store it; `parse()` it when reading it back. |
| Open another graph | `editor.setGraph(graph)` |
| Start a chain by hand | `engine.fire(graphId, nodeId)`; the editor calls `onRun(nodeId)` for the ▶ on a trigger |
| On / off switch | `engine.activate()`, `engine.deactivate()`. **Always give the person a way to stop.** |
| Show problems | `check(parsed, blocks, ctx).problems`: sentences for the person, show them as they are |
| Show what runs | `onStatus` → `editor.setRunning(ids)`; `onEvent` with `event === "step"` → `editor.step(node)` |
| Read-only view | `createEditor(el, { readOnly: true })` or `editor.setReadOnly(true)` |
| Several graphs | `engine.load([a, b, c])`: each has its own `id`. `load` replaces all loaded graphs. |
| Remove the editor | `editor.destroy()` (do this when a framework unmounts the component) |

### Colours, fonts, words

```js
createEditor(element, {
  theme: "slate",                                   // or "paper" (default), "contrast"
  // theme: { accent: "#2f6fed", fontBody: "Inter, sans-serif",
  //          light: { canvas: "#eef2f7" }, dark: { canvas: "#10151c" } },
  text: { blocks: "Bausteine", removeBlock: "Baustein entfernen" },   // any entry of TEXT in noodlegraph.js
  categories: { motion: { title: "Motion", colour: "#b8336a" } },     // a group of the application's own
});
editor.setTheme({ accent: "#00a86b" });
```

Theme names are in `THEME_VARIABLES` in `editors/web/noodlegraph.js`: `accent`, `onAccent`,
`surface`, `canvas`, `ink`, `inkSoft`, `inkFaint`, `line`, `lineStrong`, `action`, `value`,
`logic`, `text`, `danger`, `fontDisplay`, `fontBody`, `fontMono`. Take the application's own
palette for these; do not invent colours. Dark follows the system, or `data-theme="dark"` /
`"light"` on the editor's element or a parent.

### Python instead of JavaScript for running

The editor stays in the browser; the engine runs in a Python process; the application carries
the graph document and events between them (HTTP, WebSocket, whatever it already has).
`runtimes/python/demo/server.py` is a complete small example.

```python
from noodlegraph import STANDARD, Action, BlockOptions, Context, Engine, Port, catalogue, check, parse, registry, ui
from pydantic import Field

class SetLamp(Action):
    kind = "set_lamp"
    title = "Set lamp"
    inputs = (Port("in", "flow"), Port("colour", "colour"))

    class Options(BlockOptions):
        colour: str = Field(default="#ff8800", json_schema_extra=ui("colour"))

    async def run(self, inputs):
        self.ctx.set_lamp(inputs["colour"])       # (r, g, b)
        return "out"

blocks = registry(STANDARD, SetLamp)
engine = Engine(MyContext(), blocks, on_event=..., on_status=...)
# send catalogue(blocks) to the page as the editor's `blocks`
# on save: graph = parse(document); problems = check(graph, blocks, engine.ctx).problems; await engine.load([graph])
# await engine.activate()
```

### Check your work

Do all of these before you say it is done. Say which ones you could not do.

- [ ] The page is opened over `http://`, not `file://` (modules do not load from files).
- [ ] The editor's element has a height. A height of 0 shows nothing.
- [ ] Every block of the application appears in Blocks under the right group.
- [ ] A graph with one of each of the application's blocks has no problems in `check()`.
- [ ] Pressing ▶ on a trigger runs the chain, and each of the application's blocks does its thing.
- [ ] `engine.deactivate()` stops a running chain and `release()` leaves the application safe.
- [ ] A saved graph comes back the same after a reload.
- [ ] A deliberately wrong graph (a missing required setting) shows its problem to the person.
- [ ] The browser console has no errors.

### Do not

- Do not edit files under `editors/` or `runtimes/` to fit the application. Use the options. If
  an option is missing, say so to the person instead of patching the library.
- Do not run a graph that `check()` reports problems for. The engine refuses it anyway.
- Do not build graph documents by hand when the editor can make them. If you must, follow
  `spec/graph.schema.json` and pass the result through `parse()`.
- Do not remove the licence headers or the `LICENSE` file.

## Part 2: Work on Noodlegraph itself

The repository has three layers that share no code. `spec/` is the contract.

```
spec/                    SPEC.md, JSON Schemas, tests/cases.json (graphs with what must happen)
editors/web/             the editor (plain JavaScript and CSS)
runtimes/javascript/     a runtime (plain JavaScript, no dependencies)
runtimes/python/         a runtime (pydantic, PyYAML)
demo/ docs/ examples/    an application, the documentation site, the guide's pages
```

Rules:

1. **A change to how graphs are checked or run goes into `spec/SPEC.md` first**, gets a case in
   `spec/tests/cases.json`, and is then made in **both** runtimes. They must stay the same.
2. **A change to the standard blocks** is made in both runtimes; then regenerate
   `spec/tests/standard-catalogue.json` from the Python runtime
   (`catalogue(registry(STANDARD))`). The JavaScript tests compare against it.
3. **No dependencies and no build step** in `editors/` and `runtimes/javascript/`.
4. **The JavaScript runtime must not touch the page** (`document`, `window`): it also runs in Node.js.
5. **Every word the editor shows** goes through the `TEXT` table in `noodlegraph.js`.
6. **Every style** is under the class `ng` with the prefix `ng-`; colours come from `--ng-*` variables.
7. Text for people is plain: short sentences, no jargon, say what happened and what to do.

Run before you finish, and report the numbers:

```
cd runtimes/javascript && npm test
python -m pytest runtimes/python
ruff check --select F,E,W --ignore E501,E402 runtimes/python
```

For a change to the editor, also open `demo/` in a browser and try it; the tests do not cover
the editor. Say so if you could not.
