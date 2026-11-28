// Business details & branding on payslips (the same details as every other Riyeser program).
//
// Where they come from: Riyeser Central's company.json (%APPDATA%\Riyeser\company.json, written by Central's
// "Your business" step) and the logo saved next to it, when present; otherwise Payroll's own Settings (Business
// details & branding: name, legal name, tax number, address, phone, email, website and a logo kept in Payroll's own
// database, so it's in Payroll's backups). A field Central leaves blank falls back to Payroll's.
//
// Logos are PNG or JPG (what Central accepts), up to 2 MB. A PNG's empty margins (transparent, or the colour of its
// corner) are trimmed; a JPG is used as it is. Logos keep their proportions everywhere (never stretched).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const MAX_LOGO = 2 * 1024 * 1024;
// the label the tax number is printed with, by Central's country (ISO code); anything else: "Tax number"
const TAX_LABELS = { AU: 'ABN', NZ: 'IRD number', FJ: 'TIN', PG: 'TIN', WS: 'TIN', TO: 'TIN', VU: 'TIN', SB: 'TIN', GB: 'VAT no.', IE: 'VAT no.', ZA: 'VAT no.', SG: 'GST reg. no.', IN: 'GSTIN', CA: 'Business number', US: 'EIN' };

const appDataDir = (env = process.env) => env.APPDATA || path.join(os.homedir(), '.config');   // as Accounting and licence.js
function readCentral(env = process.env) {
  const f = path.join(appDataDir(env), 'Riyeser', 'company.json');
  let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  if (!c || typeof c !== 'object' || !String(c.name || '').trim()) return null;
  let logo = null;
  if (c.logo) {
    const p = path.isAbsolute(String(c.logo)) ? String(c.logo) : path.join(path.dirname(f), String(c.logo));
    try { const buf = fs.readFileSync(p); if (buf.length <= MAX_LOGO) logo = processLogo(buf); } catch { logo = null; }
  }
  const s = k => String(c[k] || '').trim();
  return { name: s('name'), legal_name: s('legal_name'), tax_number: s('tax_number'), address: s('address'), phone: s('phone'), email: s('email'), website: s('website'), country: s('country').toUpperCase(), logo };
}

// ---------------------------------------------------------------- PNG and JPG
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = b => b.length > 33 && b.subarray(0, 8).equals(PNG_SIG);
const isJpeg = b => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

function jpegInfo(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), comps: b[i + 9] };
    i += 2 + len;
  }
  return null;
}

/** An 8-bit, non-interlaced PNG as { w, h, rgb, alpha } (alpha null when it's all opaque); null when it can't be read. */
function decodePng(b) {
  if (!isPng(b)) return null;
  let i = 8, w, h, depth, type, interlace, plte = null, trns = null; const idat = [];
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i), t = b.toString('latin1', i + 4, i + 8), d = b.subarray(i + 8, i + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === 'PLTE') plte = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
    i += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!w || !h || depth !== 8 || interlace || !ch || w * h > 16e6 || (type === 3 && !plte)) return null;
  let raw; try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * ch; if (raw.length < h * (stride + 1)) return null;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch] : 0, u = y ? px[up + x] : 0, c = (x >= ch && y) ? px[up + x - ch] : 0, v = raw[src + x];
      let p;
      if (f === 0) p = v; else if (f === 1) p = v + a; else if (f === 2) p = v + u; else if (f === 3) p = v + ((a + u) >> 1);
      else if (f === 4) { const pp = a + u - c, pa = Math.abs(pp - a), pb = Math.abs(pp - u), pc = Math.abs(pp - c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c); }
      else return null;
      px[row + x] = p & 255;
    }
  }
  const rgb = Buffer.alloc(w * h * 3), alpha = Buffer.alloc(w * h, 255);
  for (let k = 0; k < w * h; k++) {
    const o = k * ch;
    if (type === 0) { rgb[k * 3] = rgb[k * 3 + 1] = rgb[k * 3 + 2] = px[o]; }
    else if (type === 4) { rgb[k * 3] = rgb[k * 3 + 1] = rgb[k * 3 + 2] = px[o]; alpha[k] = px[o + 1]; }
    else if (type === 3) { const n = px[o]; rgb[k * 3] = plte[n * 3]; rgb[k * 3 + 1] = plte[n * 3 + 1]; rgb[k * 3 + 2] = plte[n * 3 + 2]; if (trns && n < trns.length) alpha[k] = trns[n]; }
    else { rgb[k * 3] = px[o]; rgb[k * 3 + 1] = px[o + 1]; rgb[k * 3 + 2] = px[o + 2]; if (type === 6) alpha[k] = px[o + 3]; }
  }
  return { w, h, rgb, alpha: alpha.some(a => a < 255) ? alpha : null };
}

