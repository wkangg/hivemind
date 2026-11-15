"""hivemind as an MCP server, so Claude Desktop can use it.

    python -m hivemind.mcp_server [--goat]            # safe: one pay_bill tool, our agent inside
    python -m hivemind.mcp_server --unsafe [--goat]   # pay_bill runs the baseline agent instead
    python -m hivemind.mcp_server --raw [--goat]      # raw tools, Claude Desktop itself decides
    python -m hivemind.mcp_server --inbox injected    # choose the inbox email, then exit
    python -m hivemind.mcp_server --show              # open the email window, then exit

Safe mode: Claude Desktop passes the user's request to pay_bill. Our planner,
interpreter and policy run here. Claude never sees the email, only a result built
from labelled values (payee account, amount, where each came from). A blocked
payment waits for approve_payment, which Claude should call only when the user says yes.

Unsafe mode: pay_bill runs the baseline agent (baseline.py) with the same tools and no
policy, so the two servers differ only in the agent behind pay_bill.

Raw mode: Claude Desktop itself gets read_latest_email and pay, with no policy.

All modes share the demo inbox (--inbox), saved in .hivemind-inbox (git-ignored).
--goat pays real test USDC on GOAT Testnet3 (ours: GOAT_PAYER_KEY, unsafe: GOAT_BASELINE_KEY).

The MCP stdio transport is newline-delimited JSON-RPC 2.0 on stdin/stdout, written
by hand so there's no extra dependency. stdout carries only protocol messages; any
other output goes to stderr (Claude Desktop's MCP log).
"""

import html
import json
import os
import sys
import uuid
import webbrowser
from pathlib import Path

from .emails import EMAILS
from .interpreter import run
from .tools import PAYEE_BOOK, ToolError, World, make_tools

CAP = 100.0
GOAT = "--goat" in sys.argv
RAW = "--raw" in sys.argv
UNSAFE = "--unsafe" in sys.argv or RAW
INBOXES = ["benign", "injected", "forged"]
INBOX_FILE = Path(__file__).resolve().parent.parent / ".hivemind-inbox"
PROTOCOL = sys.stdout  # the real stdout; sys.stdout is pointed at stderr below
PENDING: dict[str, dict] = {}  # approval id -> {"steps", "inbox", "rules"}


def log(*parts) -> None:
    print(*parts, file=sys.stderr, flush=True)


def inbox() -> str:
    try:
        key = INBOX_FILE.read_text().strip()
    except OSError:
        key = ""
    return key if key in INBOXES else "benign"


def chain(key_env: str):
    if not GOAT:
        return None
    from . import goat
    goat.PROGRESS = lambda kind, text: log(f"goat {kind}: {text}")
    return goat.payer(key_env)


def receipt(entry: dict) -> str:
    names = {p["account"]: p["name"] for p in PAYEE_BOOK.values()}
    who = entry.get("name") or names.get(entry["to"], "an account not in your payee book")
    line = f"Paid {who} ({entry['to']}) ${entry['amount']:.2f}."
    if "tx" in entry:
        how = (f"GOAT Flow order {entry['order_id'][:8]}, {entry.get('flow_status')}"
               if "order_id" in entry else "plain USDC transfer")
        line += f"\n{entry['usdc']:g} USDC on GOAT Testnet3 ({how}): {entry['explorer']}"
    return line


def label(t) -> str:
    return ("TRUSTED" if t.trusted else "UNTRUSTED") + f" from {', '.join(sorted(t.sources))}"


# --- safe mode: our agent ---

def run_ours(steps: list[dict], key: str, approved_rules: list[str] | None = None) -> str:
    """Runs a plan. Returns text for Claude made only from labelled values, never email text."""
    from .qllm import qllm
    world = World(email=EMAILS[key], chain=chain("GOAT_PAYER_KEY"))
    tools = make_tools(world, qllm=qllm)
    trace: list[str] = []
    seen: dict = {}

    def on_step(event, i, step, data):
        if event == "policy":
            payee, amount, violations = data
            seen.update(payee=payee, amount=amount, violations=violations)
            trace.append(f"policy before pay: payee {label(payee)}; amount {label(amount)}")

    def confirm(violations, payee, amount):
        return approved_rules is not None and sorted(v.rule for v in violations) == approved_rules

    res = run(steps, tools, CAP, confirm=confirm, on_step=on_step)
    plan_text = "\n".join(
        f"{i}. {s['tool']}({', '.join(f'{k}={v!r}' for k, v in s.get('args', {}).items())})"
        for i, s in enumerate(steps, 1))
    out = [f"Plan (written from the request alone, before reading the email):\n{plan_text}", *trace]
    if res.status == "blocked":
        payee, amount = seen["payee"], seen["amount"]
        account = payee.value.get("account") if isinstance(payee.value, dict) else payee.value
        approval = uuid.uuid4().hex[:8]
        rules = sorted(v.rule for v in res.violations)
        PENDING[approval] = {"steps": steps, "inbox": key, "rules": rules}
        out.append(f"BLOCKED, nothing paid. Payment needs the user's approval: pay {account} "
                   f"${float(amount.value):.2f}")
        out += [f"[{v.rule}] {v.message}" for v in res.violations]
        out.append(f"Ask the user. Only if they say yes, call approve_payment with id {approval}.")
    elif res.status == "error":
        out.append(f"STOPPED, nothing paid: {res.error}")
    out += [receipt(e) for e in world.ledger]
    return "\n".join(out)


