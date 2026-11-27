# The Riyeser relay (Link Office 1.3.0)

Riyeser Link Office runs the phones of one office network. The **Riyeser relay** joins several of them, and phones
that aren't in any office, into one phone system for a business:

```
                         ┌───────────────────────── Riyeser relay (relay.riyeser.com) ─────────────────────────┐
                         │  SIP federation (wss :443 /link/v1)   media relay (UDP 40000-49999)   STUN/TURN     │
                         │  SIPS for remote phones (:5061)       health /metrics                 :3478, :5349   │
                         └───────▲────────────────────▲───────────────────────▲──────────────────────▲─────────┘
            outbound wss, kept open│        outbound wss │       SIPS (TLS) from │      TURN for browser │
                                   │                     │       a phone at home │      and app calls    │
   Suva office ─ NAT ─ Link Office ┘   Nadi branch ─ NAT ─ Link Office          Softphone / desk phone   Riyeser Link
   (desk phones 101, 102)              (desk phones 201, 202)                    (extension 103, at home)  (WebRTC)
```

- **Calls inside one office stay inside it.** Nothing changes for them, and they keep working with no internet.
- **Calls between sites** go Link Office → relay → the other Link Office (signalling), and the sound goes phone →
  relay → phone (one UDP hop each way).
- **A phone at home** (or at a site with no Link Office PC) registers straight to the relay over TLS with its own
  device username and password, made on the website. It rings and dials like any desk phone of that business.
- **Browser and app calls** (Riyeser Link's WebRTC calls) use the relay's TURN server with short-lived passwords. No
  Google or other public STUN/TURN is used any more.

The relay is **ours**: it runs on any machine Riyeser controls — first the head office's always-on **Windows PC or
mini PC** (the main relay; a Windows service installed by `install-relay.ps1`, or from Link Office's *Settings →
Connect your branches → This PC as the relay*), then a small **rented Linux server** in Sydney as the backup
(`setup.sh`). The code is `relay/` on the `main` branch (like `supabase/`), with the same copy in `desktop/src/relay/`
for the Windows install. It has no dependencies (Node 18+, or the Node inside Link Office). Nothing at run time depends
on a third party except DNS for the name, Supabase (Riyeser online, already used) and, only if chosen, Let's Encrypt
for a certificate. No Google/public STUN, no third-party TURN or SIP/media services, no "what is my IP" services.

## Design decisions, and why

### 1. Every site connects out (WebSocket over TLS on 443)

Each Link Office opens **one outbound** `wss://relay.riyeser.com/link/v1` connection and keeps it open. Why:

- No port forwarding at the sites, works behind CGNAT, double NAT and hotel-style firewalls that only allow 443 out.
- A site's public IP can change at any time: the connection drops, Link Office reconnects (backoff 1 s, 2 s, 4 s …
  60 s, with jitter, and straight away when its own address or the network changes) and re-announces its extensions.
  The relay only ever addresses a site by its **office id**, never by its IP, so new calls work again within seconds.
- WebSocket goes through Caddy (TLS, HTTP/1.1 upgrade) with no special plugin, and carries both control messages
  (JSON text frames) and SIP messages (binary frames, one SIP message per frame), so SIP framing is never ambiguous.

Control messages:

| From | Message | Meaning |
|---|---|---|
| relay | `{t:'welcome', relay, region, rr, ip, probe, office, ws}` | accepted; `rr` is the relay's Record-Route, `ip` the media address, `probe` the UDP probe port |
| site | `{t:'exts', exts:['101','102'], groups:['100'], name:'Suva'}` | extensions with a phone connected here now (sent on connect and on change) |
| relay | `{t:'routes', remote:['201','103'], sites:[{office,name,exts,connected}]}` | what this site can reach through the relay |
| both | `{t:'ping', id, at}` / `{t:'pong', id, at}` | every 20 s; the round trip is shown as "42 ms" |
| relay | `{t:'bye', reason}` | then the relay closes (revoked, business switched off, replaced by a newer connection) |

### 2. The relay is a SIP proxy that only routes within one business

