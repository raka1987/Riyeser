// The shapes websites send (the contract: docs/api/openapi.yaml). Each validator returns the cleaned payload (only
// the fields we know, strings trimmed, control characters removed, currency upper-cased) or a list of plain-English
// problems, each with the field it's about. Unknown fields are dropped (put extras in "metadata").

export type Problem = { field: string; message: string };
type Ctx = { problems: Problem[] };
type V<T = unknown> = (v: unknown, field: string, c: Ctx) => T | undefined;

export const SKU = /^[A-Za-z0-9._/-]{1,64}$/;
export const REF = /^[A-Za-z0-9._/#-]{1,64}$/;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PHONE = /^[0-9+()\-. ]{3,40}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// deno-lint-ignore no-control-regex
const CONTROL_ALL = /[\u0000-\u001F\u007F]/g;

const bad = (c: Ctx, field: string, message: string) => { c.problems.push({ field, message }); return undefined; };

function str(max: number, o: { required?: boolean; pattern?: RegExp; patternMsg?: (f: string) => string; multiline?: boolean } = {}): V<string> {
  return (v, f, c) => {
    if (v === undefined || v === null || v === "") return o.required ? bad(c, f, `${f} is needed.`) : undefined;
    if (typeof v !== "string") return bad(c, f, `${f} must be text.`);
    const s = v.replace(o.multiline ? CONTROL : CONTROL_ALL, o.multiline ? "" : " ").trim();
    if (!s) return o.required ? bad(c, f, `${f} is needed.`) : undefined;
    if (s.length > max) return bad(c, f, `${f} is too long (${max} characters at most).`);
    if (o.pattern && !o.pattern.test(s)) return bad(c, f, o.patternMsg ? o.patternMsg(f) : `${f} isn't in the right format.`);
    return s;
  };
}
function num(o: { min?: number; max?: number; above?: number; int?: boolean; decimals?: number; required?: boolean } = {}): V<number> {
  return (v, f, c) => {
    if (v === undefined || v === null) return o.required ? bad(c, f, `${f} is needed.`) : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) return bad(c, f, `${f} must be a number.`);
    if (o.int && !Number.isInteger(v)) return bad(c, f, `${f} must be a whole number.`);
    if (o.above !== undefined && !(v > o.above)) return bad(c, f, `${f} must be more than ${o.above}.`);
    if (o.min !== undefined && v < o.min) return bad(c, f, `${f} must be at least ${o.min}.`);
    if (o.max !== undefined && v > o.max) return bad(c, f, `${f} must be at most ${o.max}.`);
    if (o.decimals !== undefined && Math.abs(Math.round(v * 10 ** o.decimals) - v * 10 ** o.decimals) > 1e-6) {
      return bad(c, f, `${f} can have at most ${o.decimals} decimal places.`);
    }
    return v;
  };
}
const bool: V<boolean> = (v, f, c) => v === undefined || v === null ? undefined : typeof v === "boolean" ? v : bad(c, f, `${f} must be true or false.`);
function oneOf(values: string[], required = false): V<string> {
  return (v, f, c) => {
    if (v === undefined || v === null || v === "") return required ? bad(c, f, `${f} is needed (one of: ${values.join(", ")}).`) : undefined;
    return typeof v === "string" && values.includes(v) ? v : bad(c, f, `${f} must be one of: ${values.join(", ")}.`);
  };
}
function datetime(required = false): V<string> {
  return (v, f, c) => {
    if (v === undefined || v === null || v === "") return required ? bad(c, f, `${f} is needed (a date and time like 2026-12-01T09:30:00+13:00).`) : undefined;
    if (typeof v !== "string" || !DATETIME.test(v) || Number.isNaN(Date.parse(v))) {
      return bad(c, f, `${f} must be a date and time with its time zone, like 2026-12-01T09:30:00+13:00 or 2026-11-30T20:30:00Z.`);
    }
    return new Date(v).toISOString();
  };
}
const email: V<string> = (v, f, c) => {
  const s = str(200)(v, f, c);
  if (s === undefined) return undefined;
  return EMAIL.test(s) ? s.toLowerCase() : bad(c, f, `${f} doesn't look like an email address.`);
};
const phone = str(40, { pattern: PHONE, patternMsg: (f) => `${f} can only have digits, spaces and + ( ) - .` });
const currency: V<string> = (v, f, c) => {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : bad(c, f, `${f} must be a 3-letter currency code, like NZD or AUD.`);
};
const url: V<string> = (v, f, c) => {
  const s = str(500)(v, f, c);
  if (s === undefined) return undefined;
  return /^https?:\/\/\S+$/.test(s) ? s : bad(c, f, `${f} must be a web address starting with https://.`);
};
const sku = (required = false) => str(64, { required, pattern: SKU, patternMsg: (f) => `${f} is a code (SKU): up to 64 letters, digits and . _ / -` });
const money = (required = false) => num({ min: 0, max: 1e9, decimals: 4, required });

