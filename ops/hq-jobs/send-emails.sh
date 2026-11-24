#!/usr/bin/env bash
# Sends the emails Riyeser HQ has queued (public.email_outbox) through Resend's HTTP API, then marks each one sent or
# failed (3 tries). Dormant until an email provider is chosen: with no RESEND_API_KEY or EMAIL_FROM it says so and
# leaves everything queued, without failing.
#   DB_URL           the Riyeser Team database's connection string (the TEAM_DB_URL secret; never printed)
#   RESEND_API_KEY   Resend API key (a GitHub secret; optional until email is set up)
#   EMAIL_FROM       the sending address on riyeser.com, e.g. support@riyeser.com (shown as "Riyeser Support")
#   RESEND_URL       only for tests (default https://api.resend.com/emails)
# Privacy: never prints email addresses, subjects or message text. Only ids, counts and HTTP status codes.
set -euo pipefail
: "${DB_URL:?}"
PSQL="${PSQL:-psql}"
RESEND_URL="${RESEND_URL:-https://api.resend.com/emails}"
q() { "$PSQL" "$DB_URL" -X -q -At -v ON_ERROR_STOP=1 -c "$1"; }

if [ "$(q "select to_regclass('public.email_outbox') is not null")" != "t" ]; then
  echo "::notice::No email outbox yet: run the latest team-chat.sql in Supabase first (ops/RUNBOOK.md)."; exit 0
fi
queued="$(q "select count(*) from public.email_outbox where status = 'queued'")"
if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${EMAIL_FROM:-}" ]; then
  echo "::notice::Email sending isn't set up yet: $queued email(s) stay queued. Add RESEND_API_KEY and EMAIL_FROM (ops/RUNBOOK.md, Email sending)."
  exit 0
fi
case "$EMAIL_FROM" in *"<"*) from="$EMAIL_FROM" ;; *) from="Riyeser Support <$EMAIL_FROM>" ;; esac

work="$(mktemp -d)"; cleanup() { rm -rf -- "${work:?}"; }; trap cleanup EXIT
# One JSON object per line (newlines inside the text are escaped by json_build_object).
q "select json_build_object('id', id, 'to', to_address, 'subject', subject, 'text', body_text, 'html', body_html)::text
   from public.email_outbox where status = 'queued' and to_address is not null order by id limit 200" > "$work/queue.jsonl"

sent=0; failed=0; retry=0
while IFS= read -r row; do
  [ -n "$row" ] || continue
  id="$(jq -r '.id' <<<"$row")"
  [[ "$id" =~ ^[0-9]+$ ]] || continue
  jq -c --arg from "$from" '{from: $from, to: [.to], subject: .subject, text: .text} + (if .html then {html: .html} else {} end)' <<<"$row" > "$work/body.json"
  code="$(curl -sS -o "$work/resp.json" -w '%{http_code}' --max-time 30 -X POST "$RESEND_URL" \
    -H "Authorization: Bearer $RESEND_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: riyeser-outbox-$id" \
    --data @"$work/body.json" 2>/dev/null || true)"
  [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
  if [ "$code" = 200 ] || [ "$code" = 201 ]; then
    q "update public.email_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = null where id = $id" >/dev/null
    sent=$((sent + 1))
  else
    st="$(q "update public.email_outbox set attempts = attempts + 1, last_error = 'HTTP $code',
             status = case when attempts + 1 >= 3 then 'failed' else 'queued' end where id = $id returning status")"
    if [ "$st" = failed ]; then failed=$((failed + 1)); else retry=$((retry + 1)); fi
    echo "Email $id: HTTP $code ($st)"
  fi
  sleep 0.6   # Resend allows a few requests a second
done < "$work/queue.jsonl"
echo "Emails: $sent sent, $retry to try again, $failed failed (of $queued queued)."
if [ "$failed" -gt 0 ]; then echo "::warning::$failed email(s) failed after 3 tries. See HQ → Emails."; fi
