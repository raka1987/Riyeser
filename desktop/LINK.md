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

- keeps everyone's extension (100–899) and the ring groups (branches);
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
| A branch number, e.g. `100`, `200` | Every phone in that ring group rings at once. The first to answer gets the call; the others stop ringing. |
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
6. A phone in another building or at home won't reach it. That's coming with the cloud version.

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
- opens UDP 5060, and TCP 5060 and 5080;
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

Phones keep this PC's network address. If the router gives the PC a new address, Riyeser Link Office notices (at start-up, and every minute while running). It then:

- moves to the new address;
- sends settings with the new address;
- asks each desk phone to fetch them again;
- shows a yellow notice with "Show me how" steps and the PC's MAC address for a **DHCP reservation** / **Static lease** in the router.

Three changes in 30 days mark the address as not stable. If the PC has several network adapters, Riyeser Link Office picks the office one, skipping virtual adapters such as Hyper-V, WSL, VPNs and Docker. The owner can choose another under **Advanced**.

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

- **Signed in to Riyeser.** When the PC is signed in (Riyeser Central's sign-in, or Riyeser Link Office's own), Riyeser Link Office brings in the Riyeser Link members with their extensions, the branches (as ring groups) and the business name. It does this every 30 minutes and saves everything on this PC, so the phones keep working with no internet, indefinitely. It never renews Central's sign-in itself, so the two programs can't trip each other up.
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

### Step 3: the Riyeser relay (remote Link app users and branches)

The Office Link is designed to keep an **outgoing** connection to a Riyeser relay. Remote Riyeser Link app users, and other branches' Links, will reach office extensions through it with no router changes. The relay isn't built yet. The seam is `src/link/trunks.js`. A trunk:

- opens its own outgoing connection (`start`) and hands the SIP it receives to the PBX as coming from a trusted trunk (`proto: 'TRUNK'`);
- says which numbers it can reach (`route(number)`): the PBX asks only for numbers that aren't on this PC, and never for emergency numbers;
- sends SIP out over its connection (`send`).

Office extensions always stay local. A test checks that an unknown number is handed to a registered trunk.

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
  - `sync.js` — Riyeser Link.
  - `cloud.js` — the website's Phones page: heartbeat, changes, Show password.
  - `licence.js` — Riyeser Link.
  - `calllog.js` — 90 days of recent calls.
  - `service.js` — puts it all together.
  - `portable.js` — export and import.
  - `trunks.js` — the relay seam.
  - `windows.js` — the firewall rule and sleep settings.
  - `netinfo.js`
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
