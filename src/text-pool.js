// Hands text extraction to a background process, one file at a time, with a time limit per file.
// A file that takes too long is skipped (the helper is restarted), so one bad file can't stop a whole scan.
const path = require('path');
const { utilityProcess } = require('electron');

const TIME_LIMIT_MS = +process.env.DESK_READ_LIMIT_MS || 45_000;

function createTextPool({ log = () => {} } = {}) {
  let child = null; let busy = null; const queue = []; let nextId = 1;

  const start = () => {
    child = utilityProcess.fork(path.join(__dirname, 'text-worker.js'), [], { serviceName: 'Desk Assistant file reader' });
    const me = child;
    child.on('message', (m) => {
      if (!busy || m.id !== busy.id) return;
      const job = busy; busy = null; clearTimeout(job.timer);
      m.ok ? job.resolve(m.result) : job.reject(new Error(m.error));
      pump();
    });
    child.on('exit', () => {
      if (child !== me) return;
      child = null;
      if (busy) { const job = busy; busy = null; clearTimeout(job.timer); job.reject(new Error('the file reader stopped')); }
      pump();
    });
  };

  const pump = () => {
    if (busy || !queue.length) return;
    if (!child) start();
    busy = queue.shift();
    const job = busy;
    job.timer = setTimeout(() => {
      if (busy !== job) return;
      log(`Skipped (took too long to read): ${job.file}`);
      busy = null;
      const stuck = child; child = null;
      try { stuck.kill(); } catch { /* already gone */ }
      job.reject(new Error('took too long to read'));
      pump();
    }, TIME_LIMIT_MS);
    child.postMessage({ id: job.id, file: job.file });
  };

  return {
    extract: (file) => new Promise((resolve, reject) => { queue.push({ id: nextId++, file, resolve, reject }); pump(); }),
    stop: () => { queue.length = 0; if (child) { try { child.kill(); } catch { /* ignore */ } child = null; } },
  };
}

module.exports = { createTextPool };
