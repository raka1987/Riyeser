# Riyeser Link Office

Riyeser Link is Riyeser's chat and calls (the app at riyeser.com/link, formerly Riyeser Team), a paid program since pricing v2
(it took in the old Riyeser Link). It includes calls and the office phone system, which comes in two forms:

- **Riyeser Link Office** runs on one PC in the office. That's this program, `Riyeser Link Office.exe`.
- **Riyeser Link Cloud** will be hosted by Riyeser, in a later phase.

Both use the same extensions, ring groups and desk-phone set-up. A business can move from one to the other without setting anything up again (see *Moving between Office and Cloud*).

Riyeser Link Office comes with **Riyeser Link** (the `calls` module of the Riyeser plan).

> **Internal calls only.** These phones can't call emergency services — keep a mobile or normal phone line for that.

## What it does

One office PC runs Riyeser Link Office. It:

- keeps everyone's extension (100–899) and the ring groups (each branch's number and any group with its own number, ringing only the people and phones chosen for it);
- lets the office's desk phones connect to it (SIP registration);
- connects calls between them.

There are no outside lines and no phone numbers. Dialling an outside number, or an emergency number (000, 111, 112, 911…), gets "No emergency calls - use a mobile or normal phone".

### How a call works

```
 Desk phone 101 ──SIP──▶ Riyeser Link Office (this PC) ──SIP──▶ Desk phone 102
        ▲                                                     │
        └──────────── sound (RTP), phone to phone ────────────┘
```

Riyeser Link Office handles the *signalling*: who's calling, ringing, answering and hanging up. The sound never passes through the PC. The SDP (the description of the sound) passes through unchanged, so the phones send sound to each other directly. That's why both phones must be on the same office network. If a phone connects from a different subnet, Riyeser Link Office notes it in the log, because that phone may have no sound.

### The dial plan

| Dial | What happens |
|---|---|
| `101`–`899` | That person's phones ring (desk phone and, later, the Riyeser Link app, all at once). |
| A ring group's number, e.g. a branch's `100` or Sales `300` | Only the people and shared desk phones chosen for that group ring: all at once, in order, or rotating (see *Ring groups with chosen members*). The first to answer gets the call; the others stop ringing. |
| `*78` / `*79` | Do not disturb on / off for your extension. Callers hear busy. |
| Anything else | "Not found", with a short reason on the phone's screen. |

Busy gives 486. A phone that isn't connected gives 480. "No answer" after 2 minutes gives 480.

### SIP features

Done:

- REGISTER with digest authentication (MD5, `qop=auth`). Each extension gets its own strong random password, which is kept on this PC and protected with Windows' own data protection.
- INVITE routing as a record-routing proxy, with provisional and final responses, ACK, BYE and CANCEL. Parallel forking for ring groups and for people with more than one phone.
- Pass-through of re-INVITE (hold), REFER (transfer), UPDATE, INFO and NOTIFY inside a call.
- OPTIONS keep-alives are answered.
- UDP and TCP on port 5060, with retransmission timers for UDP. NAT-friendly (`received`/`rport`).
- Plug-and-play SUBSCRIBE (`Event: ua-profile`) on 224.0.1.75.

Not done yet:

- No media relay, voicemail, call recording, music on hold, call parking, BLF/presence (SUBSCRIBE `dialog`), MWI, call forwarding, TLS/SRTP or IPv6.
- Transfer is passed through, not handled by Riyeser Link Office. A transfer works when the phones support REFER, which Yealink, Grandstream and Snom do.

## Supported phones, and plugging one in

Any standard SIP desk phone or app works when its details are typed in by hand. These makers set themselves up automatically:

| Maker | Settings file | Tested on real hardware? |
|---|---|---|
| Yealink (T3x, T4x, T5x) | `<mac>.cfg` | Not yet |
| Grandstream (GXP, GRP) | `cfg<mac>.xml` | Not yet |
| Snom (D-series) | `<mac>.xml` | Not yet |
| Polycom / Poly (VVX) | `<mac>.cfg` + `<mac>-riyeser.cfg` | Not yet |

The formats follow each maker's published provisioning documentation, and the tests check them with simulated phones. None has been tried on a real phone yet.

### Plugging in a desk phone

