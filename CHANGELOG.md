# Changelog

## 0.4.0 (2026-11-27)

- Variables: named values of a graph. Nine standard blocks (set, change, read) for numbers,
  texts, yes / no and colours.
- Graphs running graphs: "Run graph" and "When run by another graph".
- Notes on the canvas, kept in the graph document (`notes`).
- A documentation site in `docs/`.

## 0.3.0 (2026-11-27)

- Dual licence: AGPL-3.0-or-later, or a commercial licence.
- A flow output may continue in several places: the branches run at the same time and the
  chain goes on being one chain. Spec, both runtimes and the editor.
- Editor: undo and redo, selecting several blocks (Shift-click, Shift-drag), copy, paste and
  duplicate, dots that fit light up while a wire is dragged, keyboard shortcuts.
- A logo.

## 0.2.0 (2026-11-27)

- Three layers: `spec/`, `editors/`, `runtimes/`.
- The specification with JSON Schemas and shared test graphs.
- A JavaScript runtime (browser, Node.js) next to the Python one.
- Text type and text lists, list settings of any type, limits set by the host, evaluating a
  value without a chain, every word of the editor replaceable.

## 0.1.0 (2026-11-27)

- Taken out of stagion.edge as a library of its own: the web editor and the Python engine.
