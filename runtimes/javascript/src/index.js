// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/*
 * noodlegraph runtime for JavaScript: check a graph and run it, in a browser page, in
 * Node.js or anywhere else JavaScript runs. No dependencies, no build step, nothing of a page.
 *
 *   import { Engine, STANDARD, defineBlock, registry, parse, catalogue } from "./index.js";
 */
export { FLOW_IN, FLOW_OUT, LIST_OF, LOOP_DONE, LOOP_EACH, LOOP_OUTPUTS, MAX_LIST, catalogue, coerce, defineBlock, fits, hueColour, parseColour, readOptions, registerType, registry } from "./blocks.js";
export { Cancelled, Context, Engine, GraphError, LIMITS } from "./engine.js";
export { Compiled, GraphFileError, MAX_NODES, SCHEMA, check, dump, parse, upgrade } from "./graph.js";
export { STANDARD, nth } from "./standard.js";

export const VERSION = "0.4.0";