1. Plug the phone into a network socket on the same office network as this PC.
2. Many desk phones don't come with a power adapter and expect power over the network cable (PoE). Buy the phone's power adapter, or a small PoE switch.
3. Turn it on. The phone asks the network "who sets me up?" (SIP plug-and-play on 224.0.1.75). Riyeser Link Office answers with the address of its small settings server, on this PC at port 5080.
4. The phone shows on the status screen as **New phone found**. Choose who it's for. The phone fetches its settings (server address, extension, password, and the person's name as its label) and connects. If it hasn't done that within a minute, restart the phone.
5. Wi-Fi desk phones work too, once joined to the office Wi-Fi.
6. A phone in another building or at home connects through the **Riyeser relay** once the business switches it on (1.3.0; see `RELAY.md` and *Connect your branches* in the help).

Didn't appear? Use **Add a desk phone → Add phone** with the MAC address on the sticker under the phone. Or use **Set up a phone by hand** next to the person. It shows the server address (this PC's address), the username (the extension) and the password, to type into any SIP phone or app.

## The Phones page on the website (1.1.0)

Business owners and admins (and Riyeser support, when allowed) see and manage the desk phones at **riyeser.com/link → ☎ Phones** (from the Riyeser home tile, the **☎ Phones** button above the chat, or `riyeser.com/link/?phones`). Before 1.1.0 this was only on the office PC's own screen. The code is `src/link/cloud.js`. The database side is the section *Riyeser Link Office: status and phones* in `website/team/team-chat.sql`.

**Heartbeat.** Every 5 minutes, and a few seconds after something changes (a phone connects or is given to someone, the address changes), Riyeser Link Office calls `link_office_report(ws, office_id, payload)`. The payload holds:

- `office_id` (made once per install, in `phone-settings.json`), the PC name and version;
- the address(es) to type into phones, the SIP port, whether the address is stable, and the PC's MAC address (for a DHCP reservation);
- the licence state;
- counts: people, groups, phones given out, phones connected, new phones, app users, and calls in progress (a count only);
- the desk phones: MAC, maker and model, extension, connected or not, when last connected, LAN address;
- the extensions: number, person or group name, how many devices are connected, desk phones, app users, Do not disturb.

**No calls, numbers dialled, recordings or audio are ever sent.** `buildPayload` copies only the listed fields, and the tests check that call details and passwords never appear. The database keeps one row per office (`link_offices`) and a copy of its phones (`link_office_phones`). Only someone in the business who is an owner or admin, or whose PC is linked, can report. Everyone in the business can read it.

**Changes from the website.** Owners and admins with two-step sign-in add rows to `link_office_commands` through `link_command`. The kinds are `assign_phone`, `unassign_phone`, `add_phone`, `new_password`, `set_dnd` and `reveal_password`. Riyeser Link Office asks for waiting changes every 30 seconds (`link_office_pending`), does each one, and marks it done or failed with a plain reason (`link_office_done`). The website shows "Sending to Riyeser Link Office…", then "Done" or the reason. Every change goes in the business's history (`audit_log`, `link.*`). Changes nobody picks up fail after a day.

**SIP passwords: Show (the design).** Passwords are made and kept only on this PC (`phone-secrets.json`, sealed with Windows data protection). They are never stored online and never logged.

1. **Show** in *Set up a phone by hand* makes a one-off RSA-OAEP (2048-bit, SHA-256) key pair in that browser tab, with WebCrypto. The private half can't be exported and never leaves the tab.
2. The website sends a `reveal_password` change with the public half only. It is in the history at once: "looked at a phone password", with who did it, or "Riyeser support".
3. Riyeser Link Office encrypts that extension's password to the public key (`sealFor`) and sends back only the scrambled text. The database keeps it in `link_office_reveals.sealed`, for at most 5 minutes from pressing Show.
4. The tab takes it once with `link_reveal_take`. Only the person who asked can take it, and only while they are still an admin, or still allowed to help. The copy is blanked as it's read. Expired or read copies are blanked by every check-in (`link_sweep`). Nobody can read the `sealed` column directly: there is no column permission for it.
5. The tab decrypts it and shows it until the box is closed.

So even the database, its backups, Riyeser staff and anyone watching the network only ever see a scrambled copy that only that tab could open. That copy lives for 5 minutes at most. **Make a new password** never sends the new password anywhere: press Show afterwards.

**Let Riyeser help.** On the Phones page an admin can press **Let Riyeser help**. That's a `link_support_access` row lasting 1 hour, written to both the business's history and HQ's. The admin can end it early. While it lasts, HQ staff with the `link.support` permission can make the same changes, including Show. Support and senior roles have that permission by default, and owners have all of them. Their changes are marked `by_riyeser`, written to `hq_audit`, and show in the customer's history as "Riyeser". HQ always sees the summary through `hq_company_link(ws)` (needs `customers.view`), shown by `website/hq/hq-link.js` in the customer page's `#cpLink`.

