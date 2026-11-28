// The signed PDF: every signer's fields stamped into the pages (flattened: plain page content, no form fields left),
// then a "Certificate of completion" page (or pages) at the end. Used by handler.ts when the last person signs.
// pdf-lib only, nothing else, so the same code can be checked by sign_test.ts.
import { degrees, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";

export interface Field { id: string; kind: "signature" | "initials" | "date" | "name" | "text"; signer: number; page: number; x: number; y: number; w: number; h: number; label?: string | null }
export interface Signer {
  position: number; name: string; email: string; sent_at?: string | null; viewed_at?: string | null; signed_at?: string | null; agreed_at?: string | null;
  method?: string | null; ip?: string | null; user_agent?: string | null; vals?: Record<string, string> | null;
}
export interface Bundle {
  id: string; workspace_id: string; title: string; company: string; sender: string; sender_email?: string | null; created_at?: string; sent_at?: string | null;
  original_path: string; original_sha256: string; pages: number; fields: Field[]; ordered?: boolean; signers: Signer[];
  events?: { event: string; at: string; signer?: number | null; ip?: string | null }[];
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "28 Nov 2026, 14:05 UTC" */
export function when(t?: string | null): string {
  if (!t) return "-";
  const d = new Date(t);
  if (isNaN(d.getTime())) return "-";
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** Text the standard PDF font can write (anything else becomes "?"). Names in other scripts are shown as typed on the page itself. */
export function writable(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ")) {
    try { font.encodeText(ch); out += ch; } catch { out += "?"; }
  }
  return out;
}

/**
 * Where a field (fractions of the page as shown, from its top-left) lands in the page's own coordinates, for pages
 * with /Rotate 0, 90, 180 or 270: the corner to draw from and the angle (pdf-lib turns anticlockwise about that corner).
 */
export function placeOnPage(f: Pick<Field, "x" | "y" | "w" | "h">, W: number, H: number, rotation: number) {
  const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const dw = r % 180 ? H : W; const dh = r % 180 ? W : H;            // the page as shown
  const u0 = f.x, v1 = f.y + f.h;                                     // the field's bottom-left corner as shown
  const map = (u: number, v: number): [number, number] =>
    r === 0 ? [u * W, H - v * H] : r === 90 ? [v * W, u * H] : r === 180 ? [W - u * W, v * H] : [W - v * W, H - u * H];
  const [x, y] = map(u0, v1);
  return { x, y, width: f.w * dw, height: f.h * dh, angle: r };
}

/** A point inside the field (a along its width, b up its height) in page coordinates. */
function at(p: ReturnType<typeof placeOnPage>, a: number, b: number): [number, number] {
  const t = (p.angle * Math.PI) / 180;
  return [p.x + a * Math.cos(t) - b * Math.sin(t), p.y + a * Math.sin(t) + b * Math.cos(t)];
}

const NAVY = rgb(0.06, 0.11, 0.24); const GREY = rgb(0.39, 0.44, 0.54); const PURPLE = rgb(0.47, 0.2, 0.75); const LINE = rgb(0.85, 0.87, 0.92);

async function stamp(doc: PDFDocument, b: Bundle, font: PDFFont) {
  const pages = doc.getPages();
  const bySigner = new Map(b.signers.map((s) => [s.position, s]));
  for (const f of b.fields) {
    const page = pages[f.page - 1]; const s = bySigner.get(f.signer);
    const v = s?.vals?.[f.id];
    if (!page || !s || !v) throw new Error(`field ${f.id} has no value`);
    const { width: W, height: H } = page.getSize();
    const p = placeOnPage(f, W, H, page.getRotation().angle);
    if (f.kind === "signature" || f.kind === "initials") {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(v);
      if (!m) throw new Error(`field ${f.id} is not a PNG`);
      const img = await doc.embedPng(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
      const k = Math.min(p.width / img.width, p.height / img.height);
      const w = img.width * k, h = img.height * k;
      const [x, y] = at(p, 0, (p.height - h) / 2);
      page.drawImage(img, { x, y, width: w, height: h, rotate: degrees(p.angle) });
    } else {
      const text = writable(font, v);
      let size = Math.min(p.height * 0.7, 14);
      while (size > 5 && font.widthOfTextAtSize(text, size) > p.width) size -= 0.5;
      const [x, y] = at(p, 1, (p.height - size * 0.72) / 2);
      page.drawText(text, { x, y, size, font, color: rgb(0.05, 0.1, 0.3), rotate: degrees(p.angle) });
    }
  }
}

/** One certificate page (or more), written line by line. */
function certificate(doc: PDFDocument, b: Bundle, font: PDFFont, bold: PDFFont, hashes: { original: string; content: string }, completedAt: string) {
  const W = 595.28, H = 841.89, M = 48;
  let page: PDFPage = doc.addPage([W, H]); let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const line = (text: string, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number; indent?: number } = {}) => {
    const size = o.size ?? 9.5; const f = o.f ?? font; const max = W - 2 * M - (o.indent ?? 0);
    const words = writable(f, text).split(" "); let cur = "";
    const out: string[] = [];
    for (const w of words) {
      let word = w;
      while (f.widthOfTextAtSize(word, size) > max) {     // long hashes and browser names: break them
        let i = word.length; while (i > 1 && f.widthOfTextAtSize(word.slice(0, i), size) > max) i--;
        if (cur) { out.push(cur); cur = ""; } out.push(word.slice(0, i)); word = word.slice(i);
      }
      const next = cur ? `${cur} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) > max) { out.push(cur); cur = word; } else cur = next;
    }
    if (cur) out.push(cur);
    for (const l of out) {
      if (y - size < M + 30) newPage();
      page.drawText(l, { x: M + (o.indent ?? 0), y: y - size, size, font: f, color: o.color ?? NAVY });
      y -= size * 1.35;
    }
    y -= o.gap ?? 0;
  };
  const rule = () => { if (y < M + 60) newPage(); page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINE }); y -= 10; };
  const head = (t: string) => { y -= 4; line(t, { size: 11, f: bold, color: PURPLE, gap: 2 }); };

  line("Certificate of completion", { size: 20, f: bold, gap: 2 });
  line("Electronic signature with an audit trail, made with Riyeser", { size: 10, color: GREY, gap: 8 });
  rule();
  head("Document");
  line(`Name: ${b.title}`);
  line(`Request ID: ${b.id}`);
  line(`Pages signed: ${b.pages} (this certificate is added after them)`);
  line(`Sent by: ${b.sender}, ${b.company}${b.sender_email ? ` (${b.sender_email})` : ""}`);
  line(`Sent: ${when(b.sent_at)}   Completed: ${when(completedAt)}`);
  line(`Signing order: ${b.ordered ? "in the order listed below" : "any order"}`, { gap: 6 });
  head("Document fingerprints (SHA-256)");
  line(`Before signing (the PDF exactly as it was sent): ${hashes.original}`);
  line("After signing: a file can't contain its own fingerprint, so the SHA-256 of this whole signed file (including this page) is recorded by Riyeser with the request ID above. It is in the email sent when everyone had signed and in the sender's Riyeser PDF. If anything in the file is changed, the fingerprint no longer matches.", { size: 8.5, color: GREY, gap: 6 });
  head("Signers");
  for (const s of b.signers) {
    line(`${s.position}. ${s.name} <${s.email}>`, { f: bold, size: 10 });
    line(`Email sent: ${when(s.sent_at)}   Opened: ${when(s.viewed_at)}   Signed: ${when(s.signed_at)}`, { indent: 12 });
    line(`Ticked "I agree to sign electronically": ${when(s.agreed_at)}   Signature: ${s.method === "typed" ? "typed and adopted" : "drawn and adopted"}`, { indent: 12 });
    line(`Internet address: ${s.ip || "not known"}   Browser: ${(s.user_agent || "not known").slice(0, 160)}`, { indent: 12, size: 8.5, color: GREY, gap: 4 });
  }
  if (b.events?.length) {
    head("History");
    const who = new Map(b.signers.map((s) => [s.position, s.name]));
    const label: Record<string, string> = { created: "Request made", sent: "Sent for signing", emailed: "Link emailed", viewed: "Opened", signed: "Signed",
      declined: "Declined", reminded: "Reminder sent", cancelled: "Cancelled", expired: "Expired", completed: "Completed", keep_changed: "How long to keep the files changed", files_deleted: "Files deleted" };
    for (const e of b.events) line(`${when(e.at)}  ${label[e.event] ?? e.event}${e.signer ? ` - ${who.get(e.signer) ?? `signer ${e.signer}`}` : ""}${e.ip ? ` (${e.ip})` : ""}`, { size: 8.5 });
    line(`${when(completedAt)}  Completed - signed copy made`, { size: 8.5, gap: 6 });
  }
  rule();
  line("About this certificate: Riyeser recorded the steps above when each person used their own emailed link. It is an electronic signature with an audit trail. Whether it is accepted for a particular kind of document, or in a particular country, depends on the rules that apply there.", { size: 8.5, color: GREY });
  doc.getPages().slice(-1)[0].drawText(writable(font, `Riyeser · riyeser.com · Request ${b.id}`), { x: M, y: M - 10, size: 7.5, font, color: GREY });
}

/** The signed PDF and its fingerprints. Refuses a PDF whose SHA-256 isn't the one recorded when it was sent. */
export async function buildSigned(original: Uint8Array, b: Bundle, completedAt = new Date().toISOString()) {
  const before = await sha256Hex(original);
  if (before !== b.original_sha256) throw new Error("The stored PDF doesn't match the one that was sent.");
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  if (doc.getPageCount() !== b.pages) throw new Error("The stored PDF doesn't have the pages that were sent.");
  const font = await doc.embedFont(StandardFonts.Helvetica); const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  await stamp(doc, b, font);
  // the fingerprint of the signed pages alone: the same document saved before the certificate is added
  const content = await sha256Hex(await doc.save({ useObjectStreams: false }));
  certificate(doc, b, font, bold, { original: before, content }, completedAt);
  doc.setProducer("Riyeser electronic signature");
  doc.setModificationDate(new Date(completedAt));
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, original: before, content, final: await sha256Hex(bytes) };
}
