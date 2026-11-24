# Riyeser Link

Riyeser Link is Riyeser's phone hosting service. It comes in two forms:

- **Riyeser Link: Office** runs on one PC in the office. That's this program, `Riyeser Link.exe`.
- **Riyeser Link: Cloud** will be hosted by Riyeser, in a later phase.

Both use the same extensions, ring groups and desk-phone set-up. A business can move from one to the other without setting anything up again (see *Moving between Office and Cloud*).

Riyeser Link comes with **Team Chat Plus** (the `calls` module of the Riyeser plan).

> **Internal calls only.** These phones can't call emergency services — keep a mobile or normal phone line for that.

## What it does

One office PC runs Riyeser Link. It:

- keeps everyone's extension (100–899) and the ring groups (branches);
- lets the office's desk phones connect to it (SIP registration);
- connects calls between them.

There are no outside lines and no phone numbers. Dialling an outside number, or an emergency number (000, 111, 112, 911…), gets "No emergency calls - use a mobile or normal phone".

### How a call works

```
 Desk phone 101 ──SIP──▶ Riyeser Link (this PC) ──SIP──▶ Desk phone 102
        ▲                                                     │
        └──────────── sound (RTP), phone to phone ────────────┘
```

Riyeser Link handles the *signalling*: who's calling, ringing, answering and hanging up. The sound never passes through the PC. The SDP (the description of the sound) passes through unchanged, so the phones send sound to each other directly. That's why both phones must be on the same office network. If a phone connects from a different subnet, Riyeser Link notes it in the log, because that phone may have no sound.

### The dial plan

| Dial | What happens |
|---|---|
| `101`–`899` | That person's phones ring (desk phone and, later, the Riyeser Team app, all at once). |
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
- Transfer is passed through, not handled by Riyeser Link. A transfer works when the phones support REFER, which Yealink, Grandstream and Snom do.

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
3. Turn it on. The phone asks the network "who sets me up?" (SIP plug-and-play on 224.0.1.75). Riyeser Link answers with the address of its small settings server, on this PC at port 5080.
4. The phone shows on the status screen as **New phone found**. Choose who it's for. The phone fetches its settings (server address, extension, password, and the person's name as its label) and connects. If it hasn't done that within a minute, restart the phone.
5. Wi-Fi desk phones work too, once joined to the office Wi-Fi.
6. A phone in another building or at home won't reach it. That's coming with the cloud version.

Didn't appear? Use **Add a desk phone → Add phone** with the MAC address on the sticker under the phone. Or use **Set up a phone by hand** next to the person. It shows the server address (this PC's address), the username (the extension) and the password, to type into any SIP phone or app.

## The Windows Firewall rule

Riyeser Link's installer adds **one** inbound Windows Firewall rule, named "Riyeser Link". The rule:

- covers this program only (`Riyeser Link.exe`);
- opens UDP 5060, and TCP 5060 and 5080;
- accepts only office (private) addresses: 10/8, 172.16/12, 192.168/16 and 169.254/16;
- applies to every network profile. Windows often calls an office network "Public", and phones would be blocked if the rule only covered "Private".

Uninstalling removes the rule. This is the only change Riyeser Link makes to Windows. It never changes power, sleep or any other settings.

**Why the installer is per-machine.** The other Riyeser programs install just for the current Windows user, with no admin rights. A per-user installer can't add a firewall rule. Riyeser Link's installer is therefore per-machine (`perMachine: true`, Program Files), so Windows asks for permission once and the installer adds the rule itself (`build/link/installer.nsh`, an electron-builder `nsis.include`). This is the most reliable option. It works before anyone opens the program, it covers the program's exact path, and it's undone by the uninstaller. Updates from Riyeser Central ask for permission the same way. As a fallback, if the rule ever goes missing, the status screen shows **Allow phones through the firewall**. That button adds the same rule, with Windows' permission prompt.

## Why the PC must stay on

The phones only work while Riyeser Link is running. If the PC is off, asleep or restarting, the phones can't call each other. While Riyeser Link runs:

- it starts with Windows and sits by the clock;
- it asks Windows not to sleep (`powerSaveBlocker` `prevent-app-suspension`);
- it reads Windows' sleep settings, and warns when the PC could still go to sleep. It never changes them.

Set sleep to **Never** when plugged in, and don't use a laptop with its lid closed.

### A stable address

Phones keep this PC's network address. If the router gives the PC a new address, Riyeser Link notices (at start-up, and every minute while running). It then:

- moves to the new address;
- sends settings with the new address;
- asks each desk phone to fetch them again;
- shows a yellow notice with "Show me how" steps and the PC's MAC address for a **DHCP reservation** / **Static lease** in the router.

Three changes in 30 days mark the address as not stable. If the PC has several network adapters, Riyeser Link picks the office one, skipping virtual adapters such as Hyper-V, WSL, VPNs and Docker. The owner can choose another under **Advanced**.

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
- **Inside calls.** Requests inside a call are only passed on for calls Riyeser Link set up, and only to office addresses, so it can't be used as an open relay.
- **Bad messages.** Malformed SIP is ignored. The parser is fuzz-tested.