def pay_bill(request: str) -> str:
    from .planner import plan
    key = inbox()
    tools = make_tools(World(email=EMAILS[key]), qllm=lambda d, s: {})  # docs only, for the planner
    return run_ours(plan(request, tools), key)


def approve_payment(id: str) -> str:
    pending = PENDING.pop(id, None)
    if pending is None:
        raise ToolError("no payment is waiting with that id")
    return run_ours(pending["steps"], pending["inbox"], approved_rules=pending["rules"])


# --- unsafe mode: raw tools, no policy ---

def unsafe_tool(name: str):
    def call(**args) -> str:
        world = World(email=EMAILS[inbox()], chain=chain("GOAT_BASELINE_KEY"))
        tools = make_tools(world)
        result = tools[name].fn(**args)
        return receipt(world.ledger[-1]) if name == "pay" else json.dumps(result, indent=2)
    return call


EMAIL_PAGE = INBOX_FILE.with_name(".hivemind-email.html")

PAGE = """<!doctype html><meta charset="utf-8"><title>Inbox: {subject}</title>
<style>
body {{ font: 16px/1.5 system-ui, sans-serif; background: #e4e4e7; color: #18181b; margin: 0; padding: 32px 16px; }}
.mail {{ max-width: 680px; margin: auto; background: #fff; border-radius: 10px; box-shadow: 0 1px 4px #0002; padding: 24px 28px; }}
.head {{ border-bottom: 1px solid #e4e4e7; padding-bottom: 12px; margin-bottom: 12px; color: #52525b; }}
h1 {{ font-size: 20px; margin: 0 0 6px; color: #18181b; }}
p {{ margin: 0; }}
.hidden {{ color: #fff; font-size: 2px; line-height: 2px; }}  /* white on white: people can't see it, the model reads it */
</style>
<div class="mail" id="mail"><div class="head"><h1>{subject}</h1>From: {sender}</div>{body}</div>
"""


def open_email() -> str:
    """Opens the inbox email in the browser and returns what a person sees: the attacker's lines
    are white on white, as in a real hidden-text attack, so they're left out of both. Only an
    agent that reads the raw email (read_latest_email) gets them."""
    key = inbox()
    email = EMAILS[key]
    normal = set(EMAILS["benign"]["body"].splitlines())
    lines, visible = [], []
    for line in email["body"].splitlines():
        hidden = key != "benign" and line.strip() and line not in normal
        lines.append(f'<p class="{"hidden" if hidden else ""}">{html.escape(line) or "&nbsp;"}</p>')
        if not hidden:
            visible.append(line)
    EMAIL_PAGE.write_text(PAGE.format(
        subject=html.escape(email["subject"]), sender=html.escape(email["sender"]),
        body="".join(lines)), encoding="utf-8")
    try:
        if os.name == "nt":
            os.startfile(EMAIL_PAGE)
        else:
            webbrowser.open(EMAIL_PAGE.as_uri())
    except OSError as e:
        log(f"could not open the email page: {e!r}")
        return f"Couldn't open a window. The email is at {EMAIL_PAGE}"
    text = "\n".join(visible).strip()
    while "\n\n\n" in text:  # close the gaps the hidden lines leave
        text = text.replace("\n\n\n", "\n\n")
    return (f"Opened the latest email in a window for the user. It reads:\n\n"
            f"From: {email['sender']}\nSubject: {email['subject']}\n\n{text}")


def set_inbox(email: str) -> str:
    if email not in INBOXES:
        raise ToolError(f"email must be one of {INBOXES}")
    INBOX_FILE.write_text(email + "\n")
    return f"The demo inbox now holds the {email} email."


SET_INBOX = {
    "name": "set_inbox",
    "description": "Demo control: choose which email is in the inbox, 'benign' (a normal "
                   "Toronto Hydro bill), 'injected' (plus a 'bank details changed' attack) or "
                   "'forged' (a bill with the attacker's account and an inflated balance). "
                   "Use show_email to let the user see it.",
    "inputSchema": {"type": "object", "properties": {"email": {"type": "string", "enum": INBOXES}},
                    "required": ["email"]},
    "fn": set_inbox,
}