The relay is a small stateful, record-routing SIP proxy (Node, no dependencies, `relay/lib/proxy.js`), the same
style as Link Office's own (`src/link/pbx.js`). Because every hop to the relay is reliable (WebSocket or TLS), it has
no UDP retransmission timers.

- **Routing table**: for each business, which extensions are live at which site (from the sites' `exts` messages) and
  which remote phones are registered to the relay. An extension "lives" wherever its phone is connected; a person can
  have a desk phone in Suva and a softphone at home, and both ring.
- **Ring groups** ring only their chosen members (ring groups 1.2.2), wherever they are: the site where the call
  starts plans the group (all at once, in order, rotating) and, for each chosen member with a phone at another site or
  at home, adds one leg through the relay to that member's extension. A group call from a phone at home goes to each
  site with a chosen member (the relay's copy of the groups comes from `relay_sync`, `ring_groups` members only).
- **No loops**: a call that came from the relay is only ever rung locally by a Link Office (never sent back).
- **Business isolation is structural**: every table is keyed by the business (workspace id) of the authenticated
  connection. A site's INVITE can only ever be matched against its own business's sites and phones, and a request
  inside a call is refused unless it comes from one of that call's two endpoints. Call-IDs are keyed with the business.
- Emergency numbers are refused at the relay too ("No emergency calls - use a mobile or normal phone").

### 3. Sound between sites: the relay anchors the media (latching)

Options considered:

| Option | Verdict |
|---|---|
| Phones send sound to each other directly | Impossible across two NATs without ICE, which desk phones don't do. |
| Link Office relays its phones' sound through TURN allocations | Link Office would have to proxy every packet on the office PC, run a TURN client per call, and the PC becomes a media server. Complex and fragile. |
| **The relay rewrites the SDP to its own address and forwards packets (rtpengine-style, with latching)** | **Chosen.** |

How it works (`relay/lib/media.js`): for a cross-site call the relay gives each side its own UDP port (plus the next
port for RTCP) and rewrites `c=`/`m=` in the SDP it passes on, so each phone sends to the relay. When the first packet
arrives on a side's port, the relay **latches** onto its source address and port (the phone's NAT mapping) and sends
the other side's packets back to exactly that address. This is the standard way SIP carriers get through NAT:

- works behind any NAT (symmetric, CGNAT): the phone sends first, so its router opens the way back;
- phones need no ICE, STUN or settings; Link Office stays signalling-only ("the sound never passes through the PC");
- one hop, so the delay is site → Sydney → site;
- the payload is never looked at (G.711, G.722, Opus, video all pass), and it's never logged or stored.

Latching is protected: a side latches only from its connection's public IP (or, until something arrives from it, the
first packet), and re-latches mid-call only from that IP (so a site whose IP changed during a call can carry on once
it has reconnected). Unused sessions are closed after the call ends or after 2 minutes with no packets before answer.

Limit: the sound needs **UDP out** to the relay's ports 40000–49999. Almost every office router allows it. If a firewall
blocks it, the status screen says "Calls to other sites connect, but there may be no sound: the firewall blocks UDP to
the relay" (Link Office checks with a UDP probe to the relay's probe port on every connect).

### 4. STUN/TURN for browser and app calls (built into the relay)

