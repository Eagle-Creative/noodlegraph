# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph.forms — describe a block's settings as fields for the editor.

The editor builds a block's settings form from these descriptions, so a new block type
shows up in the editor without JavaScript changes.
"""

from __future__ import annotations

import types
from typing import Annotated, Any, Literal, Union, get_args, get_origin

from annotated_types import Ge, Gt, Le, Lt, MaxLen
from pydantic import BaseModel


def _flatten(items: list[Any]) -> list[Any]:
    out: list[Any] = []
    for item in items:
        out.extend(_flatten(item) if isinstance(item, list) else [item])
    return out


def _unwrap(annotation: object, metadata: list[Any]) -> tuple[object, bool, list[Any]]:
    """Strip ``X | None`` and ``Annotated[X, ...]``: (base type, optional, constraints)."""
    optional = False
    if get_origin(annotation) in (Union, types.UnionType):
        args = [a for a in get_args(annotation) if a is not type(None)]
        optional = len(args) < len(get_args(annotation))
        annotation = args[0]
    constraints = list(metadata)
    if get_origin(annotation) is Annotated:
        annotation, *extra = get_args(annotation)
        for e in extra:  # constraints, or FieldInfo objects carrying them
            constraints.append(e)
            constraints.extend(getattr(e, "metadata", []))
    return annotation, optional, _flatten(constraints)


def _kind(annotation: object) -> dict[str, Any]:
    if get_origin(annotation) is Literal:
        return {"kind": "select", "options": list(get_args(annotation))}
    kinds: dict[object, str] = {bool: "bool", int: "int", float: "float"}
    return {"kind": kinds.get(annotation, "text")}


def field_specs(model: type[BaseModel]) -> list[dict[str, Any]]:
    """Describe the editable fields of *model* for a generated form.

    Each entry has ``name``, ``label`` and ``kind`` (int, float, bool, select, text), plus
    ``default``, ``required``, ``min``, ``max`` (included), ``above``, ``below`` (not
    included), ``max_length``, ``options``, ``optional`` and ``help``
    where they apply. :func:`noodlegraph.graph.catalogue` then applies what a field says
    about itself in ``json_schema_extra`` (``ui``, ``labels``).
    """
    specs: list[dict[str, Any]] = []
    for name, info in model.model_fields.items():
        annotation, optional, constraints = _unwrap(info.annotation, info.metadata)
        spec: dict[str, Any] = {
            "name": name,
            "label": name.replace("_", " ").capitalize(),
            **_kind(annotation),
        }
        for c in constraints:
            if isinstance(c, Ge):
                spec["min"] = c.ge
            elif isinstance(c, Le):
                spec["max"] = c.le
            elif isinstance(c, Gt):
                spec["above"] = c.gt
            elif isinstance(c, Lt):
                spec["below"] = c.lt
            elif isinstance(c, MaxLen) and annotation is str:
                spec["max_length"] = c.max_length
        if info.is_required():
            spec["required"] = True
        else:
            spec["default"] = info.default
        if optional:
            spec["optional"] = True
        if info.description:
            spec["help"] = info.description
        specs.append(spec)
    return specs
