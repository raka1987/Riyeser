#!/usr/bin/env bash
# One-step set-up of a Riyeser relay on a fresh Ubuntu 24.04 machine: a rented server (VPS) or a PC / mini PC in the
# office. Run as root from the relay folder:   sudo ./deploy/setup.sh --domain relay.riyeser.com --region Sydney
#
#   --domain NAME        the relay's name (an A record pointing at this machine)          (default relay.riyeser.com)
#   --id ID              a short id, unique per relay: syd1, suva1, mel1 …                 (default from the region)
#   --region TEXT        shown to people ("Connected to Riyeser relay · Sydney")          (default Sydney)
#   --home               own hardware behind an office router: asks the router to forward the ports (UPnP/NAT-PMP),
#                        smaller port ranges, our own dynamic DNS (see --ddns-*), self-signed certificate (pinned)
#   --letsencrypt        get a certificate from Let's Encrypt with Caddy (needs ports 80 and 443 reachable)
#   --cert FILE --key FILE  use your own certificate instead
#   --backup --primary HOST  a backup relay: copies the secret from the main relay over SSH (root@HOST), or asks
#                        for it (hidden input) if SSH doesn't work
#   --docker             run in Docker (images built here from Ubuntu's node; see docker-compose.yml) instead of systemd
#   --supabase-url URL --supabase-key KEY   Riyeser online (default: Riyeser Link's project and publishable key)
#   --ddns-provider cloudflare|digitalocean --ddns-zone ZONE   (the token is asked for, hidden, never on the command line)
#   --ddns-provider namecheap [--ddns-host relay] [--ddns-domain riyeser.com]   Namecheap Dynamic DNS (host and domain
#                        default to --domain: relay2.riyeser.com -> relay2 + riyeser.com). The Dynamic DNS password
#                        (Namecheap → Advanced DNS → Dynamic DNS; not the account password) is asked for, hidden.
#                        Run again without --ddns-provider and the DNS settings already in relay.env are kept.
# Nothing outside is used at run time except DNS, and Let's Encrypt if you choose it. Safe to run again.
set -euo pipefail
DOMAIN=relay.riyeser.com; REGION=Sydney; ID=; HOME_MODE=0; LE=0; CERT=; KEY=; BACKUP=0; PRIMARY=; DOCKER=0
SB_URL=https://goaugynxeatzqzifpoes.supabase.co; SB_KEY=sb_publishable_-hYqz3gbSvsH-1rX_HLV4A_eSTp3XXL
DDNS_PROVIDER=; DDNS_ZONE=; DDNS_HOST=; DDNS_DOMAIN=; PRIORITY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=$2; shift ;; --id) ID=$2; shift ;; --region) REGION=$2; shift ;; --home) HOME_MODE=1 ;;
    --letsencrypt) LE=1 ;; --cert) CERT=$2; shift ;; --key) KEY=$2; shift ;; --backup) BACKUP=1; PRIORITY=2 ;; --primary) PRIMARY=$2; shift ;;
    --docker) DOCKER=1 ;; --supabase-url) SB_URL=$2; shift ;; --supabase-key) SB_KEY=$2; shift ;;
    --ddns-provider) DDNS_PROVIDER=$2; shift ;; --ddns-zone) DDNS_ZONE=$2; shift ;; --priority) PRIORITY=$2; shift ;;
    --ddns-host) DDNS_HOST=$2; shift ;; --ddns-domain) DDNS_DOMAIN=$2; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;; *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
  esac; shift
done
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo $0 $*"; exit 1; }
HERE=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$HERE/server.js" ] || { echo "Run this from the relay folder (it has server.js)."; exit 1; }
[ -z "$ID" ] && ID=$(echo "$REGION" | tr 'A-Z' 'a-z' | tr -cd 'a-z' | cut -c1-3)1
echo "$ID" | grep -Eq '^[a-z0-9-]{2,40}$' || { echo "--id must be 2-40 letters, numbers or dashes"; exit 2; }
case "$DDNS_PROVIDER" in ''|cloudflare|digitalocean|namecheap) ;; *) echo "--ddns-provider must be cloudflare, digitalocean or namecheap"; exit 2 ;; esac
if [ "$DDNS_PROVIDER" = namecheap ]; then
  [ -z "$DDNS_DOMAIN" ] && DDNS_DOMAIN=$(echo "$DOMAIN" | awk -F. 'NF>=2{print $(NF-1)"."$NF}')
  [ -z "$DDNS_HOST" ] && { case "$DOMAIN" in *".$DDNS_DOMAIN") DDNS_HOST=${DOMAIN%.$DDNS_DOMAIN} ;; *) DDNS_HOST=@ ;; esac; }
  echo "$DDNS_HOST" | grep -Eq '^(@|\*|[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?)$' || { echo "--ddns-host must be a name like relay (or @)"; exit 2; }
  echo "$DDNS_DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || { echo "--ddns-domain must be a domain like riyeser.com"; exit 2; }