The relay has its own STUN/TURN server (`relay/lib/turn.js`: RFC 5389/8489 STUN, RFC 5766/8656 TURN over UDP and TCP,
and TLS with a trusted certificate). It's built in rather than coturn because coturn doesn't run on Windows, where
the main relay lives; the tests check it against coturn's own client (`turnutils_uclient`) and with real Chrome
calls. Passwords are the TURN REST API kind (coturn's `use-auth-secret`, so coturn could replace it on Linux):
made per signed-in person by the database (`link_relay_turn(ws)`), username `<expiry>:<user id>`, password
`base64(HMAC-SHA1(turn secret, username))`, valid for 12 hours. No static password is ever in an app. It never relays
to private, loopback or link-local addresses (no way into the office network through it). Riyeser Link uses only
the business's relays (`stun:`, `turn:` UDP/TCP 3478, `turns:` 5349 with a trusted certificate); with no relay set
up, calls use only the computers' own addresses (fine on one network). Google's STUN servers are no longer used.

### 5. Trust: one secret, never in an app

`setup.sh` makes one random **relay secret** on the relay machine. Everything is derived from it with HMAC-SHA256:

- `turn secret = hex(HMAC(secret, "turn"))` — coturn's `static-auth-secret`;
- `office key = HMAC(secret, "office-token")` — signs Link Office tokens;
- `device key = HMAC(secret, "device-prov")` — signs one-time phone set-up links;
- `sync key` = the secret itself — signs the relay's own calls to Supabase (`relay_sync`).

The owner puts the same secret into the database **once**, in the Supabase SQL editor
(`select relay_register('relay.riyeser.com', 'Sydney', '<secret>')`). `relay_register` can't be called by apps (no
grants), and the secret column can't be read by anyone but the database's own functions.

**Office tokens** (`link_relay_token(ws, office_id)`, `team-chat.sql`): only someone who may report for that office
(owner/admin or a linked PC, as for the heartbeat), only when the business has the relay switched on and the office
isn't revoked. The token is `base64url(json).base64url(HMAC-SHA256(office key, …))` with
`{v, r: relay, ws, o: office, g: generation, exp: +6 h}`. The relay checks it on connect, without a database call.
**Revoking** (`link_relay_revoke`) bumps the office's generation; the relay learns it within 30 seconds from
`relay_sync` and closes that office's connection; old tokens no longer match. Switching the business off does the same
for all its offices.

**The relay ↔ database**: every 30 seconds the relay calls `relay_sync(relay, ts, sig, info)` with the public anon key
and `sig = HMAC(secret, relay|ts)` (5-minute window). It reports its version, public IP and counts (no call details),
and gets back, for each business with the relay on: its offices (generation, revoked), its remote phones (username,
extension, HA1 digest — never a password) and its ring groups. If Supabase can't be reached, the relay carries on with
the last copy (tokens still expire on time).

**1.3.1: one key per relay.** A relay set up with a set-up code (below) has **its own key** (`relay_servers.sync_key`,
64 hex, made by the database) and never sees the cluster secret: it signs `relay_sync` / `relay_leave` with its key and
gets the derived keys (office, device, peer, TURN — never the secret) back from `relay_sync` (`keys: {epoch, …}`).
**Removing a relay** (`relay_drop`: website Remove, the PC uninstalling itself, or another PC taking over) deletes its
row, so its key fails at once (`RELAY_REMOVED`), and **changes the cluster secret** (`relay_rotate`, epoch + 1): the
relays that stay take the new keys at their next sync (≤ 30 s) and drop the removed one's peer connection; passes and
peer logins made with keys copied from it stop working. A relay from before 1.3.1 keeps signing with the old secret
(it becomes its own key); the secret isn't changed while any relay that has checked in is older than 1.1.0. A business
left with no relay has the relay switched off (in its history).

**Remote phones** (`link_relay_device_add`): a random username (`r` + 10 letters) and 20-letter password, shown
**once** on the website with a QR code. Only `HA1 = MD5(user:riyeser-relay:password)` is stored (what SIP digest
needs). Admins (two-step sign-in) can add one for anyone; members for their own extension. Removing it is immediate
(the relay drops its registration on the next sync).

### 6. Failover: a main relay and backups

A business has an ordered list of relays (`relay_servers.priority`, or its own order in `link_relay_settings.relays`):
the head office PC first, a rented server next. All relays of the cluster share the one secret (a backup is installed
with `--backup`, which copies it), so each Link Office gets a pass for every relay in the list.

- **Link Office** connects to the first relay that answers. It pings every 3 s; no answer for 8 s (or the connection
  closes) and it moves to the next relay at once (the silent one is tried last for a minute). Measured in the NAT
  test: 3.8 s when the main relay goes silent, 0.2 s when it's killed outright.
