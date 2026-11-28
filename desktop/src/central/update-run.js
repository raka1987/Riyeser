// Riyeser Central's "Update all" (Admin → Updates, the Updates panel, a tile's Update): the updates installed in turn.
//
// Why this exists: Central 1.9.0 ran each step bare inside one loop. The first error (the antivirus taking a freshly
// downloaded installer away, "ENOENT … stat", or Accounting Basics being open, Inno's exit code 5) stopped the whole
// loop, nothing after it ran, nothing went in the install log, and the window showed it only as a four-second toast
// before going back to "5 updates are ready". To the owner it looked as if Update all stopped at "Downloading … 100%".
// Now every update is tried, each failure is a plain reason with a fix (install-run.js), each step is logged, and
// Central's own update (which closes Central) waits until everything else went in.
//
// Plain Node with everything passed in, so the tests drive every path.
const installRun = require('./install-run');

/**
 * todo: the updates (updates.availableUpdates), Central's own last. deps:
 *   fileFor(u) -> where to save it; download(u, file, onPct); verify(u, file) -> { how };
 *   closeProgram(u) -> { closed: [names] } | null (before its installer); reopen(u) (after it, when it was closed);
 *   install(u, file, onElevate) (throws an Error with .failure from install-run.installFailure); selfInstall(u, file);
 *   tell(u, progress) (update-progress to the window); log(entry) (the install log); reported(u); platform.
 * -> { done: [ids], failed: [{ id, name, reason, message, fix, code }], restarting }
 */
async function runUpdates(todo, deps) {
  const d = { platform: process.platform, closeProgram: async () => null, reopen: () => {}, reported: () => {}, log: () => {}, tell: () => {}, ...deps };
  const done = []; const failed = [];
  for (const u of todo || []) {
    if (u.self && failed.length) {   // closing Central now would hide what went wrong: it updates with the next Try again
      failed.push({ id: u.id, name: u.name, reason: 'waiting', code: null, message: 'Riyeser Central updates itself once the other programs have updated.', fix: '' });
      continue;
    }
    const file = d.fileFor(u);
    let ran = false;   // the installer step writes its own log line
    try {
      if (d.platform !== 'win32') throw Object.assign(new Error('Updates install on Windows only.'), { failure: { reason: 'failed', message: 'Updates install on Windows only.' } });
      d.tell(u, { stage: 'downloading', pct: 0 });
      d.log({ id: u.id, version: u.to, file: String(file).split(/[\\/]/).pop(), stage: 'downloading', how: 'update' });
      try { await d.download(u, file, (pct) => d.tell(u, { stage: 'downloading', pct })); } catch (e) { throw Object.assign(e, { failure: installRun.updateFailure('download', e, { name: u.name }) }); }
      d.tell(u, { stage: 'checking', pct: 1 });
      let how = null;
      // an antivirus scanning the new file holds it for a few seconds: wait for it rather than give up
      try { how = ((await installRun.whileScanned(() => d.verify(u, file), d.scanWait)) || {}).how || null; } catch (e) {
        throw Object.assign(e, { failure: installRun.updateFailure('check', e, { name: u.name }) });
      }
      d.log({ id: u.id, version: u.to, stage: 'checked', how });
      if (u.self) {
        d.tell(u, { stage: 'restarting', pct: 1 });
        d.log({ id: u.id, version: u.to, stage: 'restarting', how: 'update' });
        await d.selfInstall(u, file);
        done.push(u.id);
        return { done, failed, restarting: true };
      }
      d.tell(u, { stage: 'installing', pct: 1, elevate: !!u.elevate });
      // "Programs being updated will close for a moment": closed properly first (the installer's own try can't close
      // every program and then stops with code 5), opened again afterwards
      const closed = await Promise.resolve(d.closeProgram(u)).catch(() => null);
      if (closed && closed.closed && closed.closed.length) d.log({ id: u.id, version: u.to, stage: 'closed', how: 'update', detail: closed.closed.join(', ') });
      ran = true;
      try { await d.install(u, file, () => d.tell(u, { stage: 'installing', pct: 1, elevate: true })); } catch (e) {
        if (e.failure && e.failure.reason === 'running') e.failure = { ...e.failure, fix: `Close ${u.name} (and check the taskbar's hidden icons), then click Try again.` };
        throw e;
      }
      if (closed && closed.closed && closed.closed.length) { try { d.reopen(u); } catch { /* opens next time */ } }
      done.push(u.id);
      d.reported(u);
    } catch (e) {
      const f = e.failure || installRun.updateFailure('check', e, { name: u.name });
      if (!ran) d.log({ id: u.id, version: u.to, stage: 'failed', reason: f.reason, code: f.code, detail: e.message, how: 'update' });
      failed.push({ id: u.id, name: u.name, reason: f.reason, code: f.code ?? null, message: f.message, fix: f.fix || '' });
      d.tell(u, { stage: 'failed', reason: f.reason, message: f.message, fix: f.fix || '' });
    }
  }
  return { done, failed, restarting: false };
}

module.exports = { runUpdates };
