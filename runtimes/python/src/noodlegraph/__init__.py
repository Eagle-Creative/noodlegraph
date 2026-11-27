# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph — behaviour built from blocks: check a graph and run it.

The editor (``js/noodlegraph.js``) draws a graph: blocks and the wires ("noodles") between
them. This package is the other half: it describes the block types to the editor
(:func:`catalogue`), checks a graph (:func:`check`) and runs it (:class:`Engine`), each
chain as its own asyncio task.
"""

from noodlegraph.blocks import (
    Action,
    Block,
    BlockOptions,
    Loop,
    Port,
    Trigger,
    TriggerEvent,
    TriggerOptions,
    Value,
    ValueBlock,
    coerce,
    fits,
    hue_colour,
    parse_colour,
    register_type,
)
from noodlegraph.context import Context
from noodlegraph.engine import Engine, GraphError, Limits
from noodlegraph.graph import Compiled, catalogue, check, discover_blocks, registry, upgrade
from noodlegraph.model import SCHEMA, Graph, Node, Wire
from noodlegraph.standard import STANDARD, TaskTrigger, nth, ui
from noodlegraph.store import GraphFileError, GraphStore, dump, parse, parse_text

__version__ = "0.4.0"

__all__ = [
    "SCHEMA",
    "STANDARD",
    "Action",
    "Block",
    "BlockOptions",
    "Compiled",
    "Context",
    "Engine",
    "Graph",
    "GraphError",
    "GraphFileError",
    "GraphStore",
    "Limits",
    "Loop",
    "Node",
    "Port",
    "TaskTrigger",
    "Trigger",
    "TriggerEvent",
    "TriggerOptions",
    "Value",
    "ValueBlock",
    "Wire",
    "catalogue",
    "check",
    "coerce",
    "discover_blocks",
    "dump",
    "fits",
    "hue_colour",
    "nth",
    "parse",
    "parse_colour",
    "parse_text",
    "register_type",
    "registry",
    "ui",
    "upgrade",
]
