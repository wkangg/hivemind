"""Privileged LLM (P-LLM): turns the user's request into a plan.

It sees only the user's query and the tool signatures, never data: no tool
outputs, no error messages, no printed results (correctness rule 1). So every
constant it writes into the plan comes from the user and is TRUSTED.
No retries: if the plan is bad, the run stops.
"""

from . import llm
from .qllm import SCHEMAS
from .tools import Tool

SYSTEM = """You write plans for a payment assistant. You never see any data, only the user's request.

A plan is a straight list of tool calls, run in order. No branches, no loops.
Each step: {{"tool": <name>, "args": {{<name>: <value>}}, "out": <variable name, optional>}}.
An arg value is either a constant (string or number) or a reference to an earlier step's output:
"$name" for the whole value, "$name.field" for one field.

Tools:
{tools}

Schemas for qllm:
{schemas}

Rules:
- Data from emails or documents can only be read through qllm, which extracts schema fields.
- Write a constant only when the user's request states that value, such as a payee name.
- Take a value from a document only when the user's request does not state it.
- End with at most one pay step.

Example. Request: "Pay Enbridge Gas $50"
{{"steps": [
  {{"tool": "lookup_payee", "args": {{"name": "Enbridge Gas"}}, "out": "payee"}},
  {{"tool": "pay", "args": {{"payee": "$payee", "amount": 50}}}}
]}}"""

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string"},
                    "args": {"type": "object",
                             "additionalProperties": {"type": ["string", "number"]}},
                    "out": {"type": "string"},
                },
                "required": ["tool", "args"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["steps"],
    "additionalProperties": False,
}


def describe_schemas() -> str:
    lines = []
    for name, model in SCHEMAS.items():
        fields = ", ".join(f"{f}: {info.description}" for f, info in model.model_fields.items())
        lines.append(f"- {name} {{{fields}}}")
    return "\n".join(lines)


def plan(query: str, tools: dict[str, Tool]) -> list[dict]:
    system = SYSTEM.format(
        tools="\n".join(f"- {t.doc}" for t in tools.values()),
        schemas=describe_schemas(),
    )
    out = llm.complete_json(f"Request: {query}", system, PLAN_SCHEMA)
    return out["steps"]
