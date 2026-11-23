// Makes the key pair that signs plan passes. Run once:  node server/scripts/make-signing-key.mjs
//   PASS_SIGNING_KEY (private) -> `supabase secrets set PASS_SIGNING_KEY=...`  Never commit it, never put it in an app.
//   public key                 -> desktop/src/core/cloud.json  "passPublicKey"  (safe to publish)
const { subtle } = globalThis.crypto;
const b64 = (buf) => Buffer.from(buf).toString('base64');
const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
console.log(`PASS_SIGNING_KEY=${b64(await subtle.exportKey('pkcs8', pair.privateKey))}`);
console.log(`passPublicKey: ${b64(await subtle.exportKey('spki', pair.publicKey))}`);
