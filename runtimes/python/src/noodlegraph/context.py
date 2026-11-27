# SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
# SPDX-FileCopyrightText: 2026 Eagle Creative
"""noodlegraph.context — what blocks may use of the host application.

Every block gets the same :class:`Context`. The base class only knows about time; the host
subclasses it and adds what its own blocks need (a lamp to switch, a robot to move, a
message bus). Keeping time behind the context lets tests run a graph with a fake clock.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime


class Context:
    """The host as blocks see it. Subclass it and add your own methods and attributes."""

    def clock(self) -> float:
        """Seconds that only go forward (for cooldowns and the pace of loops)."""
        return time.monotonic()

    def now(self) -> datetime:
        """The time of day (for triggers that fire at a time)."""
        return datetime.now()

    async def sleep(self, seconds: float) -> None:
        """Wait; a block must wait through this, never ``time.sleep``."""
        await asyncio.sleep(max(seconds, 0.0))

    async def release(self) -> None:
        """Let go of everything the graphs held: called when the engine is deactivated.

        Override it to return to a safe state (lights off, motors stopped), so nothing a
        cancelled chain left half done stays that way.
        """
