# Where backups live. In GitHub Actions: Cloudflare R2 (S3-compatible) through the aws command.
# For testing: set LOCAL_STORE to a folder and the same commands use plain files.
# Paths are always "<daily|monthly>/<name>/<file>" made by the scripts; a missing part stops the script.
store_put()  { if [ -n "${LOCAL_STORE:-}" ]; then mkdir -p "${LOCAL_STORE:?}/$(dirname "${2:?}")" && cp "${1:?}" "${LOCAL_STORE:?}/${2:?}";
               else aws s3 cp --only-show-errors --endpoint-url "${R2_ENDPOINT:?}" "${1:?}" "s3://${R2_BUCKET:?}/${2:?}"; fi; }
store_get()  { if [ -n "${LOCAL_STORE:-}" ]; then cp "${LOCAL_STORE:?}/${1:?}" "${2:?}";
               else aws s3 cp --only-show-errors --endpoint-url "${R2_ENDPOINT:?}" "s3://${R2_BUCKET:?}/${1:?}" "${2:?}"; fi; }
# File names (one per line) under a prefix, e.g. daily/team/
store_list() { if [ -n "${LOCAL_STORE:-}" ]; then ls -1 "${LOCAL_STORE:?}/${1:?}" 2>/dev/null || true;
               else aws s3 ls --endpoint-url "${R2_ENDPOINT:?}" "s3://${R2_BUCKET:?}/${1:?}" | awk '{print $4}'; fi; }
# Remove one old backup file (only ever called with daily/<name>/<file> or monthly/<name>/<file>).
store_rm()   { case "${1:?}" in daily/?*/?*|monthly/?*/?*) ;; *) echo "refusing to remove '$1'" >&2; return 1 ;; esac
               if [ -n "${LOCAL_STORE:-}" ]; then rm -f -- "${LOCAL_STORE:?}/${1:?}";
               else aws s3 rm --only-show-errors --endpoint-url "${R2_ENDPOINT:?}" "s3://${R2_BUCKET:?}/${1:?}"; fi; }
