"""The adapter interface every card terminal (EFTPOS machine) provider implements.

Riyeser never talks to a card network itself. An adapter turns four questions into whatever its provider needs:

    start_payment(amount, currency, reference) -> provider id     "ask the machine to take this much"
    status(provider_id)                        -> TerminalResult  "what happened?" (polled about once a second)
    cancel(provider_id)                        -> bool            "stop waiting for the card" (a request, not a promise)
    refund(original_provider_id, amount, currency, reference) -> provider id   (then polled like a payment)
    settlement()                               -> dict or None    totals the machine/provider holds, when supported

Amounts are whole cents. Each adapter instance is made for one attempt and gets that attempt's ``state`` dict, which
the store saves to the company file after every call, so an adapter can pick up where it left off after a crash.
Adapters must not touch the books: the store (riyeser/terminals/store.py) records attempts and the till finalises
the sale. Real providers (Stripe Terminal, Square, Windcave, Adyen, Tyro, Linkly, ...) are added as new modules.
"""
from dataclasses import dataclass, field, asdict

PENDING, APPROVED, DECLINED, CANCELLED, TIMEOUT, ERROR = "pending", "approved", "declined", "cancelled", "timeout", \
    "error"
FINAL = (APPROVED, DECLINED, CANCELLED, TIMEOUT, ERROR)
STATUS_WORDS = {PENDING: "Waiting for the customer", APPROVED: "Approved", DECLINED: "Declined",
                CANCELLED: "Cancelled", TIMEOUT: "Timed out", ERROR: "Terminal error"}
SCHEMES = ["Visa", "Mastercard", "EFTPOS", "Amex", "UnionPay", "JCB", "Diners", "Discover"]
ENTRY_MODES = {"tap": "Tap (contactless)", "insert": "Insert (chip)", "swipe": "Swipe", "keyed": "Keyed",
               "wallet": "Phone / watch"}


class TerminalUnavailable(Exception):
    """The provider can't be used (not set up, coming soon, or the machine can't be reached)."""


@dataclass
class TerminalResult:
    status: str = PENDING
    amount: int = 0              # the sale part approved (normally what was asked for)
    tip: int = 0                 # added on the machine by the customer
    cashout: int = 0             # cash the customer asked for: comes out of the till's drawer
    surcharge: int = 0           # card fee added by the machine
    total: int = 0               # everything charged to the card: amount + tip + cashout + surcharge
    card_scheme: str = ""        # Visa, Mastercard, EFTPOS, ...
    card_last4: str = ""
    entry_mode: str = ""         # tap, insert, swipe, keyed, wallet
    auth_code: str = ""
    terminal_ref: str = ""       # the machine's own reference (RRN / STAN / transaction number)
    provider_txn_id: str = ""
    receipt_lines: list = field(default_factory=list)   # the machine's own receipt text, line by line
    message: str = ""

    def as_dict(self):
        return asdict(self)


class TerminalAdapter:
    key = ""                 # stored in pos_terminal_settings.provider
    name = ""
    blurb = ""
    integration = ""         # simulator, manual, cloud, local
    available = True         # False: shown on the setup screen but can't be chosen (e.g. coming soon)
    coming_soon = False
    cashier_confirms = False  # the cashier, not the machine, says approved / declined (Manual)
    supports_tip = supports_cashout = supports_refund = supports_settlement = False
    countries = ""

    def __init__(self, config=None, state=None):
        self.config = dict(config or {})
        self.state = state if state is not None else {}

    def start_payment(self, amount, currency, reference):
        raise NotImplementedError

    def status(self, provider_id):
        raise NotImplementedError

    def cancel(self, provider_id):
        raise NotImplementedError

    def refund(self, original_provider_id, amount, currency, reference):
        raise NotImplementedError

    def settlement(self):
        return None

    @classmethod
    def describe(cls):
        return dict(key=cls.key, name=cls.name, blurb=cls.blurb, integration=cls.integration,
                    available=cls.available, coming_soon=cls.coming_soon, cashier_confirms=cls.cashier_confirms,
                    countries=cls.countries)
