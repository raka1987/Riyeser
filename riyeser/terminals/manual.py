"""Manual (unlinked machine): the business's own EFTPOS machine, not connected to Riyeser.

The till shows the amount; the cashier keys it into their machine, then taps Approved or Declined and may type the
last 4 digits and auth code from the machine's slip. Nothing is sent anywhere, but every attempt is still recorded,
so close of day and refunds work the same way as with a linked terminal.
"""
import time

from .base import TerminalAdapter, TerminalResult, PENDING, APPROVED, DECLINED, CANCELLED


class ManualTerminal(TerminalAdapter):
    key = "manual"
    name = "Manual (unlinked machine)"
    blurb = "Your own EFTPOS machine. Key the amount in yourself, then tap Approved or Declined on the till."
    integration = "manual"
    cashier_confirms = True
    supports_refund = True
    countries = "Everywhere"

    def start_payment(self, amount, currency, reference):
        pid = f"MAN-{int(time.time() * 1000) % 10**10:010d}"
        self.state.update(id=pid, amount=amount, outcome=None)
        return pid

    def refund(self, original_provider_id, amount, currency, reference):
        return self.start_payment(amount, currency, reference)

    def record(self, approved, last4="", auth="", scheme="", ref=""):
        if self.state.get("outcome"):
            return False
        self.state["outcome"] = dict(approved=bool(approved), last4=(last4 or "")[-4:], auth=(auth or "")[:12],
                                     scheme=scheme or "", ref=(ref or "")[:30])
        return True

    def cancel(self, provider_id):
        if not self.state.get("outcome"):
            self.state["outcome"] = dict(cancelled=True)
        return True

    def status(self, provider_id):
        o = self.state.get("outcome")
        if not o:
            return TerminalResult(status=PENDING, provider_txn_id=provider_id)
        if o.get("cancelled"):
            return TerminalResult(status=CANCELLED, provider_txn_id=provider_id, message="Cancelled at the till")
        if not o["approved"]:
            return TerminalResult(status=DECLINED, provider_txn_id=provider_id, message="Declined on the machine")
        amt = self.state.get("amount", 0)
        return TerminalResult(status=APPROVED, amount=amt, total=amt, card_scheme=o["scheme"], card_last4=o["last4"],
                              auth_code=o["auth"], terminal_ref=o["ref"], entry_mode="",
                              provider_txn_id=provider_id, message="Approved on the card machine (cashier)")
