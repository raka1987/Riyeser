"""Card payments (EFTPOS) for Riyeser POS, provider-neutral.

    base.py             the adapter interface and the result every provider reports
    practice.py         Practice terminal: a pretend machine on the screen (demo mode uses it)
    manual.py           Manual: the business's own unlinked machine; the cashier taps Approved / Declined
    stripe_terminal.py  Stripe Terminal, documented stub, coming soon (no network calls)
    windcave.py         Windcave, documented stub, coming soon (no network calls)
    store.py            every attempt and its full status history in the company file

Adding a provider (Square Terminal API, Adyen Terminal API, SumUp, Zettle, Tyro, Linkly, Smartpay, ...) means one
new module with a TerminalAdapter subclass and a line in PROVIDERS. The till, receipts, refunds and close of day
don't change.
"""
from .base import TerminalAdapter, TerminalResult, TerminalUnavailable, FINAL, PENDING, APPROVED, DECLINED, \
    CANCELLED, TIMEOUT, ERROR, STATUS_WORDS, SCHEMES, ENTRY_MODES
from .practice import PracticeTerminal
from .manual import ManualTerminal
from .stripe_terminal import StripeTerminal
from .windcave import WindcaveTerminal

NONE = "none"
PROVIDERS = {a.key: a for a in (ManualTerminal, PracticeTerminal, StripeTerminal, WindcaveTerminal)}
NONE_INFO = dict(key=NONE, name="Not linked (as before)", blurb="Card sales are recorded as card, with no card details. "
                 "The cashier keys the amount into the machine and taps Card approved.", integration="none",
                 available=True, coming_soon=False, cashier_confirms=False, countries="")


def adapter_class(key):
    return PROVIDERS.get(key)


def choices():
    return [NONE_INFO] + [a.describe() for a in PROVIDERS.values()]