fi
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/7 Packages (from Ubuntu's own archive)"
export DEBIAN_FRONTEND=noninteractive
NEED="nodejs openssl ufw ca-certificates curl"; [ "$LE" = 1 ] && NEED="$NEED caddy"; [ "$DOCKER" = 1 ] && NEED="$NEED docker.io docker-compose-v2"
MISSING=; for p in $NEED; do dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then apt-get update -qq && apt-get install -y -qq $MISSING >/dev/null; else echo "Already installed:$NEED"; fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "Node 18 or later is needed (Ubuntu 24.04 has it)."; exit 1; }

say "2/7 The relay's files (/opt/riyeser-relay/app) and user"
id riyeser-relay >/dev/null 2>&1 || useradd --system --home /var/lib/riyeser-relay --shell /usr/sbin/nologin riyeser-relay
install -d -o riyeser-relay -g riyeser-relay -m 750 /var/lib/riyeser-relay
install -d -m 750 -g riyeser-relay /etc/riyeser-relay /etc/riyeser-relay/tls
install -d /opt/riyeser-relay
rm -rf /opt/riyeser-relay/app.new && cp -r "$HERE" /opt/riyeser-relay/app.new && rm -rf /opt/riyeser-relay/app.new/test /opt/riyeser-relay/app.new/data
[ -d /opt/riyeser-relay/app ] && rm -rf /opt/riyeser-relay/app.old && mv /opt/riyeser-relay/app /opt/riyeser-relay/app.old
mv /opt/riyeser-relay/app.new /opt/riyeser-relay/app

say "3/7 The relay secret"
SECRET_FILE=/etc/riyeser-relay/secret
if [ ! -s "$SECRET_FILE" ]; then
  if [ "$BACKUP" = 1 ]; then
    if [ -n "$PRIMARY" ] && ssh -o BatchMode=yes -o ConnectTimeout=8 "root@$PRIMARY" 'cat /etc/riyeser-relay/secret' > "$SECRET_FILE.tmp" 2>/dev/null && [ -s "$SECRET_FILE.tmp" ]; then
      mv "$SECRET_FILE.tmp" "$SECRET_FILE"; echo "Copied the secret from the main relay ($PRIMARY) over SSH."
    else
      rm -f "$SECRET_FILE.tmp"
      echo "Couldn't copy it over SSH. On the main relay run:  sudo cat /etc/riyeser-relay/secret"
      read -r -s -p "Paste it here (hidden): " S; echo; printf '%s' "$S" > "$SECRET_FILE"
    fi
  else openssl rand -hex 32 | tr -d '\n' > "$SECRET_FILE"; echo "Made a new relay secret."; fi
fi
[ "$(wc -c < "$SECRET_FILE")" -ge 32 ] || { echo "The secret is too short."; rm -f "$SECRET_FILE"; exit 1; }
chmod 640 "$SECRET_FILE"; chgrp riyeser-relay "$SECRET_FILE"
TURN_SECRET=$(printf turn | openssl dgst -sha256 -hmac "$(cat "$SECRET_FILE")" -hex | awk '{print $NF}')
METRICS=$( [ -s /etc/riyeser-relay/metrics-token ] && cat /etc/riyeser-relay/metrics-token || openssl rand -hex 16 | tee /etc/riyeser-relay/metrics-token ); chmod 600 /etc/riyeser-relay/metrics-token
DDNS_TOKEN=; DDNS_PASSWORD=; ENVF=/etc/riyeser-relay/relay.env
old() { [ -f "$ENVF" ] && sed -n "s/^$1=\"\(.*\)\"\$/\1/p" "$ENVF" | tail -1; true; }
if [ "$DDNS_PROVIDER" = namecheap ]; then
  echo "Namecheap Dynamic DNS for $DDNS_HOST.$DDNS_DOMAIN. The password is on Namecheap: Domain List → Manage $DDNS_DOMAIN →"
  echo "Advanced DNS → Dynamic DNS (turn it on, copy the password). It is NOT your Namecheap account password."
  read -r -s -p "Dynamic DNS password (hidden, kept only in $ENVF): " DDNS_PASSWORD || true; echo
  [ -n "$DDNS_PASSWORD" ] || { echo "No Dynamic DNS password given."; exit 2; }
  printf '%s' "$DDNS_PASSWORD" | grep -Eq '^[^[:space:]"$`\\]{8,200}$' || { echo "That doesn't look like a Dynamic DNS password (no spaces or quotes)."; exit 2; }