function obj(fields: Record<string, V>, required = false): V<Record<string, unknown>> {
  return (v, f, c) => {
    if (v === undefined || v === null) return required ? bad(c, f, `${f} is needed.`) : undefined;
    if (typeof v !== "object" || Array.isArray(v)) return bad(c, f, `${f} must be an object ({ … }).`);
    const out: Record<string, unknown> = {};
    for (const [k, check] of Object.entries(fields)) {
      const r = check((v as Record<string, unknown>)[k], f ? `${f}.${k}` : k, c);
      if (r !== undefined) out[k] = r;
    }
    return out;
  };
}
function arr<T>(item: V<T>, o: { min?: number; max: number; required?: boolean }): V<T[]> {
  return (v, f, c) => {
    if (v === undefined || v === null) return o.required ? bad(c, f, `${f} is needed.`) : undefined;
    if (!Array.isArray(v)) return bad(c, f, `${f} must be a list ([ … ]).`);
    if (o.min && v.length < o.min) return bad(c, f, `${f} needs at least ${o.min}.`);
    if (v.length > o.max) return bad(c, f, `${f} can have up to ${o.max}.`);
    const out: T[] = [];
    v.forEach((x, i) => { const r = item(x, `${f}[${i}]`, c); if (r !== undefined) out.push(r); });
    return out;
  };
}
// Extras a website wants kept with it: up to 20 keys, short text, numbers or true/false.
const metadata: V<Record<string, unknown>> = (v, f, c) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) return bad(c, f, `${f} must be an object of short values.`);
  const e = Object.entries(v as Record<string, unknown>);
  if (e.length > 20) return bad(c, f, `${f} can have up to 20 keys.`);
  const out: Record<string, unknown> = {};
  for (const [k, x] of e) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) return bad(c, f, `${f} keys are up to 40 letters, digits and _ . -`);
    if (typeof x === "string") out[k] = x.replace(CONTROL_ALL, " ").slice(0, 200);
    else if ((typeof x === "number" && Number.isFinite(x)) || typeof x === "boolean" || x === null) out[k] = x;
    else return bad(c, `${f}.${k}`, `${f}.${k} must be short text, a number or true/false.`);
  }
  return out;
};
const address = obj({
  line1: str(200), line2: str(200), city: str(100), region: str(100), postcode: str(20), country: str(60),
});
const person = {
  name: str(120, { required: true }), email, phone, company: str(120), address, notes: str(1000, { multiline: true }),
};
function needContact(o: Record<string, unknown> | undefined, f: string, c: Ctx) {
  if (o && o.email === undefined && o.phone === undefined && !c.problems.some((p) => p.field.startsWith(f))) {
    bad(c, f ? `${f}.email` : "email", `Give ${f ? f + "." : ""}email or ${f ? f + "." : ""}phone, so the business can reply.`);
  }
}

export type Kind = "booking" | "order" | "enquiry" | "customer" | "quote_accept" | "invoice_payment";