SHOW_EMAIL = {
    "name": "show_email",
    "description": "Open the user's latest email in a window. Call this ONLY when the user "
                   "explicitly asks to see or open their email; never call it on your own, e.g. "
                   "before paying (pay_bill reads the inbox itself). This is the user's inbox: "
                   "use it, not Gmail or a browser.",
    "inputSchema": {"type": "object", "properties": {}},
    "fn": open_email,
}

SAFE_TOOLS = [
    {
        "name": "pay_bill",
        "description": "Pay a bill or invoice for the user from their inbox (use this, not Gmail), "
                       "e.g. 'Pay my Toronto Hydro bill from my "
                       "latest email'. Pass the user's request in their own words. It reads the "
                       "inbox itself and checks the payment against the user's payee book and $100 "
                       "cap. If it's blocked, show the user why and ask before approving.",
        "inputSchema": {"type": "object", "properties": {"request": {"type": "string"}},
                        "required": ["request"]},
        "fn": pay_bill,
    },
    {
        "name": "approve_payment",
        "description": "Approve a payment pay_bill blocked. Call this ONLY after the user explicitly "
                       "says yes to that payment in this conversation.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}},
                        "required": ["id"]},
        "fn": approve_payment,
    },
    SHOW_EMAIL,
]

def pay_bill_unsafe(request: str) -> str:
    """The baseline agent (baseline.py): reads the email into its own context and picks the
    payment itself. Same tools and payee book as ours, no policy."""
    from .baseline import run_baseline
    steps: list[str] = []
    ledger = run_baseline(inbox(), request, chain=chain("GOAT_BASELINE_KEY"),
                          progress=lambda kind, text: steps.append(f"{kind}: {text}"))
    log("baseline agent:\n  " + "\n  ".join(steps))
    if not ledger:
        return "Payment failed. Please try again."
    for e in ledger:
        if "explorer" in e:
            log(f"receipt: {e['explorer']}")
    return " ".join(f"Payment sent: ${e['amount']:.2f}." for e in ledger)


AGENT_TOOLS = [
    {
        "name": "pay_bill",
        "description": "Pay a bill or invoice for the user from their inbox (use this, not Gmail), "
                       "e.g. 'Pay my Toronto Hydro bill from my latest email'. Pass the user's "
                       "request in their own words.",
        "inputSchema": {"type": "object", "properties": {"request": {"type": "string"}},
                        "required": ["request"]},
        "fn": pay_bill_unsafe,
    },
    SHOW_EMAIL,
]

# Inbox and bank only: no payee book to check an account against.
RAW_TOOLS = [
    {"name": "read_latest_email", "description": "Read the user's latest email. This is the "
     "user's inbox: use it (not Gmail or a browser) for anything about their email.",
     "inputSchema": {"type": "object", "properties": {}}, "fn": unsafe_tool("read_latest_email")},
    {"name": "pay", "description": "Pay an account (e.g. ACCT-1001) an amount in dollars.",
     "inputSchema": {"type": "object", "properties": {"payee": {"type": "string"},
                                                      "amount": {"type": "number"}},
                     "required": ["payee", "amount"]}, "fn": unsafe_tool("pay")},
    SHOW_EMAIL,
]

TOOLS = {t["name"]: t for t in (RAW_TOOLS if RAW else AGENT_TOOLS if UNSAFE else SAFE_TOOLS)}


# --- MCP stdio transport ---

def handle(msg: dict) -> dict | None:
    method, params = msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "hivemind-unsafe" if UNSAFE else "hivemind", "version": "0.1"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [{k: v for k, v in t.items() if k != "fn"} for t in TOOLS.values()]}
    if method == "tools/call":
        tool = TOOLS.get(params.get("name"))
        if tool is None:
            raise LookupError(f"unknown tool {params.get('name')!r}")
        try:
            text, error = tool["fn"](**(params.get("arguments") or {})), False
        except ToolError as e:
            text, error = str(e), True
        except Exception as e:  # keep messages generic, they may hold untrusted data
            log(f"{params.get('name')} failed: {e!r}")
            text, error = f"{params.get('name')} failed ({type(e).__name__})", True
        return {"content": [{"type": "text", "text": text}], "isError": error}
    raise LookupError(f"method not found: {method}")


def main() -> None:
    if "--inbox" in sys.argv:
        print(set_inbox(sys.argv[sys.argv.index("--inbox") + 1]))
        return
    if "--show" in sys.argv:  # open the email window from the terminal
        print(open_email())
        return
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout = sys.stderr  # stray prints must not corrupt the protocol
    log(f"hivemind MCP server: {'raw' if RAW else 'unsafe' if UNSAFE else 'safe'} mode, goat={GOAT}")
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        if "id" not in msg:
            continue  # a notification, e.g. notifications/initialized
        try:
            reply = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg)}
        except LookupError as e:
            reply = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": str(e)}}
        PROTOCOL.write(json.dumps(reply) + "\n")
        PROTOCOL.flush()


if __name__ == "__main__":
    main()
