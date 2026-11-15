"""Payment policy. Pure code: it looks only at labels and the amount, never at email text.

P1, payee integrity: the payee must be TRUSTED.
P2, amount cap: an UNTRUSTED amount must be <= the user's cap.
"""

from dataclasses import dataclass

from .labels import Tagged


@dataclass(frozen=True)
class Violation:
    rule: str
    message: str


def check_pay(payee: Tagged, amount: Tagged, cap: float) -> list[Violation]:
    violations = []
    if not payee.trusted:
        violations.append(Violation(
            "P1", f"payee is UNTRUSTED: it came from {', '.join(sorted(payee.sources))}"))
    if not amount.trusted:
        where = ", ".join(sorted(amount.sources))
        try:
            value = float(amount.value)
        except (TypeError, ValueError):
            violations.append(Violation("P2", f"amount is not a number and came from {where}"))
        else:
            if value > cap:
                violations.append(Violation(
                    "P2", f"amount ${value:.2f} is over your ${cap:.2f} cap and came from {where}"))
    return violations
