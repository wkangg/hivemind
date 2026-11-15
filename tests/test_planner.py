"""Step 3: live planner via headless claude. Skipped if the CLI is missing."""

import shutil
import unittest

from hivemind.emails import EMAILS
from hivemind.interpreter import run
from hivemind.planner import plan
from hivemind.qllm import qllm
from hivemind.tools import World, make_tools


@unittest.skipUnless(shutil.which("claude"), "needs the claude CLI")
class LivePlanner(unittest.TestCase):
    def test_hydro_plan_matches_handwritten(self):
        world = World(email=EMAILS["benign"])
        tools = make_tools(world, qllm=qllm)
        steps = plan("Pay my Toronto Hydro bill from my latest email", tools)
        self.assertEqual(sorted(s["tool"] for s in steps),
                         ["lookup_payee", "pay", "qllm", "read_latest_email"])
        lookup = next(s for s in steps if s["tool"] == "lookup_payee")
        self.assertEqual(lookup["args"], {"name": "Toronto Hydro"})  # trusted constant, not from the email
        res = run(steps, tools, cap=100.0)
        self.assertEqual(res.status, "ok", res.error)
        self.assertEqual(world.ledger, [{"to": "ACCT-1001", "amount": 84.2, "name": "Toronto Hydro"}])


if __name__ == "__main__":
    unittest.main()
