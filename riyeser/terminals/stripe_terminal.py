"""Stripe Terminal (server-driven integration): COMING SOON. Disabled; makes no network calls.

This module only documents where a real integration plugs in. Nothing here imports an HTTP library, reads a key or
talks to Stripe. It becomes available once Riyeser has a Stripe partner account and the steps below are built and
certified. Until then the setup screen shows it greyed out as "coming soon".

How the server-driven flow maps onto the adapter interface (https://docs.stripe.com/terminal/payments/collect-payment,
"server-driven"; readers: BBPOS WisePOS E, Stripe Reader S700; no mobile readers, no offline payments):

  Keys (never in the company file in plain text, never in the repo):
    * The business connects its own Stripe account (Stripe Connect, OAuth) from the Card payments setup screen, or
      pastes a restricted secret key. Store it in the operating system's credential store (Windows Credential
      Manager / macOS Keychain) under "Riyeser POS / Stripe / <company id>"; keep only a reference in
      pos_terminal_settings.config, e.g. {"account": "acct_...", "key_ref": "keyring:riyeser-pos-stripe-1"}.
  Reader registration (once per till):
    * Create a Location: POST /v1/terminal/locations (address of the shop).
    * The reader shows a registration code; POST /v1/terminal/readers {registration_code, location, label=till}.
    * Keep {"location": "tml_...", "reader": "tmr_..."} in pos_terminal_settings.config for that till.
  start_payment(amount, currency, reference):
    * POST /v1/payment_intents {amount, currency, payment_method_types[]=card_present (+interac_present in CA),
      capture_method=automatic, metadata[riyeser_ref]=reference} -> pi_...
    * POST /v1/terminal/readers/{reader}/process_payment_intent {payment_intent: pi_...}
    * Send an Idempotency-Key header = reference, so a retry after a crash never makes a second charge.
    * Return pi_... ; keep it in self.state["payment_intent"].
  status(pi):
    * GET /v1/terminal/readers/{reader} -> action.status (in_progress / succeeded / failed + failure_message), and
      GET /v1/payment_intents/{pi}?expand[]=latest_charge -> status 'succeeded' means APPROVED.
    * Map latest_charge.payment_method_details.card_present: brand -> card_scheme, last4, read_method ->
      entry_mode, receipt.authorization_code -> auth_code, receipt.* -> receipt_lines; amount_details.tip -> tip.
    * Webhooks (terminal.reader.action_succeeded / _failed) can replace polling later; polling must still work
      because a till PC may be behind a firewall.
  cancel(pi):    POST /v1/terminal/readers/{reader}/cancel_action, then POST /v1/payment_intents/{pi}/cancel.
  refund(pi, amount):  POST /v1/refunds {payment_intent: pi, amount}. In-person refunds of card_present payments are
                 refunded to the card without the card (Interac in Canada needs the card on the reader).
  settlement():  Stripe has no machine settlement; use GET /v1/balance_transactions for the day (payout report).
  Testing:       Stripe's simulated reader (POST /v1/test_helpers/terminal/readers/{id}/present_payment_method) with a
                 test-mode key; the practice terminal already exercises every till screen.
"""
from .base import TerminalAdapter, TerminalUnavailable


class StripeTerminal(TerminalAdapter):
    key = "stripe_terminal"
    name = "Stripe Terminal"
    blurb = "Stripe's smart readers (WisePOS E, S700), linked over the internet. Coming soon."
    integration = "cloud"
    available = False
    coming_soon = True
    supports_tip = supports_refund = True
    countries = "Australia, New Zealand, US, Canada, UK, Ireland, much of Europe, Japan, Malaysia, Hong Kong, Mexico " \
                "(not Fiji; check Stripe's list for your country)"

    def _off(self, *a, **kw):
        raise TerminalUnavailable("Stripe Terminal is coming soon. Choose Manual or Practice terminal for now.")

    start_payment = status = cancel = refund = _off
