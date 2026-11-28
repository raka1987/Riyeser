// Riyeser PDF: "My details" (for Fill my details in forms) and the date format used on stamps.
// Saved in Riyeser PDF's own data folder. Anything left empty is filled in from the business profile Riyeser Central
// keeps in %APPDATA%\Riyeser\company.json, when there is one, so most people never type it.

const FIELDS = ['name', 'business', 'taxLabel', 'taxNumber', 'address', 'phone', 'email'];
const DATE_FORMATS = ['system', 'dmy', 'mdy', 'ymd', 'dmmmy'];

const clean = (v) => (v == null ? '' : String(v).trim().slice(0, 300));

/** The details company.json can give (only what is there; nothing is guessed). */
function profileFromCompany(c) {
  if (!c || typeof c !== 'object') return {};
  const out = {
    name: clean(c.your_name),
    business: clean(c.legal_name) || clean(c.name),
    taxNumber: clean(c.tax_number),
    address: clean(c.address),
    phone: clean(c.phone),
    email: clean(c.email) || clean(c.email_signed_in),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

/** saved: what was saved in Riyeser PDF; company: company.json (or null). Saved values win; empty ones are filled in. */
function mergeProfile(saved = {}, company = null) {
  const fromCo = profileFromCompany(company);
  const p = {};
  const filled = [];
  for (const k of FIELDS) {
    const mine = clean(saved[k]);
    if (mine) p[k] = mine;
    else if (fromCo[k]) { p[k] = fromCo[k]; filled.push(k); }
    else p[k] = '';
  }
  if (!p.taxLabel) p.taxLabel = 'Tax number';
  return { profile: p, fromCompany: filled };
}

/** The date format for stamps: saved choice, else company.json's date_format when it has one, else Windows' own. */
function dateFormatFor(savedChoice, company) {
  if (DATE_FORMATS.includes(savedChoice) && savedChoice !== 'system') return savedChoice;
  const co = company && String(company.date_format || '').toLowerCase();
  if (co === 'iso') return 'ymd';
  if (DATE_FORMATS.includes(co) && co !== 'system') return co;
  return 'system';
}

function saveProfile(store, data) {
  const p = {};
  for (const k of FIELDS) p[k] = clean(data && data[k]);
  store.set('profile', p);
  return p;
}

module.exports = { FIELDS, DATE_FORMATS, profileFromCompany, mergeProfile, dateFormatFor, saveProfile };