elif [ -n "$DDNS_PROVIDER" ]; then read -r -s -p "DNS API token for $DDNS_PROVIDER (hidden, kept in $ENVF): " DDNS_TOKEN || true; echo
else
  # running again: keep the DNS settings already there
  DDNS_PROVIDER=$(old DDNS_PROVIDER); DDNS_ZONE=$(old DDNS_ZONE); DDNS_TOKEN=$(old DDNS_TOKEN)
  DDNS_HOST=$(old DDNS_HOST); DDNS_DOMAIN=$(old DDNS_DOMAIN); DDNS_PASSWORD=$(old DDNS_PASSWORD)
  [ -n "$DDNS_PROVIDER" ] && echo "Keeping the dynamic DNS settings ($DDNS_PROVIDER) already in $ENVF."
fi

say "4/7 Certificate"
TLS_CERT=; TLS_KEY=; HTTPS_PORT=443; SELF=1
if [ -n "$CERT" ] && [ -n "$KEY" ]; then
  install -m 644 "$CERT" /etc/riyeser-relay/tls/fullchain.pem; install -m 640 -g riyeser-relay "$KEY" /etc/riyeser-relay/tls/privkey.pem
  TLS_CERT=/etc/riyeser-relay/tls/fullchain.pem; TLS_KEY=/etc/riyeser-relay/tls/privkey.pem; SELF=0; echo "Using your certificate."
elif [ "$LE" = 1 ]; then
  HTTPS_PORT=; SELF=0
  cat > /etc/caddy/Caddyfile <<EOC
# Riyeser relay: Let's Encrypt certificate for $DOMAIN, and HTTPS / WebSockets passed to the relay.
$DOMAIN {
	reverse_proxy 127.0.0.1:8080
}
EOC
  systemctl enable --now caddy >/dev/null; systemctl reload caddy || true
  # Caddy keeps the certificate; a daily job copies it where the relay (SIP over TLS, TURN over TLS) can read it
  cat > /usr/local/sbin/riyeser-relay-cert <<EOC
#!/bin/sh
D=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$DOMAIN
[ -s "\$D/$DOMAIN.crt" ] || exit 0
install -m 644 "\$D/$DOMAIN.crt" /etc/riyeser-relay/tls/fullchain.pem
install -m 640 -g riyeser-relay "\$D/$DOMAIN.key" /etc/riyeser-relay/tls/privkey.pem
EOC
  chmod 755 /usr/local/sbin/riyeser-relay-cert
  printf '[Unit]\nDescription=Copy the relay certificate from Caddy\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/riyeser-relay-cert\n' > /etc/systemd/system/riyeser-relay-cert.service
  printf '[Unit]\nDescription=Copy the relay certificate from Caddy daily\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=12h\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/riyeser-relay-cert.timer
  systemctl daemon-reload; systemctl enable --now riyeser-relay-cert.timer >/dev/null
  for i in $(seq 1 30); do /usr/local/sbin/riyeser-relay-cert; [ -s /etc/riyeser-relay/tls/fullchain.pem ] && break; sleep 4; done
  TLS_CERT=/etc/riyeser-relay/tls/fullchain.pem; TLS_KEY=/etc/riyeser-relay/tls/privkey.pem
  [ -s "$TLS_CERT" ] && echo "Let's Encrypt certificate ready." || echo "The certificate isn't there yet (is the DNS record pointing here, and ports 80/443 open?). The relay uses it as soon as it is."
else echo "Self-signed certificate (made by the relay on first start). Link Office checks its fingerprint, which the relay reports to Riyeser online."; fi

say "5/7 Settings (/etc/riyeser-relay/relay.env)"
if [ "$HOME_MODE" = 1 ]; then MEDIA="40002 40201"; TURNR="40202 40301"; PORTMAP=1; else MEDIA="40002 49999"; TURNR="50000 50999"; PORTMAP=0; fi
set -- $MEDIA; MMIN=$1; MMAX=$2; set -- $TURNR; TMIN=$1; TMAX=$2
umask 027
cat > /etc/riyeser-relay/relay.env <<EOC
# Riyeser relay settings (made by setup.sh). Keep this file private: it points at the secret and holds the DNS token
# or Namecheap Dynamic DNS password (root and the relay only).
RELAY_ID="$ID"
RELAY_REGION="$REGION"
RELAY_HOST="$DOMAIN"
RELAY_SECRET_FILE="$SECRET_FILE"
SUPABASE_URL="$SB_URL"
SUPABASE_KEY="$SB_KEY"
HTTP_PORT="8080"
HTTP_BIND="127.0.0.1"
HTTPS_PORT="$HTTPS_PORT"
SIP_TLS_PORT="5061"
TLS_CERT="$TLS_CERT"
TLS_KEY="$TLS_KEY"
SELF_SIGNED="$SELF"
CERT_DIR="/var/lib/riyeser-relay"
MEDIA_MIN="$MMIN"
MEDIA_MAX="$MMAX"
PROBE_PORT="40000"
TURN_PORT="3478"
TURNS_PORT="5349"
TURN_MIN="$TMIN"
TURN_MAX="$TMAX"
PORT_MAP="$PORTMAP"
METRICS_TOKEN="$METRICS"
DDNS_PROVIDER="$DDNS_PROVIDER"
DDNS_ZONE="$DDNS_ZONE"
DDNS_NAME="$DOMAIN"
DDNS_TOKEN="$DDNS_TOKEN"
DDNS_HOST="$DDNS_HOST"
DDNS_DOMAIN="$DDNS_DOMAIN"
DDNS_PASSWORD="$DDNS_PASSWORD"
EOC
chown root:riyeser-relay /etc/riyeser-relay/relay.env; chmod 640 /etc/riyeser-relay/relay.env

