"""Payroll calculations (Australian, simplified).

PAYG withholding is approximated by annualising period earnings and applying
the 2024-25 resident tax rates (plus 2% Medicare levy).  This is NOT the
ATO's official Schedule 1 coefficient method - check before relying on it.
"""
from .db import round_cents

PERIODS = {"weekly": 52, "fortnightly": 26, "monthly": 12}

# (threshold, base tax, marginal rate) in dollars - 2024-25 resident rates
BRACKETS = [
    (190000, 51638, 0.45),
    (135000, 31288, 0.37),
    (45000, 4288, 0.30),
    (18200, 0, 0.16),
    (0, 0, 0.0),
]


def annual_tax(income_dollars, tax_free_threshold=True):
    if not tax_free_threshold:
        # no tax-free threshold: approximate by shifting income up by the threshold
        return annual_tax(income_dollars + 18200, True)
    for threshold, base, rate in BRACKETS:
        if income_dollars > threshold:
            tax = base + (income_dollars - threshold) * rate
            break
    else:
        tax = 0
    medicare = income_dollars * 0.02 if income_dollars > 26000 else 0
    return tax + medicare


def compute_pay(emp, frequency, hours=None):
    """Return dict(hours, gross, tax, super, net, leave) in cents for one pay period."""
    periods = PERIODS[frequency]
    if emp["pay_basis"] == "salary":
        gross = round_cents(emp["annual_salary"] / periods)
        hours = hours if hours is not None else emp["std_hours"] * 52 / periods
    else:
        hours = float(hours if hours is not None else emp["std_hours"] * 52 / periods)
        gross = round_cents(hours * emp["hourly_rate"])
    annual = gross / 100.0 * periods
    tax = round_cents(annual_tax(annual, bool(emp["tax_free_threshold"])) / periods * 100)
    tax = int(round(tax / 100.0)) * 100  # ATO rounds withholding to whole dollars
    tax = min(tax, gross)
    sup = round_cents(gross * emp["super_rate"] / 100.0)
    leave = round(hours * 0.0769, 4)  # 4 weeks annual leave / 52 weeks
    return dict(hours=round(hours, 2), gross=gross, tax=tax, super=sup, net=gross - tax, leave=leave)
