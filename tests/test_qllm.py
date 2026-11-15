"""Step 2: live Q-LLM via headless claude. Skipped if the CLI is missing."""

import shutil
import unittest

from hivemind.emails import EMAILS
from hivemind.interpreter import run
from hivemind.qllm import qllm
from hivemind.tools import World, make_tools

PLAN = [
    {"tool": "read_latest_email", "args": {}, "out": "email"},
    {"tool": "qllm", "args": {"data": "$email", "schema": "Invoice"}, "out": "inv"},
]


@unittest.skipUnless(shutil.which("claude"), "needs the claude CLI")
class LiveQLLM(unittest.TestCase):
    def test_amount_is_untrusted(self):
        tools = make_tools(World(email=EMAILS["benign"]), qllm=qllm)
        res = run(PLAN, tools, cap=100.0)
        self.assertEqual(res.status, "ok", res.error)
        inv = res.env["inv"]
        self.assertAlmostEqual(inv.value["amount"], 84.20)
        self.assertFalse(inv.trusted)
        self.assertEqual(inv.sources, {"email:inv_42", "qllm"})


if __name__ == "__main__":
    unittest.main()