- **Fail-back**: while on a backup, it tries the main relay every 30 s; once it answers, new calls go through it. The
  backup connection is kept ("draining", announcing no extensions) until the calls in progress have ended, so those
  calls aren't dropped.
- **Relays share routing state with each other**: each relay keeps a connection to every other relay of the cluster
  and tells it which offices and phones it has, per business. A call to an extension at a site on another relay goes
  site → relay A → relay B → site (both relays anchor the sound). So it doesn't matter if, for a while, Suva is on the
  main relay and Nadi on the backup (say only Nadi's internet can't reach the head office).
- **Trade-offs**: (1) calls in progress *through a relay that dies* drop (their signalling and sound were on it);
  new calls work within seconds. Calls in progress during a fail-back are kept. (2) Relay-to-relay calls cross two
  relays (a little more delay). (3) The routing state between relays is soft (rebuilt within seconds after a restart).
  (4) A relay dedicated to one business still holds the cluster secret, so it must be a machine Riyeser manages.
- **Riyeser Link apps**: get TURN details for every relay in the list (ICE tries them all), so a dead relay costs nothing.
- **Status**: "Connected to Riyeser relay · Suva head office · 2 ms" or "Using backup relay · Sydney · 41 ms" on the
  Link Office status screen, and per site on the Phones page.

### 7. The relay's address can change too

On a VPS the address is fixed. On the owner's own hardware it can change, so:

- the relay finds its public IP itself (in order: `RELAY_PUBLIC_IP`; a public address on its own network card; the
  router via NAT-PMP; the address Supabase saw its `relay_sync` come from) — no "what is my IP" service;
- it asks the office router to forward its ports (NAT-PMP, then UPnP IGD) and renews them; if the router doesn't
  allow it, the log and the README say which ports to forward by hand;
- it reports it in `relay_sync`, and Link Office / Riyeser Link get it from `link_relay_config(ws)` and try it if
  the name doesn't resolve;
