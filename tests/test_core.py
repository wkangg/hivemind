"""Step 1: handwritten plans, no LLM. Run with: python -m unittest -v"""

import re
import unittest

from hivemind.emails import EMAILS
from hivemind.interpreter import run
from hivemind.labels import trusted, untrusted
from hivemind.tools import World, make_tools

CAP = 100.0


def fake_qllm(data, schema):
    """Stands in for the Q-LLM. On the injected email it acts fully hijacked (worst case)."""
    body = data["body"]
    if "ACCT-9921" in body:
        return {"amount": 840.0, "biller": "Toronto Hydro", "account": "ACCT-9921"}
    amount = float(re.search(r"Amount due: \$([\d.]+)", body).group(1))
    return {"amount": amount, "biller": "Toronto Hydro", "account": "ACCT-1001"}


BENIGN_PLAN = [
    {"tool": "read_latest_email", "args": {}, "out": "email"},
    {"tool": "qllm", "args": {"data": "$email", "schema": "Invoice"}, "out": "inv"},
    {"tool": "lookup_payee", "args": {"name": "Toronto Hydro"}, "out": "payee"},
    {"tool": "pay", "args": {"payee": "$payee", "amount": "$inv.amount"}},
]

# The payee comes out of the email.
ATTACK_PLAN = [
    {"tool": "read_latest_email", "args": {}, "out": "email"},
    {"tool": "qllm", "args": {"data": "$email", "schema": "Invoice"}, "out": "inv"},
    {"tool": "pay", "args": {"payee": "$inv.account", "amount": "$inv.amount"}},
]


def setup(email):
    world = World(email=EMAILS[email])
    return world, make_tools(world, qllm=fake_qllm)


class Labels(unittest.TestCase):
    def test_field_keeps_parent_label(self):
        world, tools = setup("benign")
        res = run(BENIGN_PLAN[:2], tools, CAP)
        self.assertFalse(res.env["email"].trusted)
        self.assertFalse(res.env["inv"].trusted)
        self.assertEqual(res.env["inv"].sources, {"email:inv_42", "qllm"})

    def test_trusted_tool_with_untrusted_arg_is_untrusted(self):
        world, tools = setup("benign")
        plan = BENIGN_PLAN[:2] + [{"tool": "lookup_payee", "args": {"name": "$inv.biller"}, "out": "p"}]
        res = run(plan, tools, CAP)
        self.assertEqual(res.status, "ok")
        self.assertFalse(res.env["p"].trusted)
        self.assertIn("email:inv_42", res.env["p"].sources)

    def test_constant_payee_lookup_is_trusted(self):
        world, tools = setup("injected")
        res = run(BENIGN_PLAN[2:3], tools, CAP)
        self.assertTrue(res.env["payee"].trusted)


class Payments(unittest.TestCase):
    def test_benign_plan_pays(self):
        world, tools = setup("benign")
        res = run(BENIGN_PLAN, tools, CAP)
        self.assertEqual(res.status, "ok")
        self.assertEqual(world.ledger, [{"to": "ACCT-1001", "amount": 84.20, "name": "Toronto Hydro"}])

    def test_attack_plan_blocked_with_source(self):
        world, tools = setup("injected")
        res = run(ATTACK_PLAN, tools, CAP)
        self.assertEqual(res.status, "blocked")
        self.assertEqual(world.ledger, [])
        p1 = [v for v in res.violations if v.rule == "P1"]
        self.assertEqual(len(p1), 1)
        self.assertIn("email:inv_42", p1[0].message)

    def test_hijacked_amount_over_cap_blocked(self):
        # Benign plan, injected email: payee stays Hydro, but $840 is over the cap.
        world, tools = setup("injected")
        res = run(BENIGN_PLAN, tools, CAP)
        self.assertEqual(res.status, "blocked")
        self.assertEqual([v.rule for v in res.violations], ["P2"])
        self.assertEqual(world.ledger, [])

    def test_user_can_approve(self):
        world, tools = setup("injected")
        res = run(ATTACK_PLAN, tools, CAP, confirm=lambda *a: True)
        self.assertEqual(res.status, "ok")
        self.assertEqual(world.ledger[0]["to"], "ACCT-9921")

    def test_trusted_amount_ignores_cap(self):
        world, tools = setup("benign")
        plan = BENIGN_PLAN[2:3] + [{"tool": "pay", "args": {"payee": "$payee", "amount": 500}}]
        self.assertEqual(run(plan, tools, CAP).status, "ok")


class Validation(unittest.TestCase):
    def check_error(self, plan):
        world, tools = setup("benign")
        res = run(plan, tools, CAP)
        self.assertEqual(res.status, "error")
        self.assertEqual(world.ledger, [])
        return res.error

    def test_rejects_branches(self):
        self.check_error([{"tool": "pay", "if": "$x", "args": {}}])

    def test_rejects_unknown_tool(self):
        self.check_error([{"tool": "send_wire", "args": {}}])

    def test_rejects_nested_args(self):
        self.check_error([{"tool": "lookup_payee", "args": {"name": {"$ref": "x"}}}])

    def test_undefined_and_missing_field(self):
        self.check_error([{"tool": "pay", "args": {"payee": "$nope", "amount": 1}}])
        self.check_error(BENIGN_PLAN[:2] + [{"tool": "pay", "args": {"payee": "$inv.iban", "amount": 1}}])

    def test_error_does_not_leak_email_text(self):
        world = World(email=EMAILS["unknown_payee"])
        tools = make_tools(world, qllm=lambda d, s: {"biller": d["body"]})
        plan = BENIGN_PLAN[:2] + [{"tool": "lookup_payee", "args": {"name": "$inv.biller"}}]
        res = run(plan, tools, CAP)
        self.assertEqual(res.status, "error")
        self.assertNotIn("QuickFix", res.error)


if __name__ == "__main__":
    unittest.main()
