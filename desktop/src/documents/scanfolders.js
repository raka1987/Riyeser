// Riyeser Documents: scan-to-folder. Office printers (HP, Canon, Brother, Ricoh...) can save scans straight into a
// shared network folder. The library has one folder per department under _Scans (and "Email in" for scan-to-email
// later). This watches them: a new file that has finished writing goes to the Inbox, with its department pre-set.
//
// Network shares don't reliably send change events, so the folders are checked every few seconds instead. A file is
// taken only when its size and time haven't changed between two checks (the printer has finished writing it).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SPECIAL, EMAIL_IN } = require('./library');

const SCAN_EXT = /\.(pdf|jpe?g|png|tiff?|bmp|heic|docx?|xlsx?|txt|eml)$/i;

/** The folders to watch: [{ dept (null for Email in), dir, source }] */
function scanFolders(root, departments) {
  return [
    ...departments.map((d) => ({ dept: d, dir: path.join(root, SPECIAL.scans, d), source: 'printer' })),
    { dept: null, dir: path.join(root, SPECIAL.scans, EMAIL_IN), source: 'email' },
  ];
}

/**
 * The path to type into the printer's "Scan to folder" (SMB) setting. A shared library already has one; a library
 * on this PC needs its folder shared first (Windows: right-click › Properties › Sharing), with that share name.
 */
function networkPath(root, dept, { computer = os.hostname(), shareName = 'Riyeser Documents' } = {}) {
  const sub = dept ? `${SPECIAL.scans}\\${dept}` : `${SPECIAL.scans}\\${EMAIL_IN}`;
  const r = String(root);
  if (/^\\\\/.test(r)) return `${r.replace(/[\\/]+$/, '')}\\${sub}`;
  return `\\\\${String(computer || 'THIS-PC').toUpperCase()}\\${shareName}\\${sub}`;
}

/** Short steps for common printer brands. Plain English; the printer's own menus vary a little by model. */
const BRANDS = [
  { id: 'hp', name: 'HP', steps: ['Open the printer\'s web page: type its IP address (on the printer\'s screen under Network) into a browser.', 'Go to Scan › Scan to Network Folder › Add (New).', 'Paste the network path below, and enter a Windows user name and password that can write to the folder.', 'Save, then scan a test page: pick the folder on the printer\'s screen.'] },
  { id: 'canon', name: 'Canon', steps: ['On the printer, open Address Book › Register New Destination › File (or use Remote UI in a browser).', 'Protocol: Windows (SMB). Host name: paste the network path below.', 'Enter a Windows user name and password that can write to the folder.', 'Scan › File and pick the new destination.'] },
  { id: 'brother', name: 'Brother', steps: ['Open the printer\'s web page (its IP address) and sign in.', 'Go to Scan › Scan to FTP/SFTP/Network/SharePoint › choose Network for a profile.', 'Under Scan to Network Profile, paste the network path below and enter a Windows user name and password.', 'On the printer: Scan › to Network › pick the profile.'] },
  { id: 'ricoh', name: 'Ricoh / Lanier / Savin', steps: ['Open Web Image Monitor (the printer\'s IP address) › Device Management › Address Book › Add User.', 'Under Folder: Protocol SMB, Path: paste the network path below.', 'Enter a Windows user name and password, then Connection Test.', 'On the printer: Scanner › pick the name.'] },
  { id: 'kyocera', name: 'Kyocera / Konica Minolta / Sharp / Xerox', steps: ['Open the printer\'s web page (its IP address) and sign in as administrator.', 'Add an Address Book entry of type SMB (Shared folder / Network folder).', 'Host: the PC name in the path below; Path: the rest of it. Enter a Windows user name and password.', 'Send a test scan to the new entry.'] },
  { id: 'epson', name: 'Epson', steps: ['Open Web Config (the printer\'s IP address) › Scan/Copy › Contacts › Add.', 'Type: Network Folder (SMB). Save to: paste the network path below.', 'Enter a Windows user name and password.', 'On the printer: Scan › Network Folder › pick the contact.'] },
];

/**
 * Check the scan folders once. state: a Map kept between checks (file -> "size|mtime" seen last time).
 * onFile(file, folder) is called once for each finished file. Returns the files handed over.
 */
async function pollOnce(folders, state, onFile) {
  const taken = [];
  for (const f of folders) {
    let names; try { names = fs.readdirSync(f.dir); } catch { continue; }
    for (const n of names) {
      if (!SCAN_EXT.test(n) || n.startsWith('~') || n.startsWith('.')) continue;
      const file = path.join(f.dir, n);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      const sig = `${st.size}|${st.mtimeMs}`;
      if (state.get(file) !== sig) { state.set(file, sig); continue; } // first sight, or still being written
      // Still locked by the printer? Opening it for writing fails while it's being written on Windows.
      try { const fd = fs.openSync(file, 'r+'); fs.closeSync(fd); } catch { continue; }
      state.delete(file);
      try { await onFile(file, f); taken.push(file); } catch (e) { state.set(file, `failed|${e.message}`); }
    }
  }
  // Forget files that went away
  for (const k of [...state.keys()]) if (!fs.existsSync(k)) state.delete(k);
  return taken;
}

/** Watch the scan folders every few seconds. getFolders() is asked each time (departments can change). */
function watchScanFolders({ getFolders, onFile, intervalMs = 3000, onError = () => {} }) {
  const state = new Map();
  let busy = false; let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await pollOnce(getFolders(), state, onFile); } catch (e) { onError(e); } finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  setTimeout(tick, 200).unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}

module.exports = { scanFolders, networkPath, BRANDS, pollOnce, watchScanFolders, SCAN_EXT };
