#!/usr/bin/env bash
# Tell Riyeser HQ how a job went: one row in the database (public.ops_record_run -> ops_job_runs), so HQ → Integrations
# shows the last backup, restore test and HQ jobs without reading GitHub (which stops answering once the code repository
# is private). Sizes, row counts and the backup's fingerprint only: never data, addresses or secrets.
# It never fails the job: no database, or one without ops_record_run yet (re-run team-chat.sql), just says "not recorded".
#   RECORD_DB_URL   where to record (the TEAM_DB_URL secret; never printed)
#   JOB             backup | restore_drill | hq_jobs
#   TARGET          which database the job was about: team (Riyeser Link) or asbuilt
#   OK              the job's result so far: success (anything else is recorded as failed)
#   STARTED         when the job started (UTC, e.g. 2026-11-28T15:40:00Z), optional
#   DETAIL_FILE     a small JSON file with sizes or counts, optional
set -uo pipefail
PSQL="${PSQL:-psql}"
[ -n "${RECORD_DB_URL:-}" ] || { echo "Not recorded in HQ: no database to record to."; exit 0; }
: "${JOB:?}"
ok=false; [ "${OK:-}" = success ] && ok=true
detail='{}'; if [ -n "${DETAIL_FILE:-}" ] && [ -s "$DETAIL_FILE" ]; then detail="$(head -c 1500 "$DETAIL_FILE")"; fi
url=""; [ -n "${GITHUB_RUN_ID:-}" ] && url="https://github.com/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID}"
have="$("$PSQL" "$RECORD_DB_URL" -X -q -At -c "select to_regprocedure('public.ops_record_run(text,text,boolean,timestamptz,jsonb,text)') is not null" 2>/dev/null)" \
  || { echo "::notice::Couldn't reach the database to record this run in HQ."; exit 0; }
[ "$have" = t ] || { echo "::notice::Not recorded in HQ yet: the database doesn't have ops_record_run (re-run website/team/team-chat.sql)."; exit 0; }
if "$PSQL" "$RECORD_DB_URL" -X -q -v ON_ERROR_STOP=1 -v job="$JOB" -v target="${TARGET:-team}" -v ok="$ok" -v started="${STARTED:-}" \
     -v detail="$detail" -v url="$url" >/dev/null 2>&1 <<'SQL'
select public.ops_record_run(:'job', :'target', :'ok'::boolean, nullif(:'started', '')::timestamptz, :'detail'::jsonb, nullif(:'url', ''));
SQL
then echo "Recorded in HQ: $JOB ($TARGET) $([ "$ok" = true ] && echo passed || echo failed)."
else echo "::notice::Couldn't record this run in HQ."; fi
exit 0
