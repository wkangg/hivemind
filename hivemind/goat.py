"""Real payments on GOAT Network Testnet3, in test USDC. The only file that talks to the chain.

The policy has already approved the payment before anything here runs.
- A payee that is a GOAT Flow merchant (Toronto Hydro) is paid through GOAT Flow
  x402: create an order, check the 402's payTo is the address in our payee book,
  send a USDC transfer, then wait for GOAT Flow to confirm the order.
- Any other address gets a plain USDC transfer. That's how a hijacked baseline
  really pays the attacker.

Demo dollars are scaled to USDC (GOAT_USDC_PER_DOLLAR, default 0.002) so faucet
funds last: an $84.20 bill moves 0.1684 USDC. GOAT Flow's minimum order is 0.1 USDC.

Env (.env at the repo root, git-ignored): GOAT_PAYER_KEY, GOAT_BASELINE_KEY,
GOAT_HYDRO_ADDRESS, GOAT_ATTACKER_ADDRESS, GOATFLOW_API_KEY, GOATFLOW_API_SECRET.
"""

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

from eth_account import Account

RPC_URL = "https://rpc.testnet3.goat.network"
CHAIN_ID = 48816
EXPLORER = "https://explorer.testnet3.goat.network"
FLOW_API = "https://flow-api.testnet3.goat.network"
USDC = "0x29D1Ee93e9ecf6E50F309f498e40a6b42D352Fa1"  # official test USDC; look-alikes exist
USDC_DECIMALS = 6
TRANSFER_GAS = 100_000


class ChainError(Exception):
    pass


# Set by the demo to show live progress: PROGRESS(kind, text), kind "status" or "step".
PROGRESS: Callable[[str, str], None] | None = None


def _progress(kind: str, text: str) -> None:
    if PROGRESS is not None:
        PROGRESS(kind, text)


