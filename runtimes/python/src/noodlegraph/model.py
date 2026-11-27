# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph.model — a graph as data: blocks (nodes) and wires.

A graph file is self-contained: the engine needs nothing but this document and the block
types it names. The editor reads and writes the same document (as JSON), so what is drawn
is what runs.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA = "noodlegraph/1"
ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,47}$"
MAX_NODES = 200


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Node(_Strict):
    """One block on the canvas."""

    id: str = Field(pattern=ID_PATTERN)
    kind: str = Field(description="Block type, e.g. wait.")
    options: dict[str, Any] = Field(default_factory=dict)
    position: tuple[float, float] | None = Field(
        default=None, description="Place on the canvas; the engine ignores it."
    )


class Note(_Strict):
    """A note on the canvas: for people. An editor draws it, the engine ignores it."""

    id: str
    text: str = Field(default="", max_length=4000)
    position: tuple[float, float] | None = None
    size: tuple[float, float] | None = None


class Wire(_Strict):
    """A connection from an output port to an input port."""

    from_node: str
    from_port: str
    to_node: str
    to_port: str


class Graph(_Strict):
    """A graph file (``noodlegraph/1``)."""

    schema_: Literal["noodlegraph/1"] = Field(default="noodlegraph/1", alias="schema")
    id: str = Field(pattern=ID_PATTERN)
    name: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=400)
    enabled: bool = Field(
        default=False, description="Its triggers listen while the engine is active."
    )
    nodes: tuple[Node, ...] = Field(default=(), max_length=MAX_NODES)
    wires: tuple[Wire, ...] = ()
    notes: tuple[Note, ...] = ()

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    @model_validator(mode="after")
    def _unique(self) -> Graph:
        ids = [n.id for n in self.nodes]
        if len(set(ids)) != len(ids):
            raise ValueError("block ids must be unique")
        return self

    def node(self, node_id: str) -> Node | None:
        """The block with this id."""
        return next((n for n in self.nodes if n.id == node_id), None)

    def to_document(self) -> dict[str, Any]:
        """The file content (JSON-compatible)."""
        document = self.model_dump(mode="json", by_alias=True)
        if not document["notes"]:
            del document["notes"]
        return document
