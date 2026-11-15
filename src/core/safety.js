// Hard safety rule: Desk Assistant only ever touches personal files.
// Windows, program and system folders - and system file types - are never scanned, moved, renamed or deleted,
// whatever the settings say. Every place that moves or bins files checks this first.
const path = require('path');
const os = require('os');

const win = process.platform === 'win32';
const norm = (p) => { const r = path.resolve(String(p || '')); return win ? r.toLowerCase() : r; };

function systemFolders() {
  const home = os.homedir();
  const env = process.env;
  if (win) {
    const drive = (env.SystemDrive || 'C:') + '\\';
    return [
      env.SystemRoot || env.windir || path.join(drive, 'Windows'),
      env.ProgramFiles || path.join(drive, 'Program Files'),
      env['ProgramFiles(x86)'] || path.join(drive, 'Program Files (x86)'),
      env.ProgramW6432, env.ProgramData || path.join(drive, 'ProgramData'),
      env.APPDATA, env.LOCALAPPDATA, path.join(home, 'AppData'),
      path.join(drive, '$Recycle.Bin'), path.join(drive, 'System Volume Information'), path.join(drive, 'Recovery'),
      path.join(drive, 'Boot'), path.join(drive, 'PerfLogs'), path.join(drive, 'Config.Msi'), path.join(drive, 'Intel'),
      path.join(drive, 'Users', 'Default'), path.join(drive, 'Users', 'Public', 'Libraries'), path.join(drive, 'Windows.old'),
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return ['/System', '/Library', '/Applications', '/private', '/usr', '/bin', '/sbin', '/etc', '/var', '/opt', '/cores', '/Volumes/Recovery',
      path.join(home, 'Library'), path.join(home, 'Applications')];
  }
  return ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/proc', '/sys', '/dev', '/run', '/var', '/opt', '/snap', '/srv', '/root/.config',
    path.join(home, '.config'), path.join(home, '.local'), path.join(home, '.cache'), path.join(home, 'snap')];
}

/** Never touch these kinds of files, wherever they are. */
const PROTECTED_FILE = /^(desktop\.ini|thumbs\.db|ehthumbs\.db|iconcache\.db|ntuser\..*|pagefile\.sys|hiberfil\.sys|swapfile\.sys|bootmgr|\.ds_store|autorun\.inf)$/i;
const PROTECTED_EXT = new Set(['.lnk', '.url', '.website', '.appref-ms', '.ini', '.sys', '.dll', '.drv', '.ocx', '.cpl', '.msc', '.mui', '.cat', '.inf', '.reg', '.pf', '.etl', '.dat', '.lock']);

/** Is this folder (or anything inside it) off-limits? */
function isSystemPath(p) {
  const r = norm(p);
  return systemFolders().some((s) => { const n = norm(s); return r === n || r.startsWith(n + path.sep); });
}

/** Folders that are too broad to tidy as a whole: a drive root or your user folder itself. */
function isTooBroad(p) {
  const r = norm(p);
  return r === norm(os.homedir()) || r === norm(path.parse(path.resolve(p)).root) || (win && /^[a-z]:\\users\\?$/.test(r));
}

/** Can the app use this as a folder to tidy, search or clean up? Returns a reason if not. */
function folderProblem(p) {
  if (!p) return 'No folder chosen.';
  if (isTooBroad(p)) return 'That folder is too broad — pick a specific folder such as Desktop, Downloads or Documents.';
  if (isSystemPath(p)) return 'That is a Windows or program folder. Desk Assistant only works with your personal files, so it won\'t touch it.';
  return null;
}

/** Is this file off-limits (system file, shortcut, hidden) - or inside a system folder? */
function isProtectedFile(file) {
  const name = path.basename(String(file || ''));
  if (!name || name.startsWith('.') || name.startsWith('~$')) return true;
  if (PROTECTED_FILE.test(name) || PROTECTED_EXT.has(path.extname(name).toLowerCase())) return true;
  return isSystemPath(file);
}

module.exports = { isSystemPath, isTooBroad, folderProblem, isProtectedFile, systemFolders };
