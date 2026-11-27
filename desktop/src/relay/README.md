# The Riyeser relay

Joins a business's **Riyeser Link Office** sites (Suva office, Nadi branch …) and **phones at home** into one phone
system, and gives **Riyeser Link** (browser and app calls) its own STUN/TURN. It's ours: it runs on any machine
Riyeser controls — the head office's always-on **Windows PC or mini PC** (the main relay, first) and a small
**rented server** (the backup, next). The design is in `desktop/RELAY.md` on the `module/desk-assistant` branch.

| What | How |
|---|---|
| Sites (Link Office) | each keeps one **outgoing** `wss://<relay>/link/v1` connection (no port forwarding at the sites; fine behind CGNAT; follows IP changes) |
| Calls between sites | SIP routed by the relay, only within one business; call sound goes phone → relay → phone (UDP, "latching", works through any NAT) |
| Phones at home | SIP over TLS straight to the relay (port 5061), own username and password per phone (made on the website) |
| Browser / app calls | the relay's own STUN/TURN (UDP/TCP 3478), 12-hour passwords from the database; no Google STUN |
| Failover | the business has a main relay and backups; sites move to a backup within seconds and come back by themselves; relays of the cluster pass calls between each other |
| Trust | one relay secret per cluster, shared with the database once (`relay_register`); short-lived passes for everything else |

No dependencies: Node 18 or later (Ubuntu 24.04's own `nodejs`, or the Node inside Riyeser Link Office on Windows).

## What stays external

- **The internet and DNS**: a DNS record for the relay's name at your DNS host (Cloudflare or wherever `riyeser.com`
  is). The relay can keep it up to date itself (own-hardware mode, below).
- **Supabase** (Riyeser online, already used for everything else): the relay checks in every 30 seconds. If it can't,
  it carries on with the last plan.
- **Let's Encrypt**, only if you choose `--letsencrypt` (certificate issuance; nothing passes through it). Otherwise
  the relay makes its own certificate and Link Office checks its fingerprint (from Riyeser online).
- Nothing else: no outside STUN/TURN, SIP or media services, no "what is my IP" services (the relay asks the router
  over NAT-PMP, or Supabase tells it the address it called from), no Docker Hub unless you choose `--docker`.

## 1. The main relay on the head office PC (Windows)

1. Pick the PC that's always on (the Riyeser Link Office PC is fine). Give it a fixed address in the router (a DHCP
   reservation; Link Office's *Settings → This PC's address* shows how, router by router).
2. In **PowerShell as administrator**, from the `relay` folder (or `…\resources\app\src\relay` in Riyeser Link Office):
   ```powershell
   .\deploy\windows\install-relay.ps1 -LinkOffice -Domain relay.riyeser.com -Region "Suva head office" -Id suva1
   ```
   `-LinkOffice` uses the Node inside Riyeser Link Office (nothing else to install); without it, it uses `node.exe`.
   It installs a background task **Riyeser Relay** (starts at boot as SYSTEM, restarts itself), Windows Firewall
   rules for its ports, a self-signed certificate, and asks the router to forward the ports (UPnP / NAT-PMP).
3. **Router port forwarding** — only if the log says the router didn't accept it (`C:\ProgramData\Riyeser Relay\logs\relay.log`).
   Forward to this PC: **TCP 443, 5061, 5349, 3478** and **UDP 3478, 40000, 40002–40201, 40202–40301**.
   Usually *Advanced → NAT / Port forwarding / Virtual servers*: TP-Link *Advanced → NAT Forwarding → Virtual Servers*;
   ASUS *WAN → Virtual Server*; NETGEAR *Advanced → Port Forwarding*; MikroTik *IP → Firewall → NAT (dstnat)*;
   FRITZ!Box *Internet → Permit Access → Port Sharing*; an internet provider's modem: ask them, or put it in bridge mode.
   If the office is behind CGNAT (the router's WAN address starts 100.64–100.127 or isn't the one websites see), port
   forwarding can't work: ask the provider for a public IP, or use a rented server as the main relay.
4. **DNS**: an A record `relay.riyeser.com` → the office's public address. If that address changes, let the relay
   update it: add to `C:\ProgramData\Riyeser Relay\relay.env` (Linux: `/etc/riyeser-relay/relay.env`)
   `DDNS_PROVIDER="cloudflare"`, `DDNS_ZONE="<zone id>"`, `DDNS_TOKEN="<token with Zone → DNS → Edit for that zone only>"`
   and restart it. (DigitalOcean DNS works too: `digitalocean`, zone = `riyeser.com`.) Link Office also learns the
   relay's current address from Riyeser online, so a stale DNS record doesn't stop it.
5. **Register it** (once): open Supabase → SQL editor, paste the line from `C:\ProgramData\Riyeser Relay\REGISTER.sql`
   and run it. It holds the secret: paste it only there, never into chat or email.

## 2. The backup relay on a rented server (Linux)

