# The noodlegraph specification (noodlegraph/1)

This document is the contract between everything in noodlegraph. An editor on any platform
writes the graph document described here; a runtime in any language checks and runs it as
described here. A graph drawn in any editor runs the same way on any runtime.

Three things are specified:

1. **The graph document**: what an editor saves ([graph.schema.json](graph.schema.json)).
2. **The block catalogue**: how block types are described to an editor
   ([catalogue.schema.json](catalogue.schema.json)).
3. **Checking and running**: what a runtime does with a graph.

A new editor or runtime is correct when it passes the [test graphs](#test-graphs).

## 1. The graph document

A graph is blocks (**nodes**) and the **wires** between them, as JSON.

```json
{
  "schema": "noodlegraph/1",
  "id": "greet",
  "name": "Greet the audience",
  "description": "",
  "enabled": true,
  "nodes": [
    { "id": "go", "kind": "manual", "options": {}, "position": [20, 40] },
    { "id": "wait", "kind": "wait", "options": { "seconds": 0.4 }, "position": [280, 40] }
  ],
  "wires": [
    { "from_node": "go", "from_port": "out", "to_node": "wait", "to_port": "in" }
  ]
}
```

| Key | Meaning |
|---|---|
| `schema` | `"noodlegraph/1"`. May be left out. |
| `id` | Small letters, digits, `_` and `-`; starts with a letter or digit; at most 48 characters. |
| `name`, `description` | For people. At most 80 and 400 characters. |
| `enabled` | Whether its triggers listen while the engine is active. Default false. |
| `nodes` | At most 200. Each has an `id` (unique in the graph, same form as the graph id), a `kind` (the block type), `options` (only the settings that differ from the block's defaults) and a `position` `[x, y]` that only the editor uses. |
| `wires` | Each goes from an output port (`from_node`, `from_port`) to an input port (`to_node`, `to_port`). |
| `notes` | Words on the canvas, for people: each has an `id`, a `text`, a `position` and a `size` `[width, height]`. An editor draws them; a runtime keeps them in the document and otherwise ignores them. May be left out. |

Unknown keys are an error. A runtime may also read the same document as YAML.

## 2. Blocks

### Roles

Every block type has one of four roles. The role decides how it runs.

| Role | Ports it has by default | What it does |
|---|---|---|
| **trigger** | flow output `out` ("then") | Watches one thing and *emits* when it happens. It may emit values for its value outputs. It never runs anything itself. |
| **action** | flow input `in`, flow output `out` ("then") | One bounded step of a chain. When done it names the flow output to continue on. |
| **loop** | flow input `in`, flow outputs `each` ("each round") and `done` | Runs the chain on `each` again and again, then continues on `done`. |
| **value** | none | Computes its outputs from its inputs. No flow ports, no side effects. |

A block's **category** is only the group an editor lists it under (`trigger`, `action`,
`logic`, `value`, or a host's own). It defaults to the role (a loop: `logic`) and does not
change how the block runs: If is an action listed under `logic`.

### Ports and types

A port has a `name`, a `type` and a `label`.

| Type | Carries | In JSON and inside a runtime |
|---|---|---|
| `flow` | The order of steps. Not a value. | |
| `number` | A number | a number; true and false count as 1 and 0 |
| `bool` | Yes or no | true / false |
| `text` | A text | a string |
| `colour` | A colour | settings: `"#rrggbb"`; on wires and for blocks: `[r, g, b]`, each 0 to 255 |
| `numbers`, `texts`, `colours` | A list of those | an array, at least one item |

A host may add value types of its own (and list types of them).

### Settings and the block catalogue

A block's settings are **fields**. The catalogue describes each block type to the editor:

```json
{
  "kind": "wait",
  "title": "Wait",
  "category": "action",
  "help": "Pauses the chain.",
  "inputs":  [{ "name": "in", "type": "flow", "label": "in" },
              { "name": "seconds", "type": "number", "label": "seconds" }],
  "outputs": [{ "name": "out", "type": "flow", "label": "then" }],
  "fields":  [{ "name": "seconds", "label": "Seconds", "kind": "float", "min": 0, "max": 3600, "default": 1.0 }]
}
```

| Field kind | Value | Extra keys |
|---|---|---|
| `int`, `float` | number | `min`, `max` (included), `above`, `below` (not included) |
| `bool` | true / false | |
| `text` | string | `max_length` |
| `select` | one of `options` | `options`, `labels` (what to show for a value) |
| `colour` | `"#rrggbb"` | |
| `time` | `"HH:MM"` | |
| `numbers`, `texts`, `colours` | array | `min_items`, `max_items` (at most 64) |
| a host's own kind | string | The host tells the editor what to offer. |

Every field has a `default` or is `required`. A field's `label` defaults to its name with
`_` as spaces and a capital first letter; a name ending in `_s` reads "... (s)".

**A value input has the name of a field.** While a wire is connected to it, the wire's value
is used; otherwise the field's value. An input with `replaces` is different: it stands in
for another field while it is wired, and is not read at all while it is not.

Every trigger has two fields before its own:

| Field | Default | Meaning |
|---|---|---|
| `cooldown_s` | 0 | After it started a chain, it does not start another for this long. |
| `when_running` | `ignore` | If its chain is still running when it emits again: `ignore` the new one, or `restart` (cancel the running chain and start anew). |

## 3. Checking

A graph may run only if a check finds no problem. Problems are sentences for the user. A
runtime reports all of them, not only the first. In order:

1. **Blocks.** Every node's `kind` is a known block type
   (`<node>: unknown block type '<kind>'`). Its options are known fields with valid values;
   required fields are there (`<node> (<title>): <field>: <why>`). The host may add problems
   of its own (a setting names something the host does not have).
2. **Wires**, each named `wire <from_node>.<from_port> -> <to_node>.<to_port>`:
   - both nodes exist (`: a block is missing`) and both ports exist (`: no such port`);
   - the types fit: they are equal, or the input is a list and the output is its item type
     (`: <out type> cannot feed <in type>`);
   - a value input takes one wire (`: this input already has a wire`). An output may have
     any number of wires: a value output feeds several settings, a flow output continues in
     several places (see [Branches](#branches)).
3. **Unchosen settings.** An input with `replaces` is not wired and the field it replaces
   is empty.
4. **Circles.** Following wires from output to input, and inside a block from each input
   to each output that depends on it, never leads back to where it started
   (`the wires form a circle; ...`). An output depends on every input of its block unless
   the block type says it depends on fewer (a list's `count` does not depend on its `no.`).

## 4. Running

### The engine

- An engine is **active** or not. Graphs run only while it is active.
- **Activating** starts the triggers of every graph that is `enabled` and has no problems.
- **Deactivating** cancels every running chain, stops every trigger and then tells the host
  to let go of everything (`release`). Nothing resumes by itself.
- **Loading** graphs replaces the loaded ones: as deactivating, then, if the engine is
  active, as activating.

### Chains

A **chain** is the steps that follow one trigger. It starts when the trigger emits and

- the engine is active;
- the trigger's cooldown has passed since it last started a chain;
- its chain is not running, or `when_running` is `restart`.

Started by hand (an editor's ▶), cooldown and `when_running` are skipped: a running chain
of that trigger is cancelled and a new one starts.

Running a chain:

1. Start at the node wired to the trigger's `out`. With no wire the chain ends at once.
2. At an **action**: read its value inputs (see below), run it, continue at the node wired
   to the flow output it names. With no wire there the branch ends.
3. At a **loop**: read its inputs. Then, as long as the loop says "again": set its value
   outputs for this round, run the chain wired to `each` to its end, and wait so that the
   round took at least `min_round`. A loop that is not `fixed` reads its inputs again before
   every round; a `fixed` one keeps those of its start. Afterwards continue at `done`. A
   loop's value outputs exist only during its rounds.
4. Every chain runs on its own: chains of different triggers, and of different graphs, do
   not wait for each other. One trigger has at most one chain at a time.

#### Branches

A flow output with several wires continues at all of them **at the same time**. Each is a
branch of the same chain:

- the chain (or the round of a loop the branches are in) goes on, or ends, when every
  branch reached its end;
- a branch that fails ends the whole chain as `failed` and stops the other branches;
- cancelling the chain cancels every branch;
- the order in which branches take their steps is not defined: a graph must not rely on it;
- branches do not join. A block that two branches lead to runs once for each of them;
- the step limit counts per branch.

A chain ends as `finished`, `failed` (a block failed, a limit was reached; with a message)
or `cancelled`. A failing block ends only its own chain.

### Values

The value of an input is found when the block that needs it runs, never earlier:

- not wired: the field of the same name, brought into the port's type;
- wired from a **value** block: that block's inputs are found first (only those the asked
  output depends on), then it computes;
- wired from a **trigger**: the value it emitted, only inside the chain it started;
- wired from a **loop**: the value of the current round, only inside its rounds.

A value block is computed again each time it is asked: Random gives a new number every time.

A runtime can also **evaluate** an output of a value block without any chain, for graphs
that only calculate. Trigger and loop values cannot be asked for that way.

### Variables

A variable is a named value that belongs to one graph. Blocks with a setting of the kind
`variable` name one; blocks that give the same name share it.

- Every chain of the graph, and every branch, reads and writes the same variables.
- Variables are empty when the engine is activated and keep what was stored until it is
  deactivated. Loading graphs keeps nothing.
- A variable nothing was stored in reads as 0, no, an empty text or black, by the block
  that reads it.
- A variable holds whatever was stored last. Reading it as another type fails the chain
  the way a wrong wire value would.
- Graphs do not see each other's variables.

### Graphs running graphs

The action `call` ("Run graph") runs another loaded graph as a step of its chain:

1. The other graph must be loaded, have no problems and have exactly one `called` block
   ("When run by another graph"). Otherwise the calling chain fails. It need not be
   `enabled`.
2. The steps after that `called` block run to their end, as part of the calling chain:
   cancelled with it, counted in its time, reported as `step` events of the graph they are in.
3. The steps use the variables of the graph they are in, not the caller's.
4. Then the calling chain continues after the `call` block.

Nothing is passed in or out. A graph may run itself or run graphs that run it; more than
`max_call_depth` deep fails the chain.

### Limits

A host may change them. The defaults:

| Limit | Default |
|---|---|
| Longest a chain without a loop may run | 3600 s |
| Steps of one branch of a chain, or of one round | 10 000 |
| Shortest round of a loop (`min_round`) | 0.02 s |
| Loops inside loops | 8 |
| Value blocks feeding value blocks | 64 |
| Graphs running graphs (`max_call_depth`) | 16 |

A graph with a loop may run as long as the engine is active.

### What a runtime reports

**Events**, per graph: `{ "event", "trigger", "node", "message" }`.

| `event` | When | `node` |
|---|---|---|
| `started` | A chain starts. | the trigger |
| `step` | The chain reaches an action or loop (a running loop repeats it now and then). | that block |
| `finished`, `failed`, `cancelled` | The chain ended. | the trigger |

**Status**, whenever it changes:

```json
{ "active": true,
  "graphs": { "greet": {
    "name": "Greet the audience", "enabled": true, "valid": true, "problems": [],
    "listening": ["go"], "running": ["go"],
    "last": { "trigger": "go", "result": "finished", "message": "", "ts": 1795000000.0 } } } }
```

`listening` and `running` are ids of trigger nodes. `ts` is seconds since 1970.

## 5. Standard blocks

Every runtime has these 28, described exactly as in
[tests/standard-catalogue.json](tests/standard-catalogue.json).

| Kind | Title | Role | Behaviour |
|---|---|---|---|
| `manual` | Run button | trigger | Never emits by itself; started by hand. |
| `start` | When started | trigger | Emits once, `delay_s` after its trigger was started. |
| `interval` | Every interval | trigger | Emits every `every_s`; the first time at once if `first_now`. |
| `time_of_day` | At a time of day | trigger | Emits daily at `time` by the host's clock. |
| `called` | When run by another graph | trigger | Never emits by itself: where `call` enters the graph. |
| `wait` | Wait | action | Waits `seconds` (0 to 3600). |
| `call` | Run graph | action | Runs the graph named in `graph` and waits for it (see above). |
| `set_number`, `set_text`, `set_bool`, `set_colour` | Set number, Set text, Set yes / no, Set colour | action | Stores `value` in the variable `name`. |
| `change_number` | Change number | action | Adds `by` to the number in the variable `name` (0 if nothing was stored). Fails if it holds something else. |
| `branch` | If | action | Continues on `then` if `condition`, else on `else`. |
| `for` | For | loop, fixed | `i` goes from `start` to `end`, both included, by `step` (down if `end` is smaller). |
| `while` | While | loop | Another round while `condition`; `round` counts from 1. |
| `number`, `text` | Number, Text | value | `value`: the setting. |
| `number_list`, `text_list`, `colour_list` | ... list | value | `list`: all items. `count`: how many. `item`: the one at `index`, counted from 1; past the last it starts again at the first. `list` and `count` do not depend on `index`. |
| `map_range` | Map range | value | `value` scaled from `in_min`..`in_max` to `out_min`..`out_max`; kept inside if `clamp`. |
| `compare` | Compare | value | `a` `op` `b`, with `op` one of `>`, `<`, `>=`, `<=`, `=`. |
| `colour_hue` | Colour from hue | value | A fully saturated colour from `hue` (degrees) and `brightness` (0 to 100). |
| `random` | Random | value | A number from `min` to `max`, new each time. |
| `get_number`, `get_text`, `get_bool`, `get_colour` | Number, Text, Yes / no, Colour variable | value | `value`: what the variable `name` holds, or 0, `""`, no, black. |

A number that picks an item is rounded to the nearest whole number first; exactly halfway
goes to the even one.

## 6. Test graphs

[tests/cases.json](tests/cases.json) holds graphs with what must happen. Each case has a
`graph` and one of:

- `problems`: checking must report problems containing each of these texts.
- `fire` and `expect`: the graph has no problems; starting the chain of trigger `fire` by
  hand must end as `expect.result` (with `message`, or a message containing
  `message_contains`), the test blocks must have logged `expect.log` in that order (in any
  order if `expect.log_any_order`), and the `step` events must name `expect.steps` if given.
- `evaluate` (`[node, port]`) and `value`: evaluating that output must give that value.

A case may have `with`: more graphs to load next to its `graph`, for graphs that run graphs.

The cases use five test blocks a runtime's tests define. Each logging block appends the
value of its one input to a log:

| Kind | Title | Input and field | Default |
|---|---|---|---|
| `test_log` | Log | `value`: number | 0 |
| `test_show` | Show | `text`: text | `""` |
| `test_paint` | Paint | `colour`: colour | `"#000000"` |
| `test_paints` | Paints | `colours`: colours | `["#000000"]` |
| `test_fail` | Fail | none | Always fails with the message `it broke`. |

The existing runners are `runtimes/python/tests/test_conformance.py` and
`runtimes/javascript/tests/conformance.test.js`.

## 7. Versions

The format is `noodlegraph/1`. A change that an older editor or runtime could misread gets a
new number. A block type that changes its own settings or port names keeps old graphs
working by upgrading them when they are read.
