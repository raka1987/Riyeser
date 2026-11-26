// Riyeser Central tells Riyeser which programs are on this PC (so Riyeser Support sees them in HQ) when the PC links,
// at the daily check-in, and also soon after the list changes: after Central installs or updates a program, and when
// its home screen finds a program appear or go. Changes close together are sent once (a short wait, reset by each one).
// report(): sends the list (Online.reportPrograms with onlyIfChanged, so an unchanged list isn't sent again).

const DELAY_MS = 30 * 1000;

/** What the home screen's program list says is installed, as one string to compare. */
function listKey(list) {
  return JSON.stringify((list || []).filter((p) => p && p.status === 'installed').map((p) => `${p.id}=${p.where || ''}`).sort());
}

function createReporter({ report, delayMs = DELAY_MS, timers = { setTimeout, clearTimeout } }) {
  let timer = null; let running = null; let again = false; let lastKey = null;
  const fire = () => {
    timer = null;
    if (running) { again = true; return running; }   // one at a time; send again afterwards with the newest list
    running = Promise.resolve().then(() => report()).catch(() => null).then((r) => {
      running = null;
      if (again) { again = false; soon(); }
      return r;
    });
    return running;
  };
  /** Send the list soon (each call restarts the short wait). */
  function soon() {
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(fire, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  /** The home screen's program list: when what's installed differs from last time (or it's the first look), send soon. */
  function seen(list) {
    const key = listKey(list);
    if (key === lastKey) return false;
    lastKey = key; soon();
    return true;
  }
  /** Send now instead of waiting (when one is waiting). */
  function flush() {
    if (timer) { timers.clearTimeout(timer); return fire(); }
    return running || Promise.resolve(null);
  }
  return { soon, seen, flush, waiting: () => !!timer };
}

module.exports = { createReporter, listKey, DELAY_MS };
