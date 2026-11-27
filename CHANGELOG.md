# Changelog

## 0.5.0 (2026-11-27)

- Themes: the editor's `theme` option and `setTheme()`, with three that come with it (`paper`,
  `slate`, `contrast`) and your own colours and fonts by name. A switch on the documentation
  site to try them.
- No GitHub Pages workflow any more. The documentation and the demo are plain files: copy the
  folder to any web server (`index.html` at the top leads to `docs/`).
- The tests workflow: Node 22 and 24, current actions, and a guide page without a script no
  longer fails it.
- The Python demo's start scripts make `.venv` in the project folder and install there, instead
  of installing into the system's Python.
- `AGENTS.md`: instructions for coding agents that put Noodlegraph into an application, and a
  prompt to hand them in the README.

## 0.4.0 (2026-11-27)

- Variables: named values of a graph. Nine standard blocks (set, change, read) for numbers,
  texts, yes / no and colours.
- Graphs running graphs: "Run graph" and "When run by another graph".
- Notes on the canvas, kept in the graph document (`notes`).
- A documentation site in `docs/`.
- A step-by-step guide with a film for each step (`docs/GUIDE.md`) and its pages
  (`examples/first-app/`).
- The editor moves the view when a block added from a dot would land outside it.
- The repository: tests and a website workflow for GitHub, issue and pull request templates,
  `start.sh` and `start.bat` at the top, screenshots.

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
