// Riyeser Central: running a downloaded installer, and what to tell the person when it doesn't work.
//
// Why this exists: Riyeser Link Office installs for the whole PC (perMachine: true), so its installer asks Windows for
// administrator rights (RequestExecutionLevel admin, a "requireAdministrator" manifest). Starting such a file the way
// Central started every installer (child_process.spawn, i.e. CreateProcess) never shows the Windows permission prompt:
// Windows refuses it with ERROR_ELEVATION_REQUIRED (740), which Node reports as "spawn EACCES". Central showed that as a
// four-second toast and the tile went straight back to "Install". Now:
//   - programs that install for the whole PC are started through Windows' "Run as administrator" (ShellExecute runas,
//     via PowerShell's Start-Process -Verb RunAs), so the permission prompt appears, and Central waits for the exit code;
//   - a per-user installer that unexpectedly needs permission is retried the same way;
//   - every result becomes a plain message with a fix (installFailure), and Central checks the program is really there
//     afterwards before it says "Installed".
// Everything here is plain Node with spawn passed in, so the tests (and the Windows runner) can drive it.

const NSIS_SILENT = ['/S'];
const isInno = (args) => (args || []).some((a) => /^\/VERYSILENT$/i.test(a));

/** Windows error and exit codes Central knows how to explain. */
const CODES = {
  CANCELLED: 1223,          // ERROR_CANCELLED: the person chose No on the Windows permission prompt
  ELEVATION_REQUIRED: 740,  // ERROR_ELEVATION_REQUIRED: started without asking Windows for permission
  ACCESS_DENIED: 5,
  VIRUS: 225,               // ERROR_VIRUS_INFECTED: Windows Security / antivirus blocked the file
  VIRUS_DELETED: 226,       // ERROR_VIRUS_DELETED
  BLOCKED_POLICY: 1260,     // ERROR_ACCESS_DISABLED_BY_POLICY (Smart App Control, AppLocker, company policy)
  BLOCKED_WDAC: 4551,       // ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION
};
// Marker the PowerShell helper prints when Windows itself refused to start the installer.
const PS_MARK = 'RIYESER-START-ERROR';
const PS_FAILED = 7777;   // the helper's exit code when Start-Process threw (details in PS_MARK)

/** Quote a value for a PowerShell single-quoted string. */
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The PowerShell that starts an installer with "Run as administrator" (shows the Windows permission prompt), waits for
 * it and exits with its exit code. When Windows refuses to start it (No on the prompt, blocked file) it prints
 * "RIYESER-START-ERROR <win32 code> <message>" and exits 7777.
 */
