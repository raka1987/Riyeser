#!/usr/bin/env bash
# Restore drill: take the newest backup of one database, check it wasn't tampered with, decrypt it, restore it
# into an EMPTY test database, and check every table came back with the same number of rows.
#   NAME, BACKUP_PASSPHRASE, storage settings (as backup.sh), RESTORE_DB_URL (an empty, throwaway database)
#   WHICH=daily (default) or monthly; DATE=YYYY-MM-DD (or YYYY-MM) to drill a particular copy.
# The same steps restore for real: see ops/RUNBOOK.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; . "$here/store.sh"
: "${NAME:?}" "${BACKUP_PASSPHRASE:?}" "${RESTORE_DB_URL:?}"
PSQL="${PSQL:-psql}"; PG_RESTORE="${PG_RESTORE:-pg_restore}"; WHICH="${WHICH:-daily}"
work="$(mktemp -d)"; cleanup() { rm -rf -- "${work:?}"; }; trap cleanup EXIT
pick="${DATE:-$(store_list "$WHICH/$NAME/" | grep -E '\.dump\.gpg$' | sort | tail -1 | sed 's/\.dump\.gpg$//')}"
[ -n "$pick" ] || { echo "::error::No $WHICH backups of $NAME found."; exit 1; }
src="$WHICH/$NAME/$pick"; echo "Drilling $src"
store_get "$src.dump.gpg" "$work/db.dump.gpg"; store_get "$src.manifest.txt" "$work/manifest.txt"; store_get "$src.counts.tsv.gpg" "$work/counts.tsv.gpg"

# 1. Not tampered with: the fingerprint matches the one written when it was made.
want="$(grep '^sha256=' "$work/manifest.txt" | cut -d= -f2)"; got="$(sha256sum "$work/db.dump.gpg" | cut -d' ' -f1)"
[ "$want" = "$got" ] || { echo "::error::$src has changed since it was made (fingerprint mismatch). Don't trust it."; exit 1; }
# 2. Decrypt (also proves the passphrase works).
dec() { printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 -o "$2" -d "$1"; }
dec "$work/db.dump.gpg" "$work/db.dump" || { echo "::error::Couldn't decrypt $src: wrong passphrase or damaged file."; exit 1; }
dec "$work/counts.tsv.gpg" "$work/counts.tsv"

# 3. Restore into the empty database: Supabase's roles first, then the copy.
"$PSQL" "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$here/supabase-roles.sql"
set +e; "$PG_RESTORE" --no-owner --no-privileges -d "$RESTORE_DB_URL" "$work/db.dump" 2> "$work/restore.log"; rc=$?; set -e
grep -E 'ERROR' "$work/restore.log" | grep -vE 'already exists|must be owner of extension|extension ".*" does not exist|schema "(extensions|graphql|realtime|vault|supabase_functions|net)" does not exist' > "$work/errors.log" || true
if [ -s "$work/errors.log" ]; then echo "::warning::pg_restore reported problems (exit $rc):"; head -20 "$work/errors.log"; fi

# 4. Every table has the same number of rows as when the backup was made.
bad=0; n=0
while IFS=$'\t' read -r table want; do
  n=$((n + 1))
  got="$("$PSQL" "$RESTORE_DB_URL" -Atc "select count(*) from public.\"$table\"" 2>/dev/null || echo missing)"
  if [ "$got" != "$want" ]; then echo "::error::$table: backup had $want rows, restore has $got"; bad=$((bad + 1)); fi
done < "$work/counts.tsv"
# 5. The relationships hold (e.g. no messages pointing at missing chats): checks for this database, if any.
if [ -f "$here/checks/$NAME.sql" ]; then "$PSQL" "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -q -f "$here/checks/$NAME.sql" || bad=$((bad + 1)); fi
[ "$bad" -eq 0 ] || { echo "::error::Restore drill of $src FAILED ($bad problems)."; exit 1; }
echo "Restore drill of $src passed: $n tables, every row count matches$( [ -f "$here/checks/$NAME.sql" ] && echo ', checks passed')."
