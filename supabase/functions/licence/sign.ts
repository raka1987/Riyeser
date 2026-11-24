// Signing Riyeser licences: canonical JSON and Ed25519 (WebCrypto). Shared by index.ts and its tests.
// The programs check the same bytes: desktop/src/core/signed-licence.js (Central, Link Office, Payroll) and
// riyeser/signed_licence.py (Accounting). licence-vectors.json is the shared test data: all four must agree.

// ---------- canonical JSON: keys sorted (UTF-16 order), no spaces, whole numbers only ----------
function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
      out += s[i] + s[i + 1];
      i++;
    } else if (c >= 0xd800 && c <= 0xdfff) out += `\\u${c.toString(16)}`; // a lone surrogate
    else out += s[i];
  }
  return `${out}"`;
}

export function canonical(v: unknown): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("Canonical JSON takes whole numbers only.");
    return String(v === 0 ? 0 : v);
  }
  if (typeof v === "string") return quote(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${quote(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  throw new Error("Canonical JSON can't hold that value.");
}

// ---------- base64 ----------
export const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
export const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

// ---------- the signing key ----------
// LICENCE_SIGNING_KEY (a function secret) is base64url of the private key as a JWK: {"kty":"OKP","crv":"Ed25519","d":..,"x":..}.
export type SigningKey = { privateKey: CryptoKey; publicKey: string };
export async function loadKey(secret: string): Promise<SigningKey> {
  const jwk = JSON.parse(new TextDecoder().decode(fromB64url(secret.trim())));
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) throw new Error("LICENCE_SIGNING_KEY isn't an Ed25519 key.");
  const privateKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, { name: "Ed25519" }, false, ["sign"]);
  return { privateKey, publicKey: b64(fromB64url(jwk.x)) };
}

export const DAY = 86400000;
export const OFFLINE_GRACE_DAYS = 30;

export type Envelope = {
  licence: Record<string, unknown>;
  issued_at: string;
  expires_at: string;
  workspace_id: string;
  device_id: string | null;
  sig?: string;
};

/** The signed licence: everything except sig, signed as canonical JSON bytes. Good for 30 days offline. */
export async function signLicence(
  key: SigningKey,
  licence: Record<string, unknown>,
  workspaceId: string,
  deviceId: string | null,
  now = Date.now(),
): Promise<Envelope> {
  const env: Envelope = {
    licence,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + OFFLINE_GRACE_DAYS * DAY).toISOString(),
    workspace_id: workspaceId,
    device_id: deviceId,
  };
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(canonical(env))));
  return { ...env, sig: b64(sig) };
}