- the built-in **dynamic DNS updater** (`relay/lib/ddns.js`) keeps the relay's A record pointing at it, at start,
  whenever the address changes, and every 30 minutes as a safety net. `riyeser.com` is at **Namecheap**, so that's
  `DDNS_PROVIDER=namecheap` with `DDNS_HOST` (`relay`, or `relay2` for the backup), `DDNS_DOMAIN` (`riyeser.com`) and
  `DDNS_PASSWORD` (the domain's Dynamic DNS password from Namecheap's Advanced DNS page, not the account password), via
  Namecheap's Dynamic DNS update (`dynamicdns.park-your-domain.com/update`, an "A + Dynamic DNS Record" per host).
  Cloudflare and DigitalOcean DNS (API token) work too. Namecheap's errors become plain messages in the log and in
  `/health` → `dns` (wrong password, no such record, domain not found; passing problems are retried every minute).
  The password is asked for hidden by `install-relay.ps1` / `setup.sh`, or pasted into Link Office's *This PC as the
  relay* (handed to the installer as a file in that run's temp folder, deleted at once), and kept only in `relay.env`
  (Administrators/SYSTEM; root and the relay's group). Never logged, never in `/health`. No separate DDNS service.

### 8. Rate limits, logging, health

- Per IP: 30 new connections a minute; 10 failed sign-ins (bad token, wrong phone password) block the IP for 15 minutes.
- Per connection: 400 SIP messages per 10 seconds, 64 KB per message, 200 extensions, 20 remote phones per business.
- Logs say who connected, which business and office, extension numbers and call outcomes (answered, busy …) — never
  SDP, audio, passwords or tokens.
- `GET /health` (public): `{ok, version, uptime, sites, phones, calls}`. `GET /metrics` (Prometheus text, needs the
  metrics token): connections, calls, media sessions, packets and bytes relayed, sign-in failures, sync age.

## Link Office 1.3.0

- **Settings → Connect your branches**: shows whether the business has the relay switched on (from
  `link_relay_config`), and this office's site name. The switch itself is on the website (Management → Phones), as it
  affects every site.
- `src/link/relay.js` (`RelayTrunk`, a trunk for `trunks.js`): gets a token (`link_relay_token`), connects, announces
  its connected extensions, measures the round trip, probes UDP, reconnects with backoff, and hands SIP between the
  relay and the PBX (`proto: 'TRUNK'`).
- `pbx.js`: an extension with no phone connected here, or a number not here at all, is tried through the relay when
  the relay says it can reach it. Group calls add one relay branch. Calls from the relay ring only local phones, and
  are trusted without a SIP password (the relay already checked them). Route sets with the relay in them work.
- **Status**: "Connected to Riyeser relay · Sydney · 42 ms" on the Phones tab, with the other sites; and in
  Settings → Diagnostics (state, last error, reconnects, the UDP probe result).
- **No relay, no internet**: local calls never depend on it. Calls to other sites get "Temporarily Unavailable (the
  other sites can't be reached: no connection to the Riyeser relay)", and the screen says so.
- The heartbeat adds `relay: {state, region, rtt_ms, since, error, udp}` (stored in `link_offices.relay`).

## Link Office 1.3.1: change or remove the relay PC, and the guided checklist

**Set up / move with a code, no DNS needed.** An owner or admin makes a one-time **set-up code** (`link_relay_enroll_code`,
two-step sign-in, 30 minutes, once) on the website (*Sites & relay → Add or move a relay PC*) or in Link Office's
Advanced checks. On the new PC, *Settings → Connect your branches → This PC as the relay* claims it
(`relay_enroll_claim`, no sign-in needed: the code is the permission) and gets **its own new key**, written to a file
for `install-relay.ps1 -RelayKeyFile … -NoDns` (deleted after reading). By default the relay has **no web name**
(`<id>.relay.invalid`, `relay_servers.dns = false`): sites connect to the public address it reports, trusted by its
certificate fingerprint (as before), and phones at home are given the address too. With *replaces*, the new relay
takes the old one's place, priority and web name, and the old one is removed when the new one **first checks in**
(so nothing breaks if the set-up doesn't finish). *Advanced: use your own web name* keeps the DNS options: Cloudflare
(an "Edit zone DNS" token, `DDNS_ZONE` the domain; the record is kept DNS only, grey cloud) or Namecheap Dynamic DNS;
Link Office looks up the domain's nameservers and preselects the provider.

**Stop using this PC as the relay** (relay PC, *Settings → Connect your branches*; owners and admins after unlocking
Advanced checks): the impact first (sites move to the next relay; with none, the relay is switched off for the
business), then **Move the relay to another PC** (a set-up code and the steps) or **Remove it**:
`install-relay.ps1 -Uninstall` with Windows' permission prompt — `relay_leave` (signed with its own key), the task
stopped and removed, the relay process stopped, the router port forwarding it made removed (the relay notes each
UPnP / NAT-PMP mapping in `portmaps.json`; `server.js --remove-port-mappings`), its firewall rules removed, its logs
zipped into `C:\ProgramData\Riyeser Relay Logs`, and `C:\ProgramData\Riyeser Relay` (key, settings, certificate)
deleted. The last line is `RESULT {json}`; Link Office shows what was done. **Uninstalling Link Office** from Windows'
Apps does the same when this PC is the relay (`build/link/installer.nsh`, not on an update). The Overview says
**"This PC is the relay"** so nobody wipes it by accident; a relay removed elsewhere says so and offers the clean-up.

**On the website** (*Management → Desk phones → Sites & relay*, owners and admins with two-step sign-in, scoped to the
business — `link_relay_manage`): each relay with main/backup, last seen and version; **Make it the main relay**,
**Stop using it / Use it again** (for this business; `link_relay_settings.off`), **Move to another PC**, and
**Remove** for relays the business looks after (`managed_by`; Riyeser's shared relays can only be switched off for the
business). Removing or switching off the last relay needs a second confirmation (`LAST_RELAY`) and switches the relay
off. `relay_register` / `relay_remove` stay for Riyeser's own use in the SQL editor.

**The guided checklist** (`renderer/link-relaycheck.js`, facts from `link/relaychecks.js`): on the relay PC — this PC
can be the relay (Windows, admin rights, disk, battery, sleep with a "Keep this PC awake" fix), relay service running,
address reserved in the router, router ports open **from outside** (another relay of the cluster connects back to the
listed public address on each port: `/check/outside`, peer messages `probe-me` / `probe-result`; automatic forwarding
first, per-router steps only when that failed), web name (only with your own name: missing, proxied through
Cloudflare, pointing elsewhere), secure connection (fingerprint), registered, switched on; on every site — internet,
can reach the relay (name, TCP, TLS + pin: says which failed), signed in and allowed, sound (UDP), extensions
announced, and a **test call**: a second of 1 kHz tone (G.711, 20 ms packets) through the relay's echo (`RYECHO1`
on the probe port, ≤ 64 packets a second per address), checking the tone comes back clearly, with round trip, jitter
and loss. A summary banner ("All good — 3 sites connected" / "1 thing needs attention: …"), and the Overview tile and
Needs attention link straight to the failing step. Results show quietly: no pop-ups asking to fix things; one Windows
notification only when calls to the other sites stop working (once). An office with no branches sees "Branches: not
used" and nothing else. Admins can dismiss a step for good.

**Advanced checks** (owners and admins: a Riyeser account with two-step sign-in, held in memory only, locked again after
15 minutes without use): each step on its own, test call / echo, test ports from outside, retry automatic forwarding,
re-register, reset this site's relay pass, use a chosen relay for now, raw details (public IP, ports, mappings, relays,
pass expiry, last errors, the relay's log) with "Copy for support", set-up codes. The same from the website, also on a
phone: each site's checklist (from `link_relay_report`'s `checks`, `test`, `host`) and **Advanced checks** sent to that
site's Link Office as `link_command` kind `relay_check` (`run_check`, `run_all`, `test_call`, `echo_test`,
`retry_upnp`, `reregister`, `reset_pass`, `force_relay`, `details`); results come back with `link_office_done` and show
as cards within seconds, and every one is in the history.

