#!/usr/bin/env bash
# Nightly backup of one online database (a Supabase project), encrypted, stored off-site.
#   NAME                 short name, e.g. team or asbuilt (the folder it's stored under)
#   DB_URL               the database's connection string (a GitHub secret; never printed)
#   BACKUP_PASSPHRASE    the encryption passphrase (a GitHub secret; also kept by the owner, offline)
#   R2_ENDPOINT, R2_BUCKET + AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY  where it goes (or LOCAL_STORE for tests)
# Keeps a copy for each of the last 30 days and one for each of the last 12 months.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; . "$here/store.sh"
: "${NAME:?}" "${DB_URL:?}" "${BACKUP_PASSPHRASE:?}"
PG_DUMP="${PG_DUMP:-pg_dump}"; PSQL="${PSQL:-psql}"; PG_RESTORE="${PG_RESTORE:-pg_restore}"
work="$(mktemp -d)"; cleanup() { rm -rf -- "${work:?}"; }; trap cleanup EXIT
day="$(date -u +%F)"; month="$(date -u +%Y-%m)"

# 1. The copy: our data (public), sign-ins (auth) and file records (storage), without owners or grants.
schemas=(-n public -n auth)
"$PSQL" "$DB_URL" -Atc "select 1 from pg_namespace where nspname = 'storage'" | grep -q 1 && schemas+=(-n storage)
"$PG_DUMP" "$DB_URL" -Fc --no-owner --no-privileges "${schemas[@]}" -f "$work/db.dump"

# 2. Check it's a real, complete copy before it's stored.
tables="$("$PG_RESTORE" --list "$work/db.dump" | grep -c ' TABLE DATA ' || true)"
size="$(stat -c %s "$work/db.dump")"
if [ "$size" -lt 2048 ] || [ "$tables" -lt 1 ]; then echo "::error::$NAME backup looks empty ($size bytes, $tables tables). Not stored."; exit 1; fi
# Row counts of every table in public, to check restores against.
"$PSQL" "$DB_URL" -At -F $'\t' -c "select c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) n from public.%I', c.relname), false, true, '')))[1]::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1" > "$work/counts.tsv"

# 3. Encrypt (AES-256). Without the passphrase the files are useless to anyone who gets them.
enc() { printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
          --symmetric --cipher-algo AES256 -o "$2" "$1"; }
enc "$work/db.dump" "$work/db.dump.gpg"
enc "$work/counts.tsv" "$work/counts.tsv.gpg"
sha="$(sha256sum "$work/db.dump.gpg" | cut -d' ' -f1)"
{ echo "name=$NAME"; echo "created=$(date -u +%FT%TZ)"; echo "bytes=$(stat -c %s "$work/db.dump.gpg")"; echo "sha256=$sha"
  echo "tables_with_data=$tables"; echo "pg_dump=$("$PG_DUMP" --version)"; } > "$work/manifest.txt"

# 4. Store: today's copy, and on the 1st of the month (or when asked) the month's copy too.
dests=("daily/$NAME/$day")
if [ "$(date -u +%d)" = "01" ] || [ "${FORCE_MONTHLY:-}" = 1 ]; then dests+=("monthly/$NAME/$month"); fi
for dest in "${dests[@]}"; do
  store_put "$work/db.dump.gpg" "$dest.dump.gpg"
  store_put "$work/counts.tsv.gpg" "$dest.counts.tsv.gpg"
  store_put "$work/manifest.txt" "$dest.manifest.txt"
done
echo "Stored $NAME backup for $day ($(numfmt --to=iec "$size") before encryption, $tables tables with data) in: ${dests[*]}"

# 5. Tidy: daily copies older than 30 days, monthly copies older than 12 months.
cutoff_day="$(date -u -d "${TODAY:-now} - 30 days" +%F)"; cutoff_month="$(date -u -d "${TODAY:-now} - 12 months" +%Y-%m)"
store_list "daily/$NAME/" | while read -r f; do d="${f%%.*}"
  if [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [[ "$d" < "$cutoff_day" ]]; then store_rm "daily/$NAME/$f" && echo "Removed old daily $f"; fi; done
store_list "monthly/$NAME/" | while read -r f; do d="${f%%.*}"
  if [[ "$d" =~ ^[0-9]{4}-[0-9]{2}$ ]] && [[ "$d" < "$cutoff_month" ]]; then store_rm "monthly/$NAME/$f" && echo "Removed old monthly $f"; fi; done
exit 0