const schemas: Record<Kind, V<Record<string, unknown>>> = {
  booking: obj({
    service: sku(true), staff: str(64, { pattern: SKU, patternMsg: () => "staff is a staff code (ref) from GET /v1/availability." }),
    start: datetime(true), end: datetime(), party_size: num({ int: true, min: 1, max: 1000 }), customer: obj(person, true),
    notes: str(2000, { multiline: true }), location: str(200), reference: str(64), metadata,
  }),
  order: obj({
    reference: str(64), customer: obj(person, true), currency,
    items: arr(obj({
      sku: sku(), name: str(200), quantity: num({ above: 0, max: 100000, decimals: 3, required: true }), unit_price: money(),
      tax_rate: num({ min: 0, max: 100 }), notes: str(300), options: arr(str(100), { max: 20 }),
    }), { min: 1, max: 200, required: true }),
    fulfilment: obj({
      type: oneOf(["pickup", "delivery", "dine_in", "shipping", "digital"], true), time: datetime(), address, table: str(20), notes: str(300),
    }),
    payment: obj({
      status: oneOf(["paid", "unpaid", "part_paid"], true), method: str(40), amount: money(), currency, provider: str(40), transaction_id: str(100),
    }),
    totals: obj({ subtotal: money(), tax: money(), shipping: money(), discount: money(), total: money() }),
    notes: str(2000, { multiline: true }), metadata,
  }),
  enquiry: obj({
    customer: obj(person, true), subject: str(200), message: str(5000, { required: true, multiline: true }), service: sku(),
    preferred_contact: oneOf(["email", "phone", "any"]), preferred_time: str(120), source_page: url, metadata,
  }),
  customer: obj({
    ...person, external_id: str(64), marketing_consent: bool, tags: arr(str(40), { max: 20 }), metadata,
  }),
  quote_accept: obj({
    accepted_by: obj({ name: str(120, { required: true }), email, phone, position: str(80) }, true), signature: str(200),
    po_number: str(64), note: str(1000, { multiline: true }), options: arr(str(64), { max: 50 }), option: str(64),
    accepted_at: datetime(), metadata,
  }),
  invoice_payment: obj({
    amount: num({ above: 0, max: 1e9, decimals: 4, required: true }), currency, paid_at: datetime(),
    method: oneOf(["card", "bank_transfer", "paypal", "stripe", "cash", "direct_debit", "other"], true), provider: str(40),
    transaction_id: str(100), payer: obj({ name: str(120), email }), note: str(1000, { multiline: true }), metadata,
  }),
};

/** Check one payload. ref: the quote or invoice reference from the path. now: for "start is in the past". */
export function validate(kind: Kind, body: unknown, ref?: string, now = Date.now()):
  { ok: true; payload: Record<string, unknown> } | { ok: false; problems: Problem[] } {
  const c: Ctx = { problems: [] };
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, problems: [{ field: "", message: "Send a JSON object ({ … })." }] };
  }
  const p = schemas[kind](body, "", c) ?? {};
  if (kind === "booking" || kind === "order" || kind === "enquiry") needContact(p.customer as Record<string, unknown> | undefined, "customer", c);
  if (kind === "customer") needContact(p, "", c);
  if (kind === "booking" && typeof p.start === "string") {
    const s = Date.parse(p.start);
    if (s < now - 5 * 60_000) bad(c, "start", "start is in the past.");
    if (s > now + 2 * 365 * 86_400_000) bad(c, "start", "start is more than 2 years away.");
    if (typeof p.end === "string" && Date.parse(p.end) <= s) bad(c, "end", "end must be after start.");
  }
  if (kind === "order" && Array.isArray(p.items)) {
    (p.items as Record<string, unknown>[]).forEach((it, i) => {
      if (it.sku === undefined && it.name === undefined) bad(c, `items[${i}].sku`, `items[${i}] needs a sku or a name.`);
    });
  }
  if (kind === "quote_accept" || kind === "invoice_payment") {
    let r = "";
    try { r = decodeURIComponent(ref ?? ""); } catch { /* bad escape */ }
    if (!REF.test(r)) bad(c, "ref", "The reference in the address is up to 64 letters, digits and . _ / # -");
    else p[kind === "quote_accept" ? "quote_ref" : "invoice_ref"] = r;
  }
  return c.problems.length ? { ok: false, problems: c.problems.slice(0, 20) } : { ok: true, payload: p };
}

/** JSON with keys sorted, so the same request always hashes the same (Idempotency-Key checks). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
