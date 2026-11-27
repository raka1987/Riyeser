# The Riyeser relay (Link Office 1.3.0)

Riyeser Link Office runs the phones of one office network. The **Riyeser relay** joins several of them, and phones
that aren't in any office, into one phone system for a business:

```
                         ┌───────────────────────── Riyeser relay (relay.riyeser.com) ─────────────────────────┐
                         │  SIP federation (wss :443 /link/v1)   media relay (UDP 40000-49999)   TURN (coturn) │
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

The relay is **ours**: it runs on any Linux machine the owner controls — a small rented VPS (Sydney) or a mini PC in
the office — from the `relay/` folder (on the `main` branch, like `supabase/`). Nothing at run time depends on a third
party except DNS for the name and, if chosen, Let's Encrypt for the certificate (see *What stays external*).

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
- **Ring groups** (branches) come from the cloud plan (`relay_sync`, below). A site rings its own members and adds one
  relay branch; the relay sends the group call once to every other site that has a member connected, and to members'
  remote phones. Each site rings its own members. First to answer wins; the rest are cancelled.
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

### 4. TURN for browser and app calls (coturn)

coturn runs next to the relay with `use-auth-secret` (the TURN REST API). Passwords are made per signed-in person by
the database (`link_relay_turn(ws)`): username `<expiry>:<user id>`, password `base64(HMAC-SHA1(turn secret,
username))`, valid for 12 hours. No static password is ever in an app. Riyeser Link uses
`stun:` + `turn:` (UDP/TCP 3478) + `turns:` (TLS 5349) from the relay only. With no relay set up, calls use only the
computers' own addresses (fine on one network); Google's STUN servers are no longer used.

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

**Remote phones** (`link_relay_device_add`): a random username (`r` + 10 letters) and 20-letter password, shown
**once** on the website with a QR code. Only `HA1 = MD5(user:riyeser-relay:password)` is stored (what SIP digest
needs). Admins (two-step sign-in) can add one for anyone; members for their own extension. Removing it is immediate
(the relay drops its registration on the next sync).

### 6. The relay's address can change too

On a VPS the address is fixed. On the owner's own hardware it can change, so:

- the relay finds its public IP itself (in order: `RELAY_PUBLIC_IP`; a public address on its own network card; the
  router via NAT-PMP; the address Supabase saw its `relay_sync` come from) — no "what is my IP" service;
- it reports it in `relay_sync`, and Link Office / Riyeser Link get it from `link_relay_config(ws)` and try it if
  the name doesn't resolve;
- the built-in **dynamic DNS updater** (`relay/lib/ddns.js`) updates the `relay.riyeser.com` A record through the DNS
  provider's own API (Cloudflare or DigitalOcean DNS) whenever it changes. No separate DDNS service.

### 7. Rate limits, logging, health

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

## Riyeser Link (website and app)

- WebRTC calls ask `link_relay_turn(ws)` for TURN details (cached for half their life) and use only those; with
  none, `iceServers: []` (computers' own addresses only).
- **Phones → Sites and the relay** (owners/admins): each Link Office (site) with its relay status, the switch
  "Connect our sites through the Riyeser relay", revoke/allow an office, and **Set up a phone at home or another site**:
  extension → name → the details (server `relay.riyeser.com`, port 5061, TLS, username, password — once) and a QR code
  for Linphone (a one-time set-up link, 15 minutes, served by the relay). Remote phones are listed with Remove.
- The "can't reach it yet / coming with the cloud version" wording now says: "A phone at home or at another site
  can, once the Riyeser relay is switched on (Phones → Sites and the relay)."

## Tests

- `relay/test/*.test.js` (`cd relay && npm test`): tokens and the SQL-made token, SDP rewriting, latching, the proxy
  (cross-site, groups, isolation, revoked, rate limits), TURN credentials against a **real coturn** when installed,
  remote phone over TLS, provisioning links.
- `desktop/test/link-relay.test.js`: Link Office's RelayTrunk and PBX against the real relay on this PC, with RTP both
  ways; reconnect after a public IP change; relay down → local calls still work and remote calls fail cleanly.
- `desktop/test/link-relay-nat.test.js`: the same with **two sites behind separate NATs** (Linux network namespaces
  and iptables masquerade, both sites on 192.168.1.0/24), run as root on Linux; skipped elsewhere.
- `website/team/test/rules-test.sql`: the relay RPCs (who can get tokens, revoke, devices, TURN, isolation).