function elevatedScript(file, args) {
  const argList = (args || []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $p = Start-Process -FilePath ${psq(file)}${argList ? ` -ArgumentList ${psq(argList)}` : ''} -Verb RunAs -PassThru`,
    '  $null = $p.Handle',   // keeps the process handle so ExitCode is readable after it exits
    '  $p.WaitForExit()',
    '  exit [int]$p.ExitCode',
    '} catch {',
    '  $e = $_.Exception; $n = 0',
    '  while ($e) { if ($e -is [System.ComponentModel.Win32Exception]) { $n = $e.NativeErrorCode; break }; $e = $e.InnerException }',
    `  [Console]::Out.WriteLine("${PS_MARK} " + $n + " " + $_.Exception.Message)`,
    `  exit ${PS_FAILED}`,
    '}',
  ].join('\n');
}

/** How to start the installer: { command, args, options }. elevate: through Windows' permission prompt. */
function launchPlan({ file, args = NSIS_SILENT, elevate = false }) {
  if (!elevate) return { command: file, args: [...args], options: { windowsHide: true }, elevated: false };
  const encoded = Buffer.from(elevatedScript(file, args), 'utf16le').toString('base64');
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    options: { windowsHide: true }, elevated: true };
}

/** Node's spawn error -> the Windows code it stands for (spawn EACCES on Windows is ERROR_ELEVATION_REQUIRED or 5). */
function spawnErrorCode(err) {
  if (!err) return null;
  const m = /\b(\d{3,4})\b/.exec(String(err.message || ''));
  if (err.code === 'EACCES') return CODES.ELEVATION_REQUIRED;
  if (err.code === 'EPERM') return CODES.ACCESS_DENIED;
  if (err.code === 'ENOENT') return 'missing';
  return m ? Number(m[1]) : null;
}

/**
 * Run one installer and wait for it. Never throws: resolves { code, startError, elevated, ms, output }.
 *   code: the installer's exit code (null when it never started)
 *   startError: why Windows didn't start it (a Windows code like 740 / 1223 / 225, 'missing' or 'timeout'), or null
 * spawn: child_process.spawn (or a stand-in in tests). retryElevated: when a normal start needs permission, ask for it.
 */
function runInstaller({ file, args, elevate = false, spawn, timeoutMs = 15 * 60 * 1000, retryElevated = true, now = Date.now }) {
  const once = (up) => new Promise((resolve) => {
    const plan = launchPlan({ file, args, elevate: up });
    const t0 = now(); let out = ''; let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, elevated: up, ms: now() - t0, output: out.slice(-2000) }); };
    let child;
    try { child = spawn(plan.command, plan.args, plan.options); } catch (e) { finish({ code: null, startError: spawnErrorCode(e) || 'start', detail: e.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ code: null, startError: 'timeout' }); }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => { out += String(d); });
    if (child.stderr) child.stderr.on('data', (d) => { out += String(d); });
    child.on('error', (e) => finish({ code: null, startError: spawnErrorCode(e) || 'start', detail: e.message }));
    child.on('exit', (code) => {
      if (up && code === PS_FAILED) {
        const m = new RegExp(`${PS_MARK} (\\d+) ?(.*)`).exec(out);
        const n = m ? Number(m[1]) : 0;
        finish({ code: null, startError: n || 'start', detail: m ? m[2].trim() : out.trim() });
        return;
      }
      finish({ code, startError: null });
    });
  });
  return once(!!elevate).then((r) => {
    if (!elevate && retryElevated && (r.startError === CODES.ELEVATION_REQUIRED || r.startError === CODES.ACCESS_DENIED)) {
      return once(true).then((r2) => ({ ...r2, retried: true, firstError: r.startError }));
    }
    return r;
  });
}

/**
 * What happened, in plain words: { ok, reason, message, fix, code }. result: from runInstaller. name: "Riyeser Link Office".
 * reasons: installed | cancelled | needs-permission | blocked | missing | timeout | running | failed
 */
function installFailure(result, { name = 'The program', args = NSIS_SILENT } = {}) {
  const r = result || {};
  const se = r.startError;
  if (se == null && r.code === 0) return { ok: true, reason: 'installed', message: `${name} is installed.` };
  if (se === CODES.CANCELLED) {
    return { ok: false, reason: 'cancelled', code: se,
      message: `You chose No when Windows asked for permission, so ${name} wasn't installed.`,
      fix: `${name} installs for everyone on this PC, so Windows has to allow it. Click Install again and choose Yes (you may need a Windows administrator's password).` };
  }
  if (se === CODES.ELEVATION_REQUIRED || se === CODES.ACCESS_DENIED) {
    return { ok: false, reason: 'needs-permission', code: se,
      message: `Windows didn't let ${name} install: it needs permission from a Windows administrator on this PC.`,
      fix: 'Click Install again and choose Yes when Windows asks. If you can\'t, ask whoever looks after this PC to sign in and install it.' };
  }
  if (se === CODES.VIRUS || se === CODES.VIRUS_DELETED || se === CODES.BLOCKED_POLICY || se === CODES.BLOCKED_WDAC || se === 'missing') {
    return { ok: false, reason: 'blocked', code: se,
      message: `Windows (or your antivirus) blocked the ${name} installer, so it didn't run.`,
      fix: 'Download it from riyeser.com and open it. If Windows says “Windows protected your PC”, click More info → Run anyway. If your antivirus removed it, allow it there and try again.' };
  }
  if (se === 'timeout') {
    return { ok: false, reason: 'timeout', code: se,
      message: `${name} took too long to install and was stopped.`,
      fix: 'Restart the PC and try again. If it happens again, click Get help.' };
  }
  if (se) {
    return { ok: false, reason: 'failed', code: se,
      message: `Windows couldn't start the ${name} installer${typeof se === 'number' ? ` (code ${se})` : ''}.`,
      fix: 'Try again. If it happens again, click Get help: Riyeser Support gets the details.' };
  }
  // The installer ran and stopped with an error.
  const inno = isInno(args);
  if ((inno && (r.code === 5 || r.code === 2)) || (!inno && r.code === 1)) {
    return { ok: false, reason: 'running', code: r.code,
      message: `${name}'s installer stopped before it finished (code ${r.code}). This usually means ${name} is open.`,
      fix: `Close ${name} (and check the taskbar's hidden icons), then click Install again.` };
  }
  return { ok: false, reason: 'failed', code: r.code,
    message: `Install failed (code ${r.code}).`,
    fix: 'Try again. If it happens again, click Get help: Riyeser Support gets the details.' };
}

