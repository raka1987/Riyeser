// A self-signed certificate for the relay, made with Node alone (no OpenSSL, so it works the same on Windows), for
// when there's no Let's Encrypt or own certificate. Link Office and the other relays don't rely on a certificate
// authority for it: the relay reports the certificate's SHA-256 fingerprint to Riyeser online, and they check the
// relay presents exactly that one ("pinning"). ECDSA P-256, 10 years, with the relay's name (and IP) in it.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
function len(n) { if (n < 128) return Buffer.from([n]); const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); }
function oid(s) {
  const p = s.split('.').map(Number); const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) { const b = [v & 127]; let x = v >> 7; while (x) { b.unshift((x & 127) | 128); x >>= 7; } out.push(...b); }
  return der(0x06, Buffer.from(out));
}
const seq = (...p) => der(0x30, ...p);
const utf8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
function time(d) {
  const z = (n) => String(n).padStart(2, '0');
  const s = `${z(d.getUTCFullYear() % 100)}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(s)) : der(0x18, Buffer.from(String(d.getUTCFullYear()).slice(0, 2) + s));
}

/** -> { cert (PEM), key (PEM), fingerprint ('AB:CD:…', SHA-256 of the DER) } */
function selfSigned({ name = 'relay.riyeser.com', ips = [], days = 3650, now = new Date() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const alg = seq(oid('1.2.840.10045.4.3.2'));
  const subject = seq(der(0x31, seq(oid('2.5.4.3'), utf8(name))));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const san = [der(0x82, Buffer.from(name)), ...ips.map((ip) => der(0x87, Buffer.from(ip.split('.').map(Number))))];
  const exts = der(0xa3, seq(
    seq(oid('2.5.29.17'), der(0x04, seq(...san))),
    seq(oid('2.5.29.19'), der(0x04, seq())),                                           // basicConstraints: not a CA
    seq(oid('2.5.29.37'), der(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))),                    // extendedKeyUsage: serverAuth
  ));
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), alg, subject,
    seq(time(new Date(now.getTime() - 3600 * 1000)), time(new Date(now.getTime() + days * 86400000))), subject,
    publicKey.export({ type: 'spki', format: 'der' }), exts);
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certDer = seq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), fingerprint: fingerprint(pem) };
}
/** SHA-256 fingerprint of a PEM certificate, as Node's getPeerCertificate().fingerprint256 shows it. */
function fingerprint(pem) { return new crypto.X509Certificate(pem).fingerprint256; }

/** Make the certificate files if they aren't there (or are about to expire). -> { certFile, keyFile, fingerprint, made } */
function ensure(dir, { name, ips } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const certFile = path.join(dir, 'relay-cert.pem'); const keyFile = path.join(dir, 'relay-key.pem');
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(certFile));
    if (Date.parse(x.validTo) > Date.now() + 30 * 86400000 && (!name || x.subject.includes(`CN=${name}`))) return { certFile, keyFile, fingerprint: x.fingerprint256, made: false };
  } catch { /* make one */ }
  const c = selfSigned({ name, ips });
  fs.writeFileSync(keyFile, c.key, { mode: 0o600 }); fs.writeFileSync(certFile, c.cert);
  return { certFile, keyFile, fingerprint: c.fingerprint, made: true };
}

module.exports = { selfSigned, fingerprint, ensure };
