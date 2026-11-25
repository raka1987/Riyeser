// Update checks for Riyeser Central: compares the versions installed on this PC with the latest public release
// (made by the "Publish Riyeser release" button) and installs newer ones in the background.
const RELEASE_API = 'https://api.github.com/repos/raka1987/Riyeser/releases/latest';
const ALLOWED_DOWNLOAD = /^https:\/\/(github\.com\/raka1987\/Riyeser\/releases\/download\/|objects\.githubusercontent\.com\/|release-assets\.githubusercontent\.com\/)/i;

// Each program: its name in Windows' installed-apps list, the release file, and how to install it silently.
const PRODUCTS = [
  { id: 'central', display: 'Riyeser Central', also: ['Riyser Central'], asset: 'RiyeserCentral-Setup.exe', oldAsset: 'RiyserCentral-Setup.exe', args: ['/S', '--updated'], self: true },
  { id: 'desk', display: 'Riyeser Desk Assistant', asset: 'RiyeserDeskAssistant-Setup.exe', args: ['/S'] },
  { id: 'pdf', display: 'Riyeser PDF', asset: 'RiyeserPDF-Setup.exe', oldAsset: 'RiyserPDF-Setup.exe', args: ['/S'] },
  // The old "Riyser" hub (Riyser 1.x) counts as Payroll, so Central offers to replace it with Riyeser Payroll.
  { id: 'payroll', display: 'Riyeser Payroll', alsoRe: /^Riyser\s+\d/i, asset: 'RiyeserPayroll-Setup.exe', args: ['/S'] },
  { id: 'services', display: 'As Built', also: ['Riyeser Services'], asset: 'RiyeserServices-Setup.exe', args: ['/S'] },
  // Two separate apps. The old single "Riyeser Accounting 1.x" counts as Plus, so it updates to Accounting Plus.
  { id: 'accounting-basics', display: 'Riyeser Accounting Basics', asset: 'RiyeserAccountingBasics-Setup.exe', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'] },
  // The till on its own (installs next to Accounting).
  { id: 'pos', display: 'Riyeser POS', asset: 'RiyeserPOS-Setup.exe', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'] },
  // Riyeser Link was called Riyeser Team (same app): Windows lists it under either name. M3: its release file is
  // RiyeserLink-Setup.exe; releases also keep RiyeserTeam-Setup.exe (the old download links and older Centrals).
  { id: 'team', display: 'Riyeser Link', also: ['Riyeser Team'], asset: 'RiyeserLink-Setup.exe', oldAsset: 'RiyeserTeam-Setup.exe', args: ['/S'] },
  // Installs for the whole PC, so Windows asks for permission when it installs or updates (for its firewall rule).
  { id: 'linkoffice', display: 'Riyeser Link Office', asset: 'RiyeserLinkOffice-Setup.exe', args: ['/S'] },
  { id: 'invoices', display: 'Riyeser Invoices', asset: 'RiyeserInvoices-Setup.exe', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'] },
  { id: 'bookings', display: 'Riyeser Bookings', asset: 'RiyeserBookings-Setup.exe', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'] },
  { id: 'accounting', display: 'Riyeser Accounting Plus', alsoRe: /^Riyeser Accounting\s+\d/i, asset: 'RiyeserAccountingPlus-Setup.exe', oldAsset: 'RiyeserAccounting-Setup.exe', args: ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'] },
];

/** "1.10.0" > "1.9.2" */
function newer(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

/** Latest versions from the release: a versions.json file if the release has one, else the "In this release" list. */
function latestFromRelease(release, versionsJson = null) {
  const out = {};
  for (const p of PRODUCTS) {
    const asset = (release.assets || []).find((a) => a.name === p.asset) || (release.assets || []).find((a) => p.oldAsset && a.name === p.oldAsset);
    let version = versionsJson && versionsJson[p.id];
    if (!version) {
      const names = [p.display, ...(p.also || [])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const m = String(release.body || '').match(new RegExp(`^\\s*[-*]\\s*(?:${names})\\s+v?(\\d+(?:\\.\\d+){1,3})`, 'mi'));
      version = m ? m[1] : null;
    }
    // digest: the SHA-256 GitHub publishes for the file ("sha256:…"), checked after downloading (S58)
    if (asset && version && ALLOWED_DOWNLOAD.test(asset.browser_download_url)) out[p.id] = { version, url: asset.browser_download_url, size: asset.size, name: asset.name, digest: asset.digest || null };
  }
  const sig = (release.assets || []).find((a) => a.name === 'installers.sig.json' && ALLOWED_DOWNLOAD.test(a.browser_download_url));
  return { tag: release.tag_name, name: release.name, published: release.published_at, products: out, manifestUrl: sig ? sig.browser_download_url : null };
}

/** Installed versions from `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall /s` output. */
function installedFromRegistry(text) {
  const out = {};
  for (const block of String(text || '').split(/\r?\n(?=HKEY_)/)) {
    const name = (block.match(/^\s*DisplayName\s+REG_SZ\s+(.+?)\s*$/mi) || [])[1];
    const ver = (block.match(/^\s*DisplayVersion\s+REG_SZ\s+(.+?)\s*$/mi) || [])[1];
    if (!name) continue;
    // The program whose name matches the longest part of the listed name ("Riyeser Link Office 1.0" is Link Office, not Link).
    let p = null; let best = -1;
    for (const q of PRODUCTS) {
      const len = Math.max(-1, ...[q.display, ...(q.also || [])].filter((n) => name.toLowerCase().startsWith(n.toLowerCase())).map((n) => n.length));
      const hit = len >= 0 ? len : (q.alsoRe && q.alsoRe.test(name) ? 0 : -1);
      if (hit > best) { best = hit; p = q; }
    }
    if (p) {
      const v = ver || (name.match(/(\d+(?:\.\d+){1,3})\s*$/) || [])[1] || null;
      // An old copy can still be listed next to the new one (e.g. the old "Riyser" hub next to Riyeser Payroll): keep the newest.
      if (!(p.id in out) || (v && (!out[p.id] || newer(v, out[p.id])))) out[p.id] = v;
    }
  }
  return out;
}

/** Which installed programs have a newer version. ownVersion: this Central's version. */
function availableUpdates(installed, latest) {
  return PRODUCTS.filter((p) => installed[p.id] && latest.products[p.id] && newer(latest.products[p.id].version, installed[p.id]))
    .map((p) => ({ id: p.id, name: p.display, from: installed[p.id], to: latest.products[p.id].version, url: latest.products[p.id].url, size: latest.products[p.id].size, self: !!p.self, args: p.args,
      file: latest.products[p.id].name || p.asset, digest: latest.products[p.id].digest || null }));
}

module.exports = { RELEASE_API, PRODUCTS, newer, latestFromRelease, installedFromRegistry, availableUpdates, ALLOWED_DOWNLOAD };