**Offline.** With no internet, or not signed in, the phones carry on as normal. The heartbeat and changes simply wait. Until the online database has had the latest `team-chat.sql`, Riyeser Link Office tries again every half hour and the website shows the set-up guide. The status screen's **Settings** tab says whether the website can see the phones, and has **Send phone details to Riyeser Link now**.

**The status screen.** It now opens on a **☎ Phones** tab. The server address is big at the top with **Copy**, next to two buttons, **Set up a phone by hand** and **+ Add a desk phone**, then the new phones found and the desk phones. People, Recent calls and Settings are the other tabs.

## My phone, the Desk phones list and Add desk phone (1.1.1)

**☎ My phone (everyone).** Every member sees their own phone at **riyeser.com/link → ☎ My phone** (the chat sidebar, the **My phone** tile on Riyeser home, **⚙ Settings → My phone**, or `?myphone`). It shows "Others call you by dialling 101", their desk phone(s) from the latest heartbeat, a numbered set-up guide (server address, port 5060, username = extension, password with **Show**), "Where do I type these on my phone?" for Yealink, Grandstream, Snom and Polycom, **Do not disturb**, **Call someone**, the no-emergency-calls note and **Report a phone issue** (Get help, filled in). The database side is the section *Riyeser Link: My phone* in `team-chat.sql`:

- `link_my_phone(ws)`: my extension, my phones, the office address and port, online or not, the licence, the first ring group. Never a password.
- `link_my_reveal(ws, pub_key)`: **Show** for my own extension only, with the same one-off RSA key design as above. Members don't need two-step sign-in for their own extension; admins still need it for anyone else's. In the history as `link.reveal_own`. `link_command_state` and `link_reveal_take` also let the asker follow and take it, but only while it's still their extension.
- `link_my_dnd(ws, on)`: Do not disturb for my own extension (`link.set_dnd_own`).

**Settings → Desk phones (owners and admins).** The Phones page is also **⚙ Settings → Desk phones** (`?phones` still works; members who open it get My phone). At the top, **Set up your office phones** has 5 steps that tick themselves off: installed (an office has reported), signed in (reported in the last 10 minutes), phones plugged in, every phone given to someone, and a test call (`counts.calls_made`, the number of answered calls kept on the PC, or a tick by hand kept in that browser). Then the **Desk phones** list: name, extension, location, status and last check-in, with **+ Add desk phone** above it and a **⋯** menu (View setup, Troubleshoot, Replace phone, Advanced setup (manual SIP), Rename / move location, Remove).

