"""Windcave (formerly Payment Express): COMING SOON. Disabled; makes no network calls.

Windcave terminals are used in New Zealand, Australia, the Pacific (including Fiji), the UK/Ireland and the US.
This module only records where a real integration plugs in; nothing here imports an HTTP library or reads a key.

Windcave offers two ways for POS software to drive its attended terminals (check the current developer docs at
windcave.com/developer-documentation, "Merchant attended"; names below are as published in late 2026):

  * HIT (Host Initiated Transactions), cloud: the POS sends HTTPS requests to Windcave's host, which forwards
    them to the terminal over the internet (terminal <-> Windcave on TCP 65). No cable or local network link
    between the PC and the terminal. This is the one Riyeser should build first: it fits a server-driven design
    exactly like Stripe Terminal and works from a till PC behind NAT.
      start_payment -> POST a "Purchase" (amount, currency, TxnRef=reference, Station=terminal id) to the HIT
                       endpoint (sandbox on a demo.windcave.com host), with the HIT user + key.
      status        -> poll the same TxnRef ("Status" request) until Complete=1; map ReCo/ResponseText
                       (00 = approved), CardType -> card_scheme, CardNumber (masked) -> last 4, AuthCode,
                       DpsTxnRef -> provider_txn_id, Rrn -> terminal_ref, the receipt (Rcpt) lines,
                       tip / cash-out / surcharge amounts when the terminal adds them.
      cancel        -> the HIT "Cancel" / button request while the terminal is waiting for a card.
      refund        -> a "Refund" HIT request (attended refunds usually need the card presented).
      settlement    -> terminal settlement/cutover is run on the terminal; totals come from Windcave's reports.
  * SCR / EFTPOS "Tupelo", local: an XML socket interface to the SCR Controller software that runs on the
    till PC and talks to the terminal. Better offline behaviour, but needs Windows software installed per till.

  Keys / setup per till (to keep in pos_terminal_settings.config; secrets in the OS credential store):
      {"hit_user": "...", "key_ref": "keyring:riyeser-pos-windcave-<till>", "station_id": "<terminal id>"}
  Partner access: request a developer (sandbox) account from Windcave, build against the sandbox, then pass
  Windcave's integration certification before live use; each merchant gets HIT credentials from Windcave or
  their bank/acquirer (in Fiji, terminals are typically supplied through a bank partnership; confirm locally).
"""
from .base import TerminalAdapter, TerminalUnavailable


class WindcaveTerminal(TerminalAdapter):
    key = "windcave"
    name = "Windcave"
    blurb = "Windcave EFTPOS terminals (NZ, Australia, Fiji and the Pacific, UK, US), linked over the internet. " \
            "Coming soon."
    integration = "cloud"
    available = False
    coming_soon = True
    supports_tip = supports_cashout = supports_refund = True
    countries = "New Zealand, Australia, Fiji and the Pacific, UK, Ireland, US"

    def _off(self, *a, **kw):
        raise TerminalUnavailable("Windcave is coming soon. Choose Manual or Practice terminal for now.")

    start_payment = status = cancel = refund = _off