say "6/7 Firewall (ufw)"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 5061/tcp >/dev/null; ufw allow 5349/tcp >/dev/null
ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null; ufw allow 40000/udp >/dev/null
ufw allow "$MMIN:$MMAX/udp" >/dev/null; ufw allow "$TMIN:$TMAX/udp" >/dev/null
ufw --force enable >/dev/null; echo "Open: 22, 80, 443, 5061, 5349 TCP; 3478 UDP+TCP; 40000, $MMIN-$MMAX, $TMIN-$TMAX UDP."

say "7/7 Start"
if [ "$DOCKER" = 1 ]; then
  (cd /opt/riyeser-relay/app/deploy && docker compose --env-file /etc/riyeser-relay/relay.env up -d --build)
else
  install -m 644 /opt/riyeser-relay/app/deploy/riyeser-relay.service /etc/systemd/system/riyeser-relay.service
  systemctl daemon-reload; systemctl enable riyeser-relay >/dev/null; systemctl restart riyeser-relay
fi
ok=0; for i in $(seq 1 20); do if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then ok=1; break; fi; sleep 1; done
[ "$ok" = 1 ] && echo "The relay is running: $(curl -fsS http://127.0.0.1:8080/health)" || { echo "The relay didn't start. See: journalctl -u riyeser-relay -n 50"; exit 1; }

IP=$(curl -fsS http://127.0.0.1:8080/health >/dev/null && node -e "const os=require('os');const a=Object.values(os.networkInterfaces()).flat().find(x=>x&&x.family==='IPv4'&&!x.internal);console.log(a?a.address:'')")
IPNOTE=; [ -n "$IP" ] && IPNOTE=" (this machine says $IP; on a home connection use the router's outside address)"
PF=; [ "$HOME_MODE" = 1 ] && PF="Port forwarding: if the router didn't accept automatic forwarding (journalctl -u riyeser-relay | grep 'port forwarding'), forward these to this PC: TCP 443, 5061, 5349, 3478; UDP 3478, 40000, $MMIN-$MMAX, $TMIN-$TMAX.
     "
DNSNOTE="an A record  $DOMAIN  →  this machine's public address$IPNOTE."
[ "$DDNS_PROVIDER" = namecheap ] && DNSNOTE="Namecheap keeps $DDNS_HOST.$DDNS_DOMAIN pointing here (Advanced DNS needs an \"A + Dynamic DNS Record\" with host $DDNS_HOST). Check: journalctl -u riyeser-relay | grep DNS"
[ -n "$DDNS_PROVIDER" ] && [ "$DDNS_PROVIDER" != namecheap ] && DNSNOTE="the relay keeps $DOMAIN pointing here through $DDNS_PROVIDER. Check: journalctl -u riyeser-relay | grep DNS"
umask 077
printf "select relay_register('%s', '%s', '%s', '%s', %s);\n" "$ID" "$DOMAIN" "$REGION" "$(cat "$SECRET_FILE")" "$PRIORITY" > /etc/riyeser-relay/REGISTER.sql
cat <<EON

Done. Three things left (see relay/README.md):
  1. DNS: ${DNSNOTE}
  2. Riyeser online (once per relay): open Supabase → SQL editor and run the line in
       sudo cat /etc/riyeser-relay/REGISTER.sql
     (it holds the secret: paste it only into the SQL editor, never into chat or email).
  3. ${PF}Check from outside:  curl https://$DOMAIN/health   (or -k with a self-signed certificate)
Metrics:  curl -H "Authorization: Bearer \$(sudo cat /etc/riyeser-relay/metrics-token)" http://127.0.0.1:8080/metrics
EON
