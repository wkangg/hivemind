"""Trust labels. Every value the interpreter handles is a Tagged value.

Two levels only: TRUSTED and UNTRUSTED. The join (least upper bound) is
"untrusted wins": anything computed from an untrusted value is untrusted.
"""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Tagged:
    value: Any
    trusted: bool
    # Where the value came from. For an untrusted value this is only where the
    # taint came from (e.g. {"email:inv_42"}), so the user sees the real cause.
    sources: frozenset[str]

    def describe(self) -> str:
        level = "TRUSTED" if self.trusted else "UNTRUSTED"
        return f"{level} (from {', '.join(sorted(self.sources))})"


def trusted(value: Any, source: str) -> Tagged:
    return Tagged(value, True, frozenset([source]))


def untrusted(value: Any, source: str) -> Tagged:
    return Tagged(value, False, frozenset([source]))


def join(value: Any, parents: list[Tagged], tool_trusted: bool, tool_source: str) -> Tagged:
    """Label a tool's output: l(out) = l(tool) ⊔ l(arg_1) ⊔ ... ⊔ l(arg_n)."""
    is_trusted = tool_trusted and all(p.trusted for p in parents)
    if is_trusted:
        sources = {tool_source}.union(*(p.sources for p in parents))
    else:
        # Keep only the sources that made it untrusted.
        sources = set().union(*(p.sources for p in parents if not p.trusted))
        if not tool_trusted:
            sources.add(tool_source)
    return Tagged(value, is_trusted, frozenset(sources))
