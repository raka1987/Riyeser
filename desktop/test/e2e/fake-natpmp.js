// A pretend NAT-PMP router for the Windows CI relay job (1.3.1): it answers like a router, writes the relay's note of
// the ports it "forwarded" (portmaps.json, as the relay writes it), and logs every request it gets, so the job can check
// that uninstalling the relay asked the router to remove each one (a request with lifetime 0).
// Run: node test/e2e/fake-natpmp.js <portmaps.json> <requests.log>   (runs until stopped)
const dgram = require('dgram');
const fs = require('fs');
const [file, logFile] = process.argv.slice(2);
const s = dgram.createSocket('udp4');
s.on('message', (m, r) => {
  if (m.length === 2) { const b = Buffer.alloc(12); b[1] = 128; b.set([203, 0, 113, 9], 8); s.send(b, r.port, r.address); return; }
  if (m.length < 12) return;
  fs.appendFileSync(logFile, `${JSON.stringify({ op: m[1], port: m.readUInt16BE(4), lifetime: m.readUInt32BE(8) })}\n`);
  const b = Buffer.alloc(16); b[1] = m[1] | 128; s.send(b, r.port, r.address);
});
s.bind(0, '127.0.0.1', () => {
  fs.writeFileSync(file, JSON.stringify({ method: 'NAT-PMP', gw: '127.0.0.1', pmpPort: s.address().port, igd: null,
    ports: [{ proto: 'tcp', port: 443 }, { proto: 'udp', port: 3478 }, { proto: 'udp', port: 40000 }], at: new Date().toISOString() }));
  fs.writeFileSync(logFile, '');
  console.log(`pretend NAT-PMP router on 127.0.0.1:${s.address().port}`);
});