/** The installer said it worked but the program isn't on this PC: say so instead of going back to Install. */
function notFoundAfterInstall(name) {
  return { ok: false, reason: 'not-found',
    message: `The installer finished, but Central can't find ${name} on this PC.`,
    fix: 'Use Locate… to point Central to it, or click Get help.' };
}

// ---------- the states a tile shows ----------
// idle -> downloading -> checking -> installing -> verifying -> installed
//                          any step -> failed (with reason, message, fix) -> (Try again) downloading
const STAGES = ['idle', 'downloading', 'checking', 'installing', 'verifying', 'installed', 'failed'];
const NEXT = {
  idle: ['downloading', 'failed'],
  downloading: ['downloading', 'checking', 'failed'],
  checking: ['installing', 'failed'],
  installing: ['verifying', 'failed'],
  verifying: ['installed', 'failed'],
  installed: ['downloading'],   // an update later
  failed: ['downloading', 'idle'],
};

/** One step of an install's state: step(state, event) -> new state (an unexpected step is ignored). */
function step(state, ev) {
  const s = state || { stage: 'idle' };
  if (!ev || !STAGES.includes(ev.stage)) return s;
  if (!(NEXT[s.stage] || []).includes(ev.stage)) return s;
  const out = { id: ev.id || s.id, stage: ev.stage };
  if (ev.stage === 'downloading') out.pct = Math.max(0, Math.min(1, Number(ev.pct) || 0));
  if (ev.stage === 'installing') out.elevate = !!ev.elevate;
  if (ev.stage === 'installed') out.version = ev.version || null;
  if (ev.stage === 'failed') Object.assign(out, { reason: ev.reason || 'failed', message: ev.message || 'Install failed.', fix: ev.fix || '', code: ev.code ?? null, ref: ev.ref || null });
  return out;
}

/** What a tile says for a state. */
function stateText(s, name = 'it') {
  if (!s) return '';
  switch (s.stage) {
    case 'downloading': return `Downloading… ${Math.round((s.pct || 0) * 100)}%`;
    case 'checking': return 'Checking the download…';
    case 'installing': return s.elevate ? 'Installing… Windows will ask for permission: choose Yes' : 'Installing…';
    case 'verifying': return 'Finishing…';
    case 'installed': return `Installed ✓ ${name} is ready.`;
    case 'failed': return s.message || 'Install failed.';
    default: return '';
  }
}

/** One line for Central's install log (JSON, no personal details: program, version, codes, timings). */
function logEntry(e) {
  const pick = (({ id, version, file, stage, elevated, retried, firstError, code, startError, reason, ms, detected, detail, how }) =>
    ({ id, version, file, stage, elevated, retried, firstError, code, startError, reason, ms, detected, detail: detail ? String(detail).slice(0, 300) : undefined, how }))(e || {});
  Object.keys(pick).forEach((k) => pick[k] === undefined && delete pick[k]);
  return `${new Date(e && e.at ? e.at : Date.now()).toISOString()} install ${JSON.stringify(pick)}`;
}

module.exports = { CODES, PS_MARK, PS_FAILED, elevatedScript, launchPlan, spawnErrorCode, runInstaller, installFailure, notFoundAfterInstall,
  STAGES, step, stateText, logEntry, isInno };
