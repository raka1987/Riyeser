/* Riyeser POS: barcode scanners (POS 2.11.1).
   Most USB scanners are "keyboard wedge" scanners: they type the code very fast, then press Enter. A scan is told
   apart from a person typing by its speed: at least MIN_LEN characters, each within MAX_GAP ms of the last, ending in
   Enter. Normal typing (slower) is left alone, so search boxes keep working.
   createDetector() is plain logic (no DOM) so it can be tested in Node: feed it key events with times. */
(function (root) {
  const MAX_GAP = 50, MIN_LEN = 4;

  function strip(code, prefix, suffix) {
    let c = String(code || '');
    if (prefix && c.startsWith(prefix)) c = c.slice(prefix.length);
    if (suffix && c.endsWith(suffix)) c = c.slice(0, c.length - suffix.length);
    return c.trim();
  }

  function looksScanned(gaps) {
    if (!gaps || gaps.length < MIN_LEN - 1) return false;
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return avg <= MAX_GAP * 0.8 && Math.max.apply(null, gaps) <= MAX_GAP * 2;
  }

  /* opts: {prefix, suffix, onScan(code, info)}. key(k, t, target) returns:
       'scan'   -> Enter ended a scan: onScan was called; the caller stops the Enter and undoes the typed characters
       'pass'   -> leave the key alone. info.typedInto is the element the scan's characters went into, info.length
                   how many characters to take back out of it. */
  function createDetector(opts) {
    opts = opts || {};
    let buf = '', last = 0, gaps = [], target = null;
    function reset() { buf = ''; gaps = []; target = null; }
    return {
      key(k, t, el) {
        if (k === 'Enter') {
          const ok = buf.length >= MIN_LEN && looksScanned(gaps) && t - last <= MAX_GAP * 2;
          const raw = buf, into = target, g = gaps.slice();
          reset();
          if (!ok) return 'pass';
          const code = strip(raw, opts.prefix, opts.suffix);
          if (!code) return 'pass';
          if (opts.onScan) opts.onScan(code, { raw, typedInto: into, length: raw.length, gaps: g });
          return 'scan';
        }
        if (k.length !== 1) return 'pass';
        if (buf && t - last > MAX_GAP * 2) reset();   // a pause: this is someone typing, start again
        if (buf) gaps.push(t - last);
        else target = el || null;
        buf += k; last = t;
        return 'pass';
      },
      reset,
    };
  }

  let ctx = null;
  function beep(good) {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = good ? 1760 : 330; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (good ? 0.07 : 0.25));
    } catch (e) { /* no sound on this computer */ }
  }

  /* In the page: listen in the capture phase. capture: true sends scans to the sale even when another box has the
     focus (the characters it typed there are taken back out). */
  function attach(opts) {
    const det = createDetector(Object.assign({}, opts, {
      onScan(code, info) {
        const el = info.typedInto;   // take the scan's characters back out of the box they went into
        if (el && 'value' in el && typeof el.value === 'string' && el.value.endsWith(info.raw)) {
          el.value = el.value.slice(0, el.value.length - info.raw.length);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (opts.onScan) opts.onScan(code, info);
      },
    }));
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target;
      if (!opts.capture && el && el.matches && el.matches('input,textarea,select') && !(opts.owns && opts.owns(el))) return;
      if (det.key(e.key, e.timeStamp || performance.now(), el) === 'scan') { e.preventDefault(); e.stopPropagation(); }
    }, true);
    return det;
  }

  const api = { createDetector, strip, looksScanned, attach, beep, MAX_GAP, MIN_LEN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RiyeserScanner = api;
})(typeof window !== 'undefined' ? window : this);