function chunk(type, data) {
  const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng({ w, h, rgb, alpha }) {
  const ch = alpha ? 4 : 3, raw = Buffer.alloc(h * (w * ch + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x, o = y * (w * ch + 1) + 1 + x * ch;
    raw[o] = rgb[k * 3]; raw[o + 1] = rgb[k * 3 + 1]; raw[o + 2] = rgb[k * 3 + 2]; if (alpha) raw[o + 3] = alpha[k];
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The picture without its empty margins (transparent, or the colour of the top-left corner), with a small margin. */
function trim(img) {
  const { w, h, rgb, alpha } = img, bg = [rgb[0], rgb[1], rgb[2]];
  const empty = k => alpha ? alpha[k] <= 8 : Math.abs(rgb[k * 3] - bg[0]) + Math.abs(rgb[k * 3 + 1] - bg[1]) + Math.abs(rgb[k * 3 + 2] - bg[2]) <= 40;
  let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!empty(y * w + x)) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  if (r < 0) return Math.min(...bg) < 235 && !alpha ? img : null;   // one solid colour block is kept; blank is refused
  const pad = Math.max(2, Math.round(Math.max(r - l, b - t) * 0.02));
  l = Math.max(0, l - pad); t = Math.max(0, t - pad); r = Math.min(w - 1, r + pad); b = Math.min(h - 1, b + pad);
  const nw = r - l + 1, nh = b - t + 1, nrgb = Buffer.alloc(nw * nh * 3), na = alpha ? Buffer.alloc(nw * nh) : null;
  for (let y = 0; y < nh; y++) {
    rgb.copy(nrgb, y * nw * 3, ((t + y) * w + l) * 3, ((t + y) * w + l + nw) * 3);
    if (alpha) alpha.copy(na, y * nw, (t + y) * w + l, (t + y) * w + l + nw);
  }
  return { w: nw, h: nh, rgb: nrgb, alpha: na };
}

class LogoError extends Error {}
/** A logo ready to use: { mime, data (Buffer), w, h }. Throws LogoError with a plain-English reason. */
function processLogo(buf) {
  if (!buf || !buf.length) throw new LogoError('Choose a picture of your logo first.');
  if (buf.length > MAX_LOGO) throw new LogoError(`That picture is ${(buf.length / 1048576).toFixed(1)} MB. Choose one under 2 MB (a PNG or JPG of your logo).`);
  if (isJpeg(buf)) {
    const j = jpegInfo(buf); if (!j || !j.w || !j.h) throw new LogoError("That picture couldn't be opened (it may be damaged). Save your logo again and try again.");
    return { mime: 'image/jpeg', data: buf, w: j.w, h: j.h };
  }
  if (!isPng(buf)) throw new LogoError("That file isn't a PNG or JPG picture. Save your logo as one of those and try again.");
  const img = decodePng(buf);
  if (!img) throw new LogoError("That PNG couldn't be read (save it as an ordinary 8-bit PNG, or as a JPG).");
  const t = trim(img); if (!t) throw new LogoError('That picture is empty (all one colour). Choose the picture of your logo.');
  return { mime: 'image/png', data: t === img ? buf : encodePng(t), w: t.w, h: t.h };
}

// ---------------------------------------------------------------- the brand
/** name, legal_name, tax_label, tax_number, tax_line, address_lines, contact_lines, logo ({mime, data, w, h, uri}) */
function brand(settings, ownLogo, env = process.env) {
  const s = settings || {}, c = readCentral(env) || {};
  const pick = (central, own) => String(c[central] || s[own] || '').trim();
  const name = pick('name', 'company_name'), legal = pick('legal_name', 'company_legal_name');
  const label = String(s.company_tax_label || '').trim() || TAX_LABELS[c.country] || 'Tax number';
  const tax = pick('tax_number', 'company_tax_number');
  const logo = c.logo || ownLogo || null;
  const contact = [pick('phone', 'phone'), pick('email', 'email'), pick('website', 'company_website')].filter(Boolean);
  return {
    name, legal_name: legal && legal.toLowerCase() !== name.toLowerCase() ? legal : '', tax_label: label, tax_number: tax, tax_line: tax ? `${label} ${tax}` : '',
    address_lines: pick('address', 'address').split(/[\r\n]+/).map(x => x.trim()).filter(Boolean), contact_lines: contact,
    logo: logo && { ...logo, uri: `data:${logo.mime};base64,${Buffer.from(logo.data).toString('base64')}` }, from_central: !!c.name, logo_from_central: !!c.logo,
  };
}
/** The same brand without the logo's bytes (for the browser, which only needs its data URI). */
const forBrowser = b => ({ ...b, logo: b.logo ? { uri: b.logo.uri, w: b.logo.w, h: b.logo.h, mime: b.logo.mime } : null });
/** w x h inside maxW x maxH with the logo's own proportions */
const fit = (logo, maxW, maxH) => { const r = logo.w / logo.h, w = Math.min(maxW, maxH * r); return { w, h: w / r }; };

/** Payroll's own logo (Settings, Business details & branding), kept in Payroll's database: { mime, data, w, h } or null. */
function ownLogo(db) {
  db.exec('CREATE TABLE IF NOT EXISTS brand_logo (id INTEGER PRIMARY KEY CHECK (id = 1), mime TEXT NOT NULL, data BLOB NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL)');
  const r = db.prepare('SELECT mime, data, w, h FROM brand_logo WHERE id = 1').get();
  return r ? { mime: r.mime, data: Buffer.from(r.data), w: r.w, h: r.h } : null;
}
function saveLogo(db, logo) { ownLogo(db); db.prepare('INSERT INTO brand_logo(id, mime, data, w, h) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mime=excluded.mime, data=excluded.data, w=excluded.w, h=excluded.h').run(logo.mime, logo.data, logo.w, logo.h); }
function removeLogo(db) { ownLogo(db); db.prepare('DELETE FROM brand_logo').run(); }

module.exports = { ownLogo, saveLogo, removeLogo, brand, forBrowser, processLogo, decodePng, encodePng, trim, jpegInfo, readCentral, fit, LogoError, MAX_LOGO, TAX_LABELS };
