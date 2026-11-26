"""Practice terminal: a pretend card machine on the screen, for training, demos and testing the whole card flow.

No card is read and no money moves. The pretend machine's buttons (approve, decline, the customer cancelling, time
out, approve with a tip or cash out) record an outcome in this attempt's state; status() then reports it the same
way a real cloud terminal reports back, so the till code is exactly the code real terminals will use.
"""
import random
import time

from .base import TerminalAdapter, TerminalResult, PENDING, APPROVED, DECLINED, CANCELLED, TIMEOUT, ENTRY_MODES

TIMEOUT_SECONDS = 180   # a real machine gives up after a few minutes with no card


class PracticeTerminal(TerminalAdapter):
    key = "practice"
    name = "Practice terminal"
    blurb = "A pretend card machine on the screen. Approve, decline, cancel, time out, tips and cash out. " \
            "No money moves. Used automatically in demo mode."
    integration = "simulator"
    supports_tip = supports_cashout = supports_refund = supports_settlement = True
    countries = "Everywhere (no money moves)"

    def start_payment(self, amount, currency, reference):
        pid = f"PRAC-{int(time.time() * 1000) % 10**10:010d}"
        self.state.update(id=pid, amount=amount, currency=currency, reference=reference, started=time.time(),
                          outcome=None)
        return pid

    def refund(self, original_provider_id, amount, currency, reference):
        pid = self.start_payment(amount, currency, reference)
        self.state["original"] = original_provider_id
        return pid

    def simulate(self, action, tip=0, cashout=0, scheme="Visa", entry="tap", last4=None):
        """What the customer does on the pretend machine."""
        if self.state.get("outcome"):
            return False  # the machine already answered
        if action not in ("approve", "decline", "cancel", "timeout"):
            raise ValueError("Unknown practice action.")
        self.state["outcome"] = dict(action=action, tip=max(int(tip or 0), 0), cashout=max(int(cashout or 0), 0),
                                     scheme=scheme or "Visa", entry=entry if entry in ENTRY_MODES else "tap",
                                     last4=last4 or f"{random.randint(0, 9999):04d}",
                                     auth=f"{random.randint(0, 999999):06d}", at=time.time())
        return True

    def cancel(self, provider_id):
        if not self.state.get("outcome"):
            self.state["outcome"] = dict(action="cancel", by="till", at=time.time())
        return True

    def status(self, provider_id):
        s, o = self.state, self.state.get("outcome")
        if not o and time.time() - s.get("started", time.time()) > TIMEOUT_SECONDS:
            o = s["outcome"] = dict(action="timeout", at=time.time())
        if not o:
            return TerminalResult(status=PENDING, provider_txn_id=provider_id)
        ref = f"P{int(o['at']) % 10**6:06d}"
        if o["action"] == "decline":
            return TerminalResult(status=DECLINED, provider_txn_id=provider_id, terminal_ref=ref,
                                  card_scheme=o.get("scheme", ""), card_last4=o.get("last4", ""),
                                  entry_mode=o.get("entry", ""), message="Declined by the card issuer (practice)",
                                  receipt_lines=self._receipt(o, "DECLINED", ref))
        if o["action"] == "cancel":
            return TerminalResult(status=CANCELLED, provider_txn_id=provider_id,
                                  message="Cancelled at the till" if o.get("by") == "till" else
                                  "The customer cancelled on the machine")
        if o["action"] == "timeout":
            return TerminalResult(status=TIMEOUT, provider_txn_id=provider_id,
                                  message="No card was presented in time")
        amt = s.get("amount", 0)
        tip, cashout = o.get("tip", 0), o.get("cashout", 0)
        return TerminalResult(status=APPROVED, amount=amt, tip=tip, cashout=cashout, total=amt + tip + cashout,
                              card_scheme=o["scheme"], card_last4=o["last4"], entry_mode=o["entry"],
                              auth_code=o["auth"], terminal_ref=ref, provider_txn_id=provider_id,
                              message="Approved (practice)", receipt_lines=self._receipt(o, "APPROVED", ref))

    def _receipt(self, o, word, ref):
        s = self.state
        m = lambda c: f"{c / 100:,.2f}"
        lines = ["PRACTICE TERMINAL - NO MONEY MOVED", f"{'REFUND' if s.get('original') else 'PURCHASE'}"
                 f"  {s.get('currency', '')} {m(s.get('amount', 0))}"]
        if o.get("tip"):
            lines.append(f"TIP  {m(o['tip'])}")
        if o.get("cashout"):
            lines.append(f"CASH OUT  {m(o['cashout'])}")
        lines += [f"{o.get('scheme', '').upper()}  **** {o.get('last4', '')}  {o.get('entry', '').upper()}",
                  f"REF {ref}" + (f"  AUTH {o['auth']}" if word == "APPROVED" else ""), word]
        return lines

    def settlement(self):
        return None  # the store adds up the practice attempts itself
