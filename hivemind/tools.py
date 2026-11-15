"""Mock tools, the payee book, and the fake ledger.

Each tool declares its trust level here, in the registry. This file and
labels.join are the only places a label is ever chosen (correctness rule 3).
Tools take and return plain values; the interpreter does the labelling.
"""

from dataclasses import dataclass, field
from typing import Any, Callable

from .emails import EMAILS

# Trusted: set up by the user, not by anything they received.
PAYEE_BOOK = {
    "Toronto Hydro": {"name": "Toronto Hydro", "account": "ACCT-1001"},
    "Enbridge Gas": {"name": "Enbridge Gas", "account": "ACCT-2002"},
}


class ToolError(Exception):
    """A tool failed. Messages must never include untrusted values."""


@dataclass
class World:
    """Everything the tools act on, so each run starts clean."""

    email: dict = field(default_factory=lambda: EMAILS["benign"])
    payees: dict = field(default_factory=lambda: dict(PAYEE_BOOK))
    ledger: list = field(default_factory=list)


@dataclass(frozen=True)
class Tool:
    name: str
    fn: Callable[..., Any]
    trusted: bool
    # Label source for the output, e.g. "payee_book" or "email:inv_42".
    source: Callable[[Any], str]
    side_effect: bool = False
    doc: str = ""


def payee_account(payee: Any) -> str:
    """pay() accepts a payee-book record or a bare account string."""
    if isinstance(payee, dict) and "account" in payee:
        return str(payee["account"])
    return str(payee)


def make_tools(world: World, qllm: Callable[[Any, str], dict] | None = None) -> dict[str, Tool]:
    def read_latest_email() -> dict:
        return dict(world.email)

    def lookup_payee(name: str) -> dict:
        if name not in world.payees:
            raise ToolError("lookup_payee: name is not in the payee book")
        return dict(world.payees[name])

    def pay(payee: Any, amount: Any) -> dict:
        entry = {"to": payee_account(payee), "amount": round(float(amount), 2)}
        if isinstance(payee, dict) and "name" in payee:
            entry["name"] = payee["name"]
        world.ledger.append(entry)
        return entry

    tools = [
        Tool("read_latest_email", read_latest_email, trusted=False,
             source=lambda out: f"email:{out.get('id', '?')}",
             doc="read_latest_email() -> Email{id, sender, subject, body}"),
        Tool("lookup_payee", lookup_payee, trusted=True,
             source=lambda out: "payee_book",
             doc="lookup_payee(name: str) -> Payee{name, account}, from the user's saved payee book"),
        Tool("pay", pay, trusted=True, side_effect=True,
             source=lambda out: "ledger",
             doc="pay(payee: Payee, amount: float) -> receipt. Guarded by the payment policy."),
    ]
    if qllm is not None:
        # The Q-LLM reads untrusted data and has no tools. Its output is always untrusted.
        tools.append(Tool("qllm", qllm, trusted=False,
                          source=lambda out: "qllm",
                          doc="qllm(data, schema: str) -> fields of schema extracted from data"))
    return {t.name: t for t in tools}