def load_env(path: Path = Path(__file__).resolve().parent.parent / ".env") -> None:
    """Minimal .env reader: KEY=value lines, '#' comments. Never overrides the real env."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def env(name: str) -> str:
    load_env()
    value = os.environ.get(name, "")
    if not value:
        raise ChainError(f"{name} is not set (see .env)")
    return value


def to_units(dollars: float) -> int:
    rate = float(os.environ.get("GOAT_USDC_PER_DOLLAR", "0.002"))
    return round(dollars * rate * 10**USDC_DECIMALS)


def explorer_tx(tx_hash: str) -> str:
    return f"{EXPLORER}/tx/{tx_hash}"


# --- chain (JSON-RPC over plain HTTP) ---

def rpc(method: str, params: list) -> Any:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC_URL, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.load(resp)
    if "error" in out:
        raise ChainError(f"{method}: {out['error'].get('message', 'rpc error')}")
    return out["result"]


def usdc_balance(address: str) -> int:
    data = "0x70a08231" + address[2:].lower().rjust(64, "0")
    return int(rpc("eth_call", [{"to": USDC, "data": data}, "latest"]), 16)


def send_usdc(key: str, to: str, units: int) -> str:
    """Signs and broadcasts transfer(to, units) on the USDC contract. Returns the tx hash."""
    sender = Account.from_key(key).address
    data = "0xa9059cbb" + to[2:].lower().rjust(64, "0") + hex(units)[2:].rjust(64, "0")
    tx = {
        "chainId": CHAIN_ID,
        "nonce": int(rpc("eth_getTransactionCount", [sender, "pending"]), 16),
        "gasPrice": int(rpc("eth_gasPrice", []), 16),
        "gas": TRANSFER_GAS,
        "to": USDC,
        "value": 0,
        "data": data,
    }
    signed = Account.sign_transaction(tx, key)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    return rpc("eth_sendRawTransaction", ["0x" + raw.hex().removeprefix("0x")])


def wait_receipt(tx_hash: str, timeout_s: float = 90) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        receipt = rpc("eth_getTransactionReceipt", [tx_hash])
        if receipt:
            if receipt.get("status") != "0x1":
                raise ChainError(f"transaction reverted: {explorer_tx(tx_hash)}")
            return receipt
        time.sleep(2)
    raise ChainError(f"no receipt yet: {explorer_tx(tx_hash)}")


# --- GOAT Flow (merchant API, HMAC-SHA256 signed) ---

def flow_request(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    api_key, secret = env("GOATFLOW_API_KEY"), env("GOATFLOW_API_SECRET")
    timestamp, nonce = str(int(time.time())), str(uuid.uuid4())
    fields = {k: v for k, v in (body or {}).items()}
    fields.update(api_key=api_key, timestamp=timestamp, nonce=nonce)
    canonical = "&".join(f"{k}={_field(fields[k])}" for k in sorted(fields)
                         if k != "sign" and fields[k] != "")
    sign = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    headers = {"Content-Type": "application/json", "X-API-Key": api_key,
               "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Sign": sign}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(FLOW_API + path, data, headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:  # 402 is the expected reply to a new order
        try:
            return e.code, json.load(e)
        except json.JSONDecodeError:
            return e.code, {}


def _field(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def flow_create_order(payer: str, units: int) -> dict:
    """Creates an order. Returns {order_id, pay_to, amount, token} from the x402 terms."""
    status, body = flow_request("POST", "/api/v1/orders", {
        "dapp_order_id": str(uuid.uuid4()),
        "chain_id": CHAIN_ID,
        "token_symbol": "USDC",
        "token_contract": USDC,
        "from_address": payer,
        "amount_wei": str(units),
    })
    if status != 402:
        raise ChainError(f"GOAT Flow order: expected 402, got {status}: {json.dumps(body)[:300]}")
    order = body.get("data", body)
    option = (order.get("accepts") or [{}])[0]
    terms = {
        "order_id": order.get("order_id"),
        "pay_to": option.get("payTo"),
        "amount": int(option.get("amount", 0)),
        "token": option.get("asset"),
        "network": option.get("network"),
        "method": (order.get("extensions") or {}).get("goatx402", {}).get("paymentMethod", "transfer"),
    }
    if not terms["order_id"] or not terms["pay_to"]:
        raise ChainError(f"GOAT Flow order: unexpected 402 body: {json.dumps(body)[:300]}")
    return terms


def flow_status(order_id: str) -> str:
    _, body = flow_request("GET", f"/api/v1/orders/{order_id}")
    return body.get("data", body).get("status", "UNKNOWN")


def flow_cancel(order_id: str) -> None:
    flow_request("POST", f"/api/v1/orders/{order_id}/cancel", {})


# GOAT Flow matches a payment to the OLDEST open order from the same wallet for the
# same amount, not to the order it was sent for. So before creating an order we
# cancel any of ours still open; then the new order is the only one a payment can match.
ORDERS_FILE = Path(__file__).resolve().parent.parent / ".goat-orders"


def _open_orders() -> list[str]:
    return ORDERS_FILE.read_text().split() if ORDERS_FILE.exists() else []


def _save_orders(ids: list[str]) -> None:
    ORDERS_FILE.write_text("\n".join(ids) + ("\n" if ids else ""))


def flow_cancel_stale() -> None:
    keep = []
    for order_id in _open_orders():
        status = flow_status(order_id)
        if status == "CHECKOUT_VERIFIED":
            flow_cancel(order_id)
            if flow_status(order_id) == "CHECKOUT_VERIFIED":
                keep.append(order_id)  # cancel didn't take; retry next time
    _save_orders(keep)


def flow_wait_paid(order_id: str, timeout_s: float = 180) -> str:
    deadline = time.time() + timeout_s
    status = "UNKNOWN"
    while time.time() < deadline:
        status = flow_status(order_id)
        if status in ("PAYMENT_CONFIRMED", "INVOICED"):
            return status
        if status in ("FAILED", "EXPIRED", "CANCELLED"):
            raise ChainError(f"GOAT Flow order {order_id} ended as {status}")
        time.sleep(3)
    return status  # paid on-chain, but GOAT Flow hasn't confirmed yet


# --- the payment backend the tools call ---

def payee_addresses() -> dict[str, tuple[str, bool]]:
    """Payee-book account -> (on-chain address, is a GOAT Flow merchant). Trusted config."""
    return {
        "ACCT-1001": (env("GOAT_HYDRO_ADDRESS"), True),     # Toronto Hydro, our merchant
        "ACCT-9921": (env("GOAT_ATTACKER_ADDRESS"), False),  # the attacker's account
    }


def payer(key_env: str) -> Callable[[dict], dict]:
    """A backend for World.chain that pays from the wallet in `key_env`."""
    def pay(entry: dict) -> dict:
        key = env(key_env)
        sender = Account.from_key(key).address
        account = entry["to"]
        if account not in payee_addresses():
            raise ChainError(f"no on-chain address for {account}")
        address, merchant = payee_addresses()[account]
        units = to_units(entry["amount"])
        result: dict = {"usdc": units / 10**USDC_DECIMALS, "address": address}
        if merchant:
            flow_cancel_stale()
            _progress("status", "GOAT Flow: creating an x402 order")
            terms = flow_create_order(sender, units)
            _progress("step", f"GOAT Flow order {terms['order_id'][:8]}: HTTP 402, pay "
                              f"{terms['amount'] / 10**USDC_DECIMALS:g} USDC to {terms['pay_to']}")
            _save_orders(_open_orders() + [terms["order_id"]])
            result["order_id"] = terms["order_id"]
            # Defense in depth: only pay the address in our payee book, in USDC, by plain transfer.
            problem = None
            if terms["pay_to"].lower() != address.lower():
                problem = "GOAT Flow asked to be paid at an address that is not in the payee book"
            elif (terms["token"] or "").lower() != USDC.lower() or terms["method"] != "transfer":
                problem = "GOAT Flow asked for a token or payment method we don't use"
            elif terms["amount"] != units:
                problem = "GOAT Flow quoted a different amount"
            if problem:
                flow_cancel_stale()
                raise ChainError(problem)
            _progress("step", "payTo, token and amount match our payee book")
        _progress("status", f"signing and sending {units / 10**USDC_DECIMALS:g} USDC on GOAT Testnet3")
        try:
            tx_hash = send_usdc(key, address, units)
        except Exception:
            if merchant:
                flow_cancel_stale()  # nothing was sent, so the order must not stay open
            raise
        _progress("status", f"sent {tx_hash[:12]}..., waiting for a block (~3 s)")
        receipt = wait_receipt(tx_hash)
        _progress("step", f"confirmed in block {int(receipt['blockNumber'], 16)}")
        result.update(tx=tx_hash, explorer=explorer_tx(tx_hash))
        if merchant:
            _progress("status", "waiting for GOAT Flow to see the payment")
            result["flow_status"] = flow_wait_paid(result["order_id"])
            _progress("step", f"GOAT Flow order {result['order_id'][:8]}: {result['flow_status']}")
        return result
    return pay