- **Statuses:** **Online** (connected now), **Configuring** (fetched its settings but not connected yet), **Offline** (was connected, isn't now), **Waiting for phone** (given to someone, hasn't asked for its settings yet). Each phone in the heartbeat now carries `provisioned_at` (its last settings fetch, from `phone-devices.json` `lastFetch`).
- **Names and locations:** a new change, `name_phone` {mac, name, branch, note}, stores a phone's name (up to 40 letters), its location (one of the business's branches) and a note (the S/N from Add desk phone) in `phone-devices.json` (`label`, `location`, `note`). They come back in the heartbeat as `name`, `location` and `note`. Admins only, checked by `link_command`.
- **Add desk phone:** name → location → extension → identify the handset (a new phone found, or its MAC and optional S/N, with **Where's the label?**) → plug it in (live **Waiting for phone → Configuring → Online**) → test call. It sends `assign_phone` or `add_phone`, then `name_phone`.
- **Replace phone:** sends `unassign_phone` for the old MAC, then `add_phone`/`assign_phone` for the new one on the same extension, then `name_phone` with the same name and location. The old phone keeps working until it's restarted or reset; make a new password to lock it out straight away.
- **On the office PC:** the ☎ Phones tab has the same 5 steps (from its own state), the same names, locations and status pills, **Rename / location** and **Replace phone** (in-page dialogs, never `confirm()`), and "How [name] sets up their phone" next to each person.

**Setup codes (planned, not built).** Codes typed on the handset need cloud provisioning, so they wait for Riyeser Link Cloud. Installer-issued codes are also later. For now **Add desk phone** shows "Use a setup code" switched off, marked "Coming with Riyeser Link Cloud".

## The Windows Firewall rule

Riyeser Link Office's installer adds **one** inbound Windows Firewall rule, named "Riyeser Link Office". The rule:

- covers this program only (`Riyeser Link Office.exe`);
- opens UDP 5060 and 5353 (riyeser-office.local, from 1.2.0), and TCP 5060 and 5080;
- accepts only office (private) addresses: 10/8, 172.16/12, 192.168/16 and 169.254/16;
- applies to every network profile. Windows often calls an office network "Public", and phones would be blocked if the rule only covered "Private".

Uninstalling removes the rule. This is the only change Riyeser Link Office makes to Windows. It never changes power, sleep or any other settings.

**Why the installer is per-machine.** The other Riyeser programs install just for the current Windows user, with no admin rights. A per-user installer can't add a firewall rule. Riyeser Link Office's installer is therefore per-machine (`perMachine: true`, Program Files), so Windows asks for permission once and the installer adds the rule itself (`build/link/installer.nsh`, an electron-builder `nsis.include`). This is the most reliable option. It works before anyone opens the program, it covers the program's exact path, and it's undone by the uninstaller. Updates from Riyeser Central ask for permission the same way. As a fallback, if the rule ever goes missing, the status screen shows **Allow phones through the firewall**. That button adds the same rule, with Windows' permission prompt.

## Why the PC must stay on

The phones only work while Riyeser Link Office is running. If the PC is off, asleep or restarting, the phones can't call each other. While Riyeser Link Office runs:

- it starts with Windows and sits by the clock;
- it asks Windows not to sleep (`powerSaveBlocker` `prevent-app-suspension`);
- it reads Windows' sleep settings, and warns when the PC could still go to sleep. It never changes them.

Set sleep to **Never** when plugged in, and don't use a laptop with its lid closed.

### A stable address

Phones keep this PC's network address. See *When the PC's address changes (1.2.0)* below for what happens when the router gives it a new one. The short version: Riyeser Link Office follows it by itself within seconds, but the best fix is a **DHCP reservation** in the router.

## When the PC's address changes (1.2.0)

The router hands out addresses (DHCP) and can give the PC a new one, for example after the router restarts, the PC moves between Wi-Fi and a cable, or it joins another network. Before 1.2.0 the address was checked once a minute and the phone system restarted on the new one. Desk phones were asked to fetch their settings again, but from the *old* address, so they usually stayed lost until someone restarted them.

**Noticing (`src/link/netwatch.js`).** The adapters are polled every 5 seconds (`os.networkInterfaces()`). On Windows a small PowerShell helper also listens for .NET's `NetworkChange.NetworkAddressChanged` and prints a line on every change; on Linux it's `ip -o monitor address`. Waking from sleep (`powerMonitor` `resume`) checks too. A change is acted on once it has settled for 2.5 seconds, because DHCP often gives a 169.254 address first. If the helper is missing or dies, polling carries on alone.

**Which adapter (`src/link/netinfo.js` `pickAdapter`).** The order is:

1. the adapter the owner chose (Settings → Advanced);
2. the address in use now, if it's still on the PC, so a second address or a VPN connecting doesn't move the phones;
3. the adapter in use now, with its new address;
4. the most likely office adapter: a real one, with the router (from Windows' `Get-NetIPConfiguration`), and 192.168 before 10 before 172.16.

Virtual adapters (Hyper-V, WSL, VirtualBox, VMware, Docker, VPNs and tunnels: OpenVPN/TAP, WireGuard, Tailscale, ZeroTier, AnyConnect, GlobalProtect, Fortinet; Teredo, Bluetooth, Npcap) are recognised by name *and* by Windows' adapter description. They're never picked by themselves, unless one is the only way to the router (a Hyper-V "external" switch). Loopback, link-local (169.254) and CGNAT (100.64/10) addresses are ignored. With no office network at all (cable out), it's not treated as a new address: the screen says the PC isn't connected, and it waits.

**Moving (`PhoneService.checkNetwork`).** The SIP, settings and mDNS sockets listen on every adapter (0.0.0.0), so they stay up. Registrations are kept. Only what is written into messages and settings moves:

- **SIP.** `Pbx.setHost` moves Via, Record-Route, Contact, the plug-and-play answer and check-sync to the new address. It re-joins the plug-and-play group (224.0.1.75) on the new adapter. The old address still counts as "us" (`isOurHost`), so the Route of a call set up before the change still matches. Software on this PC (the Riyeser Link app) that still sends the old address in Via, Contact, Record-Route, Route or its SDP (`c=`, `o=`, `a=rtcp`) has it rewritten (`sip.rewriteHost`, `Pbx.fixLocal`). Desk phones' messages are never rewritten. Sound (RTP) goes phone to phone and never through this PC, so there are no RTP addresses of our own to move.
- **Settings and plug-and-play** (`Provisioner.setHost`) carry the new address.
- **riyeser-office.local** answers with the new address and announces it.
- **Desk phones** are asked to pick it up (below).
- **The website** gets a heartbeat at once (`address-changed` → `LinkCloud.report('address')`).
- **The log and the screen.** The change is logged ("changed from 192.168.1.20 to 192.168.1.35 (just now)"). A Windows notification by the clock and the status screen say **"Your PC's address changed from 192.168.1.20 to .35 — phones updated."** with **Reserve this PC's address in your router**.

If the old address is still on the PC and calls are in progress, it waits until they end. If the old address is gone, those calls can't continue anyway, so it moves straight away. When listening on one address only (`bind`, used in tests), it restarts the phone system on the new one, as before.

**Phones following automatically.** These are the approaches, in order:

1. **Re-provision over the LAN, every time.** Each desk phone that's connected now (at the address and port it registers from), or that was set up here, gets a SIP `NOTIFY` in its maker's wording (`provision.js resyncEvent`):
   - Yealink, Grandstream and Snom: `check-sync;reboot=true`;
   - Polycom: `check-sync`, which always restarts with our settings (`voIpProt.SIP.specialEvent.checkSync.alwaysReboot`);
   - Cisco/Linksys SPA typed in by hand: `reboot` (or `resync`).

   Restarting matters. On start-up the phone asks plug-and-play who sets it up and is answered with the *new* address, even though its saved settings still have the old one. Yealink settings now say so explicitly (`static.auto_provision.pnp_enable = 1`, `power_on = 1`, `sip.notify_reboot_enable = 1`). The status screen shows how many phones were asked. A phone that only accepts NOTIFY from its own (old) server won't hear it. It picks the address up the next time it restarts, or immediately with a name (2).
2. **A name instead of an address (`src/link/pcname.js`, `src/link/mdns.js`).**
   - **riyeser-office.local** is answered by Riyeser Link Office itself, over mDNS (RFC 6762): A and ANY questions for that one name, announced on every change with the cache-flush bit. "Legacy unicast" questions sent straight to port 5353 are answered too, so a plain DNS lookup pointed at the PC works (`nslookup riyeser-office.local <PC> -port=5353`). If another computer already answers for the name, it becomes riyeser-office-2.local (kept in settings). Computers, phones' softphone apps and the Riyeser Link app can use it. Most desk phones can't look up `.local` names, so it isn't put into desk phones' settings by itself.
   - **The router's own name.** Many routers put each device's name in their DNS (OFFICE-PC.lan, .home, .fritz.box…). Riyeser Link Office asks the network's DNS servers directly (not Windows' LLMNR/NetBIOS) for the PC's name with the network's DNS suffix and common router suffixes, and trusts a name only if it gives exactly this PC's address now. It checks again after every change. A name that checks out is written into desk phones' settings as the **backup server**: Yealink `sip_server.2`, Grandstream P2312, Polycom `reg.1.server.2`. Or, if the owner chooses **Give desk phones the name** in *Settings → This PC's address*, it's the main server and the settings address. The name follows the PC when the router gives it a new address.

   A separate unicast DNS server on port 53 isn't included: phones would have to be pointed at the PC's address for it, which is the thing that changes.
3. **DHCP option 66.** *This PC's address* shows the provisioning address (`http://<address>:5080/`) to put in the router's "option 66" / "TFTP server" / "provisioning server". Grandstream settings now allow option 66 to take over (P145). Combined with a reservation, new phones of any make find their settings.
4. **Reserve this PC's address in your router (recommended).** This is a guided helper on the status screen and in *Settings → This PC's address*. It shows the PC's MAC address, the address to reserve and the router's address (**Open its page**), with steps for TP-Link, NETGEAR, ASUS, Linksys, D-Link, UniFi, FRITZ!Box, MikroTik, internet providers' modems and others. The website's Phones page and help (`help/link.html#stable-address`) link to the same steps.

**Use a fixed address (optional, Windows).** *Settings → This PC's address → Use a fixed address* is only for routers that can't reserve. It comes with a warning: a fixed address on the PC can clash if the router gives it to another device. It runs once with Windows' permission prompt (`windows.js fixedAddressScript`):

1. It refuses an address another device answers on.
2. It sets the address with the current router and DNS servers (`netsh interface ipv4 set address … source=static`).
3. It checks the router can still be reached. If not within ~20 seconds, it goes back to automatic (DHCP) by itself.

**Undo** goes back to automatic (`dhcpScript`). Only adapters on DHCP with a router are offered. Nothing changes unless the owner chooses it.

**Address history.** Each change (from, to, when, what noticed it) is kept in `phone-settings.json` (`hostChanges`, the last 10, and the last 30 days count). Three changes in 30 days mark the address as not stable.

**The website.** The heartbeat adds:

- `mdns_name`;
- `router_name`;
- `phone_server` (what desk phones are given);
- `address_changes` (the last 5: from, to, at).

These are stored in `link_offices` (new columns, `team-chat.sql`). The Phones page shows:

- "ℹ️ The office PC's address changed from 192.168.1.20 to .35 — phones updated" for a week after a change;
- the names the PC answers to, and "Desk phones are given the name …" when they are;
- the reservation help link with the PC's MAC address.

*Set up a phone by hand* shows the name when phones are given one.

**The firewall rule** now also opens UDP 5353 (riyeser-office.local) for office addresses. A rule from before 1.2.0 shows **Update the firewall rule** on the status screen.

## One control panel, many phones at once (1.2.3)

The window is now one control panel with a menu on the left:

- **Overview**: *Needs attention* (new phones waiting, phones offline, the firewall, the address, Riyeser Online) with a one-click fix for each, and a tile for each part: phones online / offline / new (click a number for that list), calls today and missed, people on Do not disturb, this PC's address, branches and relay (*Not set up* until Riyeser Link Cloud's relay exists), the Windows check, backups and Riyeser Online.
- **Phones**: every phone in one list (given to someone, new, ignored) with search, sorting and filters (status, maker, location, assigned or not), a tick box on every row and *select all* (of what's shown). Ticked phones get a bar: **Give to…** (a person for each, or new extensions numbered in order), **Add as shared phones** (each its own extension, named after the phone: Reception, Meeting room), **Move location**, **Restart**, **Re-send settings**, **Take back**, **Ignore** / **Bring back**, **Remove**. Each ends with a summary ("Gave out 3 phones, 1 skipped: already given to someone").
- Click a phone to manage it in the panel on the right (the list stays in view): its status, model, firmware, MAC, IP, when it connected and was last seen, its recent calls; Restart, Re-send settings, **Find this phone** (it rings for 5 seconds as "Find this phone"; nobody can talk on it), its web page, Set up by hand, New SIP password, Replace phone, Take back, Ignore, Remove; who it's for (a person, or a new shared phone); its name, location and notes; and **Phone settings**: only what its maker's settings file supports (Yealink: line key name, name on calls, time zone, 12/24-hour clock, language, ringtone, ring volume, up to 10 speed-dial keys, Do not disturb following its person; Grandstream: names, clock, language; Snom: name, time zone, clock, language, ringtone, volume, 12 keys, Do not disturb; Polycom: names, time zone, clock, language, ringtone, 6 keys). Settings reach the phone when it next fetches them: *Save and restart* does it at once. Busy lamps on keys need a later version (the phone system doesn't send busy states yet).
- **Add several phones**: paste MAC addresses (one per line, any format) or import a CSV (*MAC address, Model or maker, Extension, Person (name or email), Phone name, Location*; only the MAC is needed; *Download the CSV template*). Every row is checked before anything is added: a valid MAC or not, twice in the list, already added, the maker (from the label, or the MAC's first 6 digits), the extension it gets and who it's for. Fix rows in place, then **Add N phones**. Phones with no person either wait under New, or each get a new extension from a chosen number up (skipping used numbers, x00 group numbers and emergency numbers).
- **Ring groups** (1.2.2): an Overview tile with each number, how it rings and any with nobody chosen (also under *Needs attention*); *Manage ring groups* on the tile, on People and on Calls opens Riyeser Link → Management → Ring groups (riyeser.com/link/?rings), where they're chosen. The website's Desk phones page has the same entry.
- **People** and **Calls** work the same way: a list, and a panel on the right. Do not disturb, ring groups and passwords stay with the person.
- **Settings → Change history**: who changed the phones and what, here or from the website.
- The *Internal calls only* warning is a slim line under the title; hide it for this session with ✕ (a small chip stays in the title bar).

The website's Phones page does the same (bulk_phones, phone_action, phone_settings changes); `test/link-bulk.test.js` covers it.

## The status screen always starts (1.2.1)

1.2.0's window stopped before it drew anything: the tabs didn't switch, the status bar at the top showed only its coloured edge, and the two cards under the tabs stayed as empty grey bars. The window's script declared its own `api` while the preload already puts a fixed `api` on the window, which Electron rejects as a script error. 1.2.1 fixes that, and the screen no longer depends on any one answer:

- the tabs work straight away; the top bar says **Starting Riyeser Link Office…** until the phone system answers;
- if it doesn't answer (or answers with an error), the top bar says so with **Try again**, and it keeps asking by itself;
- each part of the screen is drawn on its own, so a problem in one shows a short note there and the rest still fills in;
- empty boxes are hidden rather than shown as grey bars.

`test/link-ui-init.test.js` runs the real window scripts with a backend that works, fails and never answers.

## Ring groups with chosen members (1.2.2)

Calling a branch's number used to ring everyone in the branch. Now each number rings only who the owner or an admin chose for it in Riyeser Link (Management › Phones & calls › Ring groups), and the same groups come down to this PC with the people:

- **Members**: people (their desk phones and Riyeser Link apps ring together, as for their own extension) and shared desk phones (an extension added on this PC that isn't a person in Riyeser Link, such as Reception 150). Someone in the branch but not chosen doesn't ring.
- **How it rings**: *Ring all at once*; *Ring in order* (each for the chosen seconds, the next when they don't answer or say no); *Rotate* (in order, starting with the next person each call; this PC keeps its own turn).
- **Skipped**: Do not disturb (`*78`), and anyone on a call (talking or dialling out) on this PC.
- **If nobody answers** within the group's time: another group's number, one person's extension, or a missed call (at most 3 groups in a row, never the same one twice). Voicemail is coming.
- **Nobody chosen**: the caller hears *Temporarily Unavailable (nobody chosen for this group)* and it's a missed call, unless the group falls back to another.
- Groups made by hand here (`addGroup`) take the same settings; the settings file (export/import) keeps them.

`test/link-ringgroups.test.js` checks the planning, the sync (and an older online database), and real calls through the SIP server: only chosen phones ring, in order, rotate, Do not disturb skipped, and each fallback.

## Security

- **Office network only.** Phones can only connect, and settings can only be fetched, from private addresses. An advanced setting allows others (not recommended).
- **Passwords.**
  - Each extension has its own 16-character random password.
  - Passwords are stored with Windows data protection.
  - They are never written to logs, and the log records extension numbers and addresses only.
- **Blocking.** An address that gets the password wrong 10 times in 10 minutes is blocked for an hour. This protects against scanners and toll fraud. The status screen shows blocked addresses.
- **Settings files.** A desk phone's settings file holds its password, so:
  - a file is only given to a phone the owner has assigned to someone;
  - it is refused when the phone's own MAC (in its User-Agent) doesn't match the file it asked for;
  - addresses that keep asking for files they can't have are blocked;
  - every fetch is logged.
- **Inside calls.** Requests inside a call are only passed on for calls Riyeser Link Office set up, and only to office addresses, so it can't be used as an open relay.
- **Bad messages.** Malformed SIP is ignored. The parser is fuzz-tested.

## People and the licence

- **Signed in to Riyeser.** When the PC is signed in (Riyeser Central's sign-in, or Riyeser Link Office's own), Riyeser Link Office brings in the Riyeser Link members with their extensions, the ring groups (`ring_groups_list`: each number with only the people and shared desk phones chosen for it, how it rings and what happens if nobody answers; an online database without ring groups yet still sends the branches with everyone in them) and the business name. It does this every 30 minutes and saves everything on this PC, so the phones keep working with no internet, indefinitely. It never renews Central's sign-in itself, so the two programs can't trip each other up.
- **Not signed in.** People can be added by hand. Hand-added people never get an emergency number (111, 112).
- **Licence.** Riyeser Link Office works while Riyeser Link is on: in its free trial (the same 90 days as every paid program) or paid. That's read from `%APPDATA%\Riyeser\licence.json`, and it keeps working for 30 days without the internet.
- **When it isn't on.** Riyeser Link Office still installs and opens, but doesn't start the phone system. The screen says: "Riyeser Link Office comes with **Riyeser Link**. Start your free trial or add Riyeser Link from your Riyeser home page (Add to my plan)." It has a button to open Riyeser Link, and phones show as "waiting for Riyeser Link".
- **If it lapses while running.** Calls in progress finish. New phones and calls are then refused, and it pauses. Nothing is deleted.

## Moving between Office and Cloud

**Advanced → Export settings** saves one JSON file (`"format": "riyeser-link-settings", "version": 1`). It holds:

- people and extensions (and whether they came from Riyeser Link);
- ring groups;
- desk-phone assignments (MAC → extension, maker, model);
- Do not disturb;
- each extension's SIP password.

**Import settings** takes the same file on another PC, or later in Riyeser Link Cloud. Phones keep their extensions and passwords, so nothing needs setting up again. The file holds passwords, so keep it safe. Recent calls stay where they are. The code is in `src/link/portable.js`.

## Next steps

### Step 2: the Riyeser Link app as a softphone

The Riyeser Link desktop app (`src/team-main.js`) will register to Riyeser Link Office as a SIP phone on the same network. It will do this natively in Electron's main process:

1. **Signalling.** It uses SIP over UDP. The same digest REGISTER and INVITE, with a User-Agent containing "Riyeser", so Riyeser Link Office shows its device as "Riyeser Link app".
2. **Sound.** It sends RTP over UDP with G.711 (PCMU/PCMA, 8 kHz, 20 ms packets). Microphone and speaker audio crosses from the renderer to main over IPC.
3. **Finding Riyeser Link Office.** It uses the same company link. Riyeser Link Office's address and the person's password can be published to the Riyeser Link app on the same PC or network: a later small authenticated endpoint on the settings server, or the settings export.
4. **No changes needed in Riyeser Link Office.** A person can have a desk phone and the app, and both ring (parallel forking already does this).

`src/link/simua.js` is a minimal SIP user agent (register, call, answer, hang up, hold) and is a starting point for the signalling side.

### Step 3: the Riyeser relay (1.3.0, built)

Branches on other internet connections and phones at home, through the Riyeser relay: see **`RELAY.md`**. The seam is
`src/link/trunks.js`; the relay link is `src/link/relay.js`; the relay itself is `relay/` on `main` (copy in `src/relay/`).

### Later: Riyeser Link Cloud

The same engine (`src/link/`), hosted by Riyeser, with the same extensions, ring groups, phone set-up and settings file. Phones and Riyeser Link apps anywhere connect to it over the internet (TLS/SRTP and a media relay then become necessary).

## Files

- `src/link-main.js` — the Electron app (tray, start with Windows, single instance, keep-awake, `--self-test=<file>`).
- `src/link/`:
  - `sip.js` — the SIP parser and writer.
  - `pbx.js` — the registrar and proxy.
  - `dialplan.js`
  - `provision.js` — plug-and-play answers and the settings server.
  - `directory.js` — people, ring groups, passwords and DND.
  - `ringgroups.js` — who a group's number rings, step by step (all at once, in order, rotating; skipped phones; the fallback).
  - `sync.js` — Riyeser Link.
  - `cloud.js` — the website's Phones page: heartbeat, changes, Show password.
  - `licence.js` — Riyeser Link.
  - `calllog.js` — 90 days of recent calls.
  - `service.js` — puts it all together.
  - `portable.js` — export and import.
  - `trunks.js` — the trunk seam; `relay.js` — the Riyeser relay link (1.3.0); `ws.js` — WebSocket.
- `src/relay/` — the Riyeser relay itself (the same code as `relay/` on main), for running it on the head office PC.
  - `windows.js` — the firewall rule, sleep settings, the adapters' routers and DNS (read only), and the optional fixed address.
  - `netinfo.js` — this PC's addresses and which adapter is the office one.
  - `netwatch.js` — notices address changes (polling and Windows' own events).
  - `mdns.js` — answers riyeser-office.local.
  - `pcname.js` — the router's own name for this PC.
  - `simua.js` — a simulated phone.
  - `selftest.js`
- `src/renderer/link.html`, `link.js`, `link.css`, `link-text.js` — the status screen (all wording is in `link-text.js`).
- `build/link/installer.nsh` — the firewall rule in the installer.
- `test/link-*.test.js` — simulated phones over UDP on this PC.

Data lives in `%APPDATA%\Riyeser Link Office\data\`:

- `phone-directory.json`
- `phone-secrets.json` (sealed)
- `phone-devices.json` (phones, new phones, settings-fetch log)
- `phone-calls.json`
- `phone-dnd.json`
- `phone-settings.json` (includes this install's `officeId`)
- `phone-cloud.json` (when each desk phone was last connected)

The log is in `%APPDATA%\Riyeser Link Office\logs\link.log`.

## Testing with a real phone

Any of these sets itself up with plug-and-play:

- **Yealink T31P or T33G** (about A$90–130). PoE; buy the Yealink power adapter if there's no PoE switch.
- **Grandstream GRP2601P** (about A$80–100).

Two phones let you test a real call. Or use one phone and a softphone app (for example Linphone or Zoiper on a PC or mobile on the office Wi-Fi), with **Set up a phone by hand**. A small PoE switch (for example TP-Link TL-SG1005P, about A$60) powers both phones.
