// The Back up / Restore buttons every Riyeser desktop program has (OWNER-BACKUP), in its menu and its Settings:
//   "Back up now", "Open the backups folder", "Restore from a backup…" (pick a file -> see what's in it -> a
//   before-restore copy is saved -> restart), an automatic backup once a day, and on a PC with no data yet the
//   choice "Start fresh" or "Restore from a backup…". backup.js does the work; this is the Electron side.
const path = require('path');
const B = require('./backup');

/**
 * opts: { app, dialog, shell, spec, win: () => BrowserWindow|null, name (shown, e.g. "Riyeser Desk Assistant"),
 *         beforeRestart: () => void (close what has the data open) }
 */
function backupUi({ app, dialog, shell, spec, win = () => null, name, beforeRestart = () => {} }) {
  const docs = () => ({ documents: app.getPath('documents') });
  const folder = () => B.backupsDir(spec.program, docs());
  const parent = () => { const w = win(); return w && !w.isDestroyed() ? w : undefined; };
  const ui = {
    folder,
    async backUpNow({ quiet = false } = {}) {
      const r = await B.createBackup(spec, docs());
      if (!quiet) {
        const a = await dialog.showMessageBox(parent(), { type: 'info', buttons: ['OK', 'Open the backups folder'], defaultId: 0, title: name,
          message: `${name} is backed up`, detail: `Saved ${path.basename(r.file)} in\n${path.dirname(r.file)}\n\nCopy that folder to a USB stick or OneDrive to keep a copy away from this PC.` });
        if (a.response === 1) shell.openPath(path.dirname(r.file));
      }
      return r;
    },
    openFolder() { require('fs').mkdirSync(folder(), { recursive: true }); return shell.openPath(folder()); },
    /** Pick a backup, show what's in it, then restart to put it back (a before-restore copy is made first). */
    async restoreFromBackup() {
      const pick = await dialog.showOpenDialog(parent(), { title: `Restore ${name} from a backup`, defaultPath: folder(), properties: ['openFile'],
        filters: [{ name: 'Riyeser backups', extensions: ['zip'] }] });
      if (pick.canceled || !pick.filePaths[0]) return false;
      const file = pick.filePaths[0];
      let info;
      try {
        info = await B.describeBackup(file);
        if (info.program !== spec.program && !(spec.accepts || []).includes(info.program)) throw new Error(`That's a backup of Riyeser ${info.program}, not ${name}.`);
        if (!info.parts.some((p) => spec.parts.some((q) => q.id === p.id))) throw new Error(`That backup has nothing for ${name}.`);
      } catch (e) { await dialog.showMessageBox(parent(), { type: 'error', title: name, message: 'This backup can\'t be used', detail: e.message }); return false; }
      const mine = { ...info, parts: info.parts.filter((p) => spec.parts.some((q) => q.id === p.id)) };
      const a = await dialog.showMessageBox(parent(), { type: 'question', buttons: ['Restore and restart', 'Cancel'], defaultId: 0, cancelId: 1, title: name,
        message: `Put ${name} back to how it was in this backup?`,
        detail: `${B.summary(mine)}\n\nA copy of everything as it is now is saved in the backups folder first ("before restore"). ${name} restarts.` });
      if (a.response !== 0) return false;
      B.scheduleRestore(app.getPath('userData'), file);
      try { beforeRestart(); } catch { /* restarting anyway */ }
      app.relaunch(); app.exit(0);
      return true;
    },
    /** At start, before the data is opened: finish a restore that was asked for. Shows the result once a window is up. */
    async applyPending() {
      const r = await B.applyPendingRestore(app.getPath('userData'), spec, docs());
      if (r) ui.pendingResult = r;
      return r;
    },
    async showPendingResult() {
      const r = ui.pendingResult; ui.pendingResult = null;
      if (!r) return;
      await dialog.showMessageBox(parent(), r.ok
        ? { type: 'info', title: name, message: `${name} is restored`, detail: `Your backup is back in place.\n\nWhat was here before is kept in:\n${r.before}` }
        : { type: 'error', title: name, message: 'The restore didn\'t work', detail: `${r.error}\nNothing was changed.` });
    },
    /** The automatic backup: once a day, the last 30 kept. */
    startDaily() {
      const run = () => B.dailyBackup(spec, docs()).catch(() => null);
      setTimeout(run, 60 * 1000); setInterval(run, 6 * 3600 * 1000);
    },
    /** A PC with no data yet: "Start fresh" or "Restore from a backup…". true when a restore was started. */
    async firstRunOffer() {
      const a = await dialog.showMessageBox(parent(), { type: 'question', buttons: ['Start fresh', 'Restore from a backup…'], defaultId: 0, cancelId: 0, title: name,
        message: `Welcome to ${name}`, detail: 'Starting on a new PC, or after reinstalling Windows? You can bring back a Riyeser backup (from Documents\\Riyeser, a USB stick or OneDrive).' });
      return a.response === 1 ? ui.restoreFromBackup() : false;
    },
    menuItems() {
      return [
        { label: 'Back up now', click: () => ui.backUpNow().catch((e) => dialog.showErrorBox(name, e.message)) },
        { label: 'Restore from a backup…', click: () => ui.restoreFromBackup().catch((e) => dialog.showErrorBox(name, e.message)) },
        { label: 'Open the backups folder', click: () => ui.openFolder() },
      ];
    },
    /** For Settings pages (IPC): the backups folder, the newest backups. */
    status() { return { folder: folder(), backups: B.listBackups(folder()).slice(0, 5).map((b) => ({ name: b.name, when: b.when, beforeRestore: b.beforeRestore })) }; },
  };
  return ui;
}

module.exports = { backupUi };
