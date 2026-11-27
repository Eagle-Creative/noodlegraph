# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph.store — graph files in a folder, one ``<id>.yaml`` each.

One file per graph, ``<id>.yaml``. A file that cannot be read is listed with its error
and never run; it is not deleted.
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

import yaml
from pydantic import ValidationError

from noodlegraph.model import Graph

MAX_FILE_BYTES = 512 * 1024


class GraphFileError(ValueError):
    """A graph document that cannot be used."""


def parse(document: object) -> Graph:
    """A graph from a parsed document; raises :class:`GraphFileError`."""
    if not isinstance(document, dict):
        raise GraphFileError("a graph file must be a mapping")
    try:
        return Graph.model_validate(document)
    except ValidationError as exc:
        lines = [f"{'.'.join(str(x) for x in e['loc'])}: {e['msg']}" for e in exc.errors()]
        raise GraphFileError("; ".join(lines)) from None


def parse_text(text: str) -> Graph:
    """A graph from YAML (or JSON) text."""
    if len(text.encode()) > MAX_FILE_BYTES:
        raise GraphFileError("file too large")
    try:
        return parse(yaml.safe_load(text))
    except yaml.YAMLError as exc:
        raise GraphFileError(f"not valid YAML: {exc}") from None


def dump(graph: Graph) -> str:
    """The file text of a graph."""
    return yaml.safe_dump(graph.to_document(), sort_keys=False, allow_unicode=True)


class GraphStore:
    """The graph files in one folder."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder

    def _path(self, graph_id: str) -> Path:
        return self.folder / f"{graph_id}.yaml"

    def load(self) -> tuple[list[Graph], dict[str, str]]:
        """Every readable graph, and ``{file name: error}`` for the others."""
        graphs: list[Graph] = []
        errors: dict[str, str] = {}
        if not self.folder.is_dir():
            return graphs, errors
        for path in sorted(self.folder.glob("*.yaml")):
            try:
                graph = parse_text(path.read_text(encoding="utf-8"))
                if graph.id != path.stem:
                    raise GraphFileError(f"id {graph.id!r} does not match the file name")
                graphs.append(graph)
            except (OSError, GraphFileError) as exc:
                errors[path.name] = str(exc)
        return graphs, errors

    def save(self, graph: Graph) -> None:
        """Write a graph (all or nothing)."""
        self.folder.mkdir(parents=True, exist_ok=True)
        target = self._path(graph.id)
        tmp = target.with_suffix(".yaml.tmp")
        tmp.write_text(dump(graph), encoding="utf-8")
        os.replace(tmp, target)

    def delete(self, graph_id: str) -> bool:
        """Remove a graph file; false if there was none."""
        with contextlib.suppress(FileNotFoundError):
            self._path(graph_id).unlink()
            return True
        return False