1. Rent a small server in **Sydney**: DigitalOcean *Basic Droplet, 1 vCPU / 1 GB, Ubuntu 24.04, SYD1* (~US$6/month), or
   Vultr *Cloud Compute 1 GB, Sydney* (~US$5–6), or AWS Lightsail *1 GB, Sydney* (~US$5–7). 2 GB (~US$12) if many
   businesses use it. Add your SSH key when creating it.
2. DNS: an A record `relay2.riyeser.com` → the server's address.
3. On the server: `git clone` the repository (or copy the `relay` folder), then
   ```bash
   sudo ./relay/deploy/setup.sh --backup --primary relay.riyeser.com --domain relay2.riyeser.com --region Sydney --id syd1
   ```
   `--backup` copies the main relay's secret (over SSH from a Linux main relay, or it asks for it — on Windows it's in
   `C:\ProgramData\Riyeser Relay\secret`). Add `--letsencrypt` for a Let's Encrypt certificate (Caddy, from Ubuntu's
   own archive), or `--cert/--key` for your own. Without either, it uses its own certificate (pinned by Link Office).
4. Register it: `sudo cat /etc/riyeser-relay/REGISTER.sql` → Supabase SQL editor (priority 2 = backup).
5. Automatic updates: in GitHub → Settings → Secrets → Actions add `RELAY_HOST` (or `RELAY_BACKUP_HOST`) and
   `RELAY_SSH_KEY` (a key whose public half is in the server's `/root/.ssh/authorized_keys`). `deploy-relay.yml` then
   tests and deploys every change to `relay/` (it does nothing, with a notice, until they're there). By hand:
   `sudo ./relay/deploy/update.sh` (restarts, checks, rolls back if the new version doesn't start).

A main relay on Linux at the office: `sudo ./deploy/setup.sh --home --domain relay.riyeser.com --region "Suva head office" --id suva1`.

### Ports

| Port | For | Needed on |
|---|---|---|
| TCP 443 | Link Office sites (wss), set-up links, `/health` | every relay |
| TCP 5061 | phones at home (SIP over TLS) | every relay |
| UDP/TCP 3478, TCP 5349 | STUN/TURN for browser and app calls (5349 only with a trusted certificate) | every relay |
| UDP 40000 | Link Office's "can sound get through?" check | every relay |
| UDP 40002–49999 (home: 40002–40201) | call sound between sites | every relay |
| UDP 50000–50999 (home: 40202–40301) | TURN relayed addresses | every relay |
| TCP 80 | Let's Encrypt only | with `--letsencrypt` |

Sites need nothing open: only outgoing TCP 443 and UDP to the relay's ports (allowed by almost every router).

## 3. Switch it on for a business

Riyeser Link → **Phones → Sites and the Riyeser relay** → *Connect our sites through the Riyeser relay* (an owner or
admin with two-step sign-in). Each Link Office (1.3.0 or later) connects within 5 minutes. *Set up a phone at home or
another site* makes a phone's details and a QR code for Linphone.

## Checking on it

- `curl -k https://relay.riyeser.com/health` → `{"ok":true,"relay":"syd1","sites":3,"phones":1,"calls":0,…}`
- `curl -H "Authorization: Bearer <metrics token>" http://127.0.0.1:8080/metrics` (on the relay) — Prometheus text.
- Logs: `journalctl -u riyeser-relay` / `C:\ProgramData\Riyeser Relay\logs\relay.log`. Who connected, extensions and
  call outcomes only — never call sound, SDP, passwords or passes.
- On a Link Office PC: *Settings → Connect your branches → Diagnostics*.

## Cost

| | Monthly |
|---|---|
| Main relay on the head office PC | US$0 (the PC is already on; uses the office internet: ~85 kbit/s each way per cross-site call) |
| Backup relay, 1 GB server in Sydney | ~US$5–7 (DigitalOcean US$6, Vultr US$5–6, Lightsail US$5–7); ~US$12 for 2 GB |
| DNS | what you pay now |
| Bandwidth | included (1 TB+/month covers ~2,500 hours of cross-site calls) |

## Files

- `server.js` — starts everything; `lib/proxy.js` SIP routing; `lib/media.js` call sound; `lib/turn.js` STUN/TURN;
  `lib/tokens.js` keys and passes; `lib/cloud.js` relay_sync; `lib/ws.js` WebSocket; `lib/certgen.js` self-signed
  certificate; `lib/publicip.js`, `lib/ddns.js`, `lib/portmap.js` own-hardware mode.
- `deploy/setup.sh`, `deploy/update.sh`, `deploy/riyeser-relay.service`, `deploy/Dockerfile`, `deploy/docker-compose.yml`,
  `deploy/windows/install-relay.ps1`.
- `test/` — `npm test` (with coturn's `turnutils_uclient` installed, the TURN server is also checked against it).
- The same code is in `desktop/src/relay/` on `module/desk-assistant` (for the Windows install with Riyeser Link Office).
