"""Runs a plan: a straight list of tool calls, no branches or loops.

A plan is JSON like:
    [{"tool": "read_latest_email", "args": {}, "out": "email"},
     {"tool": "lookup_payee", "args": {"name": "Toronto Hydro"}, "out": "payee"},
     {"tool": "pay", "args": {"payee": "$payee", "amount": "$inv.amount"}}]

Arguments are either references ("$var", "$var.field", a field keeps its
parent's label) or constants. Constants were written by the planner, which only
saw the user's query, so they are TRUSTED with source "plan".
"""

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from . import policy
from .labels import Tagged, join, trusted
from .tools import Tool, ToolError

REF = re.compile(r"^\$([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)$")
SCALARS = (str, int, float, bool, type(None))

# confirm(violations, payee, amount) -> True to pay anyway.
Confirm = Callable[[list[policy.Violation], Tagged, Tagged], bool]


class PlanError(Exception):
    """The plan is malformed or failed. Messages never contain untrusted values."""


def deny(violations, payee, amount) -> bool:
    return False


def ask_terminal(violations, payee, amount) -> bool:
    print("\n  Payment needs your approval:")
    print(f"    pay {payee.value!r}  amount {amount.value!r}")
    for v in violations:
        print(f"    [{v.rule}] {v.message}")
    return input("  Pay anyway? [y/N] ").strip().lower() == "y"


@dataclass
class Result:
    status: str  # "ok", "blocked" or "error"
    env: dict[str, Tagged] = field(default_factory=dict)
    violations: list[policy.Violation] = field(default_factory=list)
    error: str = ""


def validate(plan: Any, tools: dict[str, Tool]) -> None:
    """Reject anything that isn't a flat list of known tool calls (rule 4)."""
    if not isinstance(plan, list):
        raise PlanError("plan must be a list of steps")
    for i, step in enumerate(plan):
        if not isinstance(step, dict) or "tool" not in step:
            raise PlanError(f"step {i}: must be an object with a 'tool'")
        extra = set(step) - {"tool", "args", "out"}
        if extra:
            raise PlanError(f"step {i}: unknown keys {sorted(extra)}")
        if step["tool"] not in tools:
            raise PlanError(f"step {i}: unknown tool {step['tool']!r}")
        args = step.get("args", {})
        if not isinstance(args, dict) or not all(isinstance(v, SCALARS) for v in args.values()):
            raise PlanError(f"step {i}: args must be an object of plain values")
        out = step.get("out")
        if out is not None and not (isinstance(out, str) and re.fullmatch(r"[A-Za-z_]\w*", out)):
            raise PlanError(f"step {i}: bad 'out' name")


def resolve(arg: Any, env: dict[str, Tagged], step: int) -> Tagged:
    if isinstance(arg, str) and arg.startswith("$"):
        m = REF.match(arg)
        if not m:
            raise PlanError(f"step {step}: bad reference {arg!r}")
        name, path = m.group(1), m.group(2)
        if name not in env:
            raise PlanError(f"step {step}: {name!r} is not defined yet")
        parent = env[name]
        value = parent.value
        for key in filter(None, path.split(".")):
            if isinstance(value, dict) and key in value:
                value = value[key]
            elif hasattr(value, key):
                value = getattr(value, key)
            else:
                raise PlanError(f"step {step}: {name!r} has no field {key!r}")
        return Tagged(value, parent.trusted, parent.sources)  # field keeps parent's label
    return trusted(arg, "plan")


def run(plan: Any, tools: dict[str, Tool], cap: float, confirm: Confirm = deny) -> Result:
    try:
        validate(plan, tools)
    except PlanError as e:
        return Result("error", error=str(e))

    env: dict[str, Tagged] = {}
    for i, step in enumerate(plan):
        tool = tools[step["tool"]]
        try:
            args = {k: resolve(v, env, i) for k, v in step.get("args", {}).items()}
        except PlanError as e:
            return Result("error", env, error=str(e))

        if tool.name == "pay":
            if set(args) != {"payee", "amount"}:
                return Result("error", env, error=f"step {i}: pay needs exactly payee and amount")
            violations = policy.check_pay(args["payee"], args["amount"], cap)
            if violations and not confirm(violations, args["payee"], args["amount"]):
                return Result("blocked", env, violations)
        elif tool.side_effect:
            return Result("error", env, error=f"step {i}: {tool.name} has no policy")

        try:
            value = tool.fn(**{k: a.value for k, a in args.items()})
        except ToolError as e:
            return Result("error", env, error=f"step {i}: {e}")
        except Exception as e:  # don't echo arbitrary messages, they may hold untrusted data
            return Result("error", env, error=f"step {i}: {tool.name} failed ({type(e).__name__})")

        out = join(value, list(args.values()), tool.trusted, tool.source(value))
        if step.get("out"):
            env[step["out"]] = out
    return Result("ok", env)
