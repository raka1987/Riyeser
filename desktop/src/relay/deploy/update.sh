#!/usr/bin/env bash
# Update an installed Riyeser relay to the code in this folder (the deploy workflow copies the new relay/ folder to
# the server and runs this). Keeps the settings and secret, restarts, checks /health, and puts the old version back
# if the new one doesn't come up within 20 seconds. Calls in progress through this relay drop when it restarts;
# with a backup relay, Link Offices move to it within seconds and come back once this one answers.
#   sudo ./deploy/update.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo $0"; exit 1; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$HERE/server.js" ] && [ -d /opt/riyeser-relay/app ] || { echo "Run setup.sh first (no relay installed here)."; exit 1; }
node -e "require('$HERE/server.js')" || { echo "The new code doesn't load; nothing changed."; exit 1; }
OLD=$(node -p "require('/opt/riyeser-relay/app/package.json').version" 2>/dev/null || echo '?'); NEW=$(node -p "require('$HERE/package.json').version")
rm -rf /opt/riyeser-relay/app.new && cp -r "$HERE" /opt/riyeser-relay/app.new && rm -rf /opt/riyeser-relay/app.new/test /opt/riyeser-relay/app.new/data
rm -rf /opt/riyeser-relay/app.old && mv /opt/riyeser-relay/app /opt/riyeser-relay/app.old && mv /opt/riyeser-relay/app.new /opt/riyeser-relay/app
restart() { if [ -f /opt/riyeser-relay/app/deploy/docker-compose.yml ] && docker compose -f /opt/riyeser-relay/app/deploy/docker-compose.yml ps -q 2>/dev/null | grep -q .; then
  (cd /opt/riyeser-relay/app/deploy && docker compose --env-file /etc/riyeser-relay/relay.env up -d --build); else
  install -m 644 /opt/riyeser-relay/app/deploy/riyeser-relay.service /etc/systemd/system/riyeser-relay.service; systemctl daemon-reload; systemctl restart riyeser-relay; fi; }
healthy() { for i in $(seq 1 20); do curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
restart
if healthy; then echo "Updated the Riyeser relay $OLD → $NEW: $(curl -fsS http://127.0.0.1:8080/health)"; exit 0; fi
echo "The new version didn't start: putting $OLD back."
rm -rf /opt/riyeser-relay/app.bad && mv /opt/riyeser-relay/app /opt/riyeser-relay/app.bad && mv /opt/riyeser-relay/app.old /opt/riyeser-relay/app
restart; healthy && echo "Back on $OLD. The failed version is in /opt/riyeser-relay/app.bad (journalctl -u riyeser-relay)." ; exit 1