## People and the licence

- **Signed in to Riyeser.** When the PC is signed in (Riyeser Central's sign-in, or Riyeser Link's own), Riyeser Link brings in the Riyeser Team members with their extensions, the branches (as ring groups) and the business name. It does this every 30 minutes and saves everything on this PC, so the phones keep working with no internet, indefinitely. It never renews Central's sign-in itself, so the two programs can't trip each other up.
- **Not signed in.** People can be added by hand. Hand-added people never get an emergency number (111, 112).
- **Licence.** Riyeser Link works while Team Chat Plus is on: in its free trial (the same 90 days as every paid program) or paid. That's read from `%APPDATA%\Riyeser\licence.json`, and it keeps working for 30 days without the internet.
- **When it isn't on.** Riyeser Link still installs and opens, but doesn't start the phone system. The screen says: "Riyeser Link comes with **Team Chat Plus**. Start your free trial or add Team Chat Plus from your Riyeser home page." It has a button to open Riyeser Team, and phones show as "waiting for Team Chat Plus".
- **If it lapses while running.** Calls in progress finish. New phones and calls are then refused, and it pauses. Nothing is deleted.

## Moving between Office and Cloud

**Advanced → Export settings** saves one JSON file (`"format": "riyeser-link-settings", "version": 1`). It holds:

- people and extensions (and whether they came from Riyeser Team);
- ring groups;
- desk-phone assignments (MAC → extension, maker, model);
- Do not disturb;
- each extension's SIP password.

**Import settings** takes the same file on another PC, or later in Riyeser Link: Cloud. Phones keep their extensions and passwords, so nothing needs setting up again. The file holds passwords, so keep it safe. Recent calls stay where they are. The code is in `src/link/portable.js`.

## Next steps

### Step 2: the Riyeser Team app as a softphone

The Riyeser Team desktop app (`src/team-main.js`) will register to Riyeser Link as a SIP phone on the same network. It will do this natively in Electron's main process:

1. **Signalling.** It uses SIP over UDP. The same digest REGISTER and INVITE, with a User-Agent containing "Riyeser", so Riyeser Link shows its device as "Riyeser Team app".
2. **Sound.** It sends RTP over UDP with G.711 (PCMU/PCMA, 8 kHz, 20 ms packets). Microphone and speaker audio crosses from the renderer to main over IPC.
3. **Finding Riyeser Link.** It uses the same company link. Riyeser Link's address and the person's password can be published to the Team app on the same PC or network: a later small authenticated endpoint on the settings server, or the settings export.
4. **No changes needed in Riyeser Link.** A person can have a desk phone and the app, and both ring (parallel forking already does this).

`src/link/simua.js` is a minimal SIP user agent (register, call, answer, hang up, hold) and is a starting point for the signalling side.

### Step 3: the Riyeser relay (remote Team users and branches)

The Office Link is designed to keep an **outgoing** connection to a Riyeser relay. Remote Riyeser Team users, and other branches' Links, will reach office extensions through it with no router changes. The relay isn't built yet. The seam is `src/link/trunks.js`. A trunk:

- opens its own outgoing connection (`start`) and hands the SIP it receives to the PBX as coming from a trusted trunk (`proto: 'TRUNK'`);
- says which numbers it can reach (`route(number)`): the PBX asks only for numbers that aren't on this PC, and never for emergency numbers;
- sends SIP out over its connection (`send`).

Office extensions always stay local. A test checks that an unknown number is handed to a registered trunk.

### Later: Riyeser Link: Cloud

The same engine (`src/link/`), hosted by Riyeser, with the same extensions, ring groups, phone set-up and settings file. Phones and Team apps anywhere connect to it over the internet (TLS/SRTP and a media relay then become necessary).

## Files

- `src/link-main.js` — the Electron app (tray, start with Windows, single instance, keep-awake, `--self-test=<file>`).
- `src/link/`:
  - `sip.js` — the SIP parser and writer.
  - `pbx.js` — the registrar and proxy.
  - `dialplan.js`
  - `provision.js` — plug-and-play answers and the settings server.
  - `directory.js` — people, ring groups, passwords and DND.
  - `sync.js` — Riyeser Team.
  - `licence.js` — Team Chat Plus.
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

Data lives in `%APPDATA%\Riyeser Link\data\`:

- `phone-directory.json`
- `phone-secrets.json` (sealed)
- `phone-devices.json` (phones, new phones, settings-fetch log)
- `phone-calls.json`
- `phone-dnd.json`
- `phone-settings.json`

The log is in `%APPDATA%\Riyeser Link\logs\link.log`.

## Testing with a real phone

Any of these sets itself up with plug-and-play:

- **Yealink T31P or T33G** (about A$90–130). PoE; buy the Yealink power adapter if there's no PoE switch.
- **Grandstream GRP2601P** (about A$80–100).

Two phones let you test a real call. Or use one phone and a softphone app (for example Linphone or Zoiper on a PC or mobile on the office Wi-Fi), with **Set up a phone by hand**. A small PoE switch (for example TP-Link TL-SG1005P, about A$60) powers both phones.