**A Riyeser-hosted relay (not built; the hooks):** businesses that don't want their own PC could choose "Use Riyeser's
relay" with nothing to set up. Riyeser's own relays are rows with `workspace_id` null and `managed_by` null: every
business already sees them in `relay_list`, isolation is per business in the relay (sites, routes, phones) and in
`relay_sync`'s plan, and admins can make one their main relay or switch it off for themselves. What it would need:
rented servers in each region (the Linux `setup.sh --letsencrypt` path, with a real web name and certificate, so TURN
over TLS works in browsers), Riyeser registering them with the SQL editor's `relay_register` or a Riyeser-HQ-only
version of the set-up code, capacity monitoring per relay (`/metrics`), a per-business usage limit or price (relay
minutes / bandwidth) and its billing, and a "Use Riyeser's relay" switch in Sites & relay that sets the business's
order to Riyeser's relays. Nothing in the code assumes a business has its own relay.

## Riyeser Link (website and app)

- WebRTC calls ask `link_relay_turn(ws)` for TURN details (cached for half their life) and use only those; with
  none, `iceServers: []` (computers' own addresses only).
- **Phones → Sites and the relay** (owners/admins): each Link Office (site) with its relay status, the switch
  "Connect our sites through the Riyeser relay", revoke/allow an office, and **Set up a phone at home or another site**:
  extension → name → the details (server `relay.riyeser.com`, port 5061, TLS, username, password — once) and a QR code
  for Linphone (a one-time set-up link, 15 minutes, served by the relay). Remote phones are listed with Remove.
- The "can't reach it yet / coming with the cloud version" wording now says: "A phone at home or at another site
  can, once the Riyeser relay is switched on (Phones → Sites and the relay)."

## Packaging

- **Windows (main relay)**: `relay/deploy/windows/install-relay.ps1` — a scheduled task "Riyeser Relay" at boot as
  SYSTEM that restarts itself, Windows Firewall rules for its ports only, settings and secret in
  `C:\ProgramData\Riyeser Relay` (Administrators and SYSTEM only), Node from Link Office (`ELECTRON_RUN_AS_NODE`) or
  `node.exe`. Link Office 1.3.0 unpacks `src/relay/**` and offers it in Settings.
- **Linux (backup)**: `relay/deploy/setup.sh` (one step on a fresh Ubuntu 24.04: Ubuntu's own `nodejs`, a system user,
  systemd service, ufw, the secret, self-signed / Let's Encrypt via Caddy / own certificate, `--home` for own hardware,
  `--backup` to pair), `update.sh` (restart, health check, automatic roll-back), `deploy-relay.yml` (tests, then SSH
  deploy when `RELAY_HOST` and `RELAY_SSH_KEY` exist; otherwise a notice). Docker is optional (`--docker`), not needed.

## Tests

- `relay/test/*.test.js` (`cd relay && npm test`): passes (and one made by the SQL), the proxy (cross-site with sound,
  isolation, revoked, rate limits), a phone at home over TLS, two relays of a cluster, set-up links, health/metrics,
  the TURN server against coturn's own `turnutils_uclient` (UDP, TCP, expired and forged passwords refused), no TURN
  into private networks, dynamic DNS (`ddns.test.js`: a fake Namecheap endpoint — success, UTF-16 replies, wrong
  password, no such host, unknown domain, busy then retried, the relay setting relay2 at start and every N minutes,
  the password never in the log or `/health`), NAT-PMP/UPnP port mapping (pretend routers).
- `desktop/test/link-relay.test.js`: Link Office's RelayTrunk and PBX against the real relay on this PC, with RTP both
  ways; reconnect after a public IP change; relay down → local calls still work and remote calls fail cleanly.
- `desktop/test/link-relay-nat.test.js`: **two sites behind separate strict NATs** (Linux network namespaces, iptables
  masquerade with random ports, both on 192.168.1.0/24), a third business, a main and a backup relay: calls with RTP
  counted both ways, a site's public IP changing, isolation, revoking, failover (silent and killed), fail-back, both
  relays down. Root on Linux; skipped elsewhere.
- `website/team/test/relay-turn-test.js`: two headless Chromes with fake microphones behind separate NATs make a
  WebRTC call through the relay's TURN (relay candidates, sound packets both ways); expired TURN passwords and no TURN
  at all fail, as they should.
- `desk-assistant-windows.yml`, job `relay`: the relay installed as a Windows service on the CI runner, two Link
  Office sites calling through it with sound both ways, the service restarted, calls again.
- `website/team/test/relay-ui-test.js`: the Phones page section.
- `website/team/test/rules-test.sql`: the relay RPCs (who can get tokens, revoke, devices, TURN, isolation); 1.3.1: set-up
  codes (owners/admins with two-step only, once, never another business's relay), own keys (never the cluster secret),
  keys back from `relay_sync`, no web name (the address and pin), make main / switch off / remove (`link_relay_manage`,
  aal2, Riyeser's relay can't be removed, another business can't touch them), moving to a new PC (takes over at its
  first check-in, the old one refused with `RELAY_REMOVED`), the cluster secret changed on removal (and not while a
  relay is too old), the last relay switched off with a warning first, `relay_leave`, the checklist in reports and
  `relay_check` commands (only known fields, in the history).
- 1.3.1: `desktop/test/link-relay-remove.test.js` (uninstall script and its order, the installer hook, the set-up code,
  port mappings noted and removed, revocation within one sync and sites moving on, the move to a new PC, the test call,
  the checklist's states, remote checks, Advanced checks' lock, Cloudflare DNS); `link-relay-nat.test.js` adds the test
  call through a NAT and the ports tested from outside (one closed); `relay/test/remove.test.js`;
  `website/team/test/relay-remove-ui-test.js`; `desktop/test/e2e/relay-checklist-shots.js` (pictures). The Windows CI
  relay job installs, uninstalls (no task, firewall rules, port mappings or key left; logs zipped), installs again as
  a "new PC" and the sites reconnect and call.
