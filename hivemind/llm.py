"""One place that calls the model: a headless `claude -p` session.

Uses the Claude Code login already on this machine, so no API key. Each call is
locked down so it is just a model call:
  --tools ""                no tools (correctness rule 2 for the Q-LLM)
  --setting-sources ""      no user/project settings, so no hooks
  --strict-mcp-config       no MCP servers
  --system-prompt           our prompt replaces Claude Code's
  --no-session-persistence  nothing saved between calls
  empty temp cwd            no CLAUDE.md, no project memory
So nothing from one call (an injected email) can resurface in another (the
planner), which keeps correctness rule 1.

Env: HIVEMIND_MODEL (default "haiku"; use "opus" for the final demo).
"""

import json
import os
import shutil
import subprocess
import tempfile

MODEL = os.environ.get("HIVEMIND_MODEL", "haiku")
TIMEOUT_S = 120


class LLMError(Exception):
    """The model call failed. Never put model input or output in the message."""


def complete_json(content: str, system: str, schema: dict) -> dict:
    """One stateless call whose reply is validated against a JSON Schema."""
    exe = shutil.which("claude")
    if not exe:
        raise LLMError("claude CLI not found (install Claude Code and log in)")
    cmd = [
        exe, "-p", "--model", MODEL, "--output-format", "json",
        "--tools", "", "--setting-sources", "", "--strict-mcp-config",
        "--no-session-persistence",
        "--system-prompt", system, "--json-schema", json.dumps(schema),
    ]
    with tempfile.TemporaryDirectory() as cwd:
        try:
            proc = subprocess.run(cmd, input=content, capture_output=True, text=True,
                                  encoding="utf-8", cwd=cwd, timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired:
            raise LLMError("model call timed out") from None
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise LLMError(f"claude exited {proc.returncode} without a JSON result") from None
    out = result.get("structured_output")
    if result.get("is_error") or not isinstance(out, dict):
        raise LLMError("model call failed or returned no structured output")
    return out
