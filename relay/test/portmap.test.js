// Own-hardware mode: the relay asks the office router to forward its ports, by NAT-PMP or UPnP (pretend routers here).
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const http = require('http');
const { PortMapper, relayPorts } = require('../lib/portmap');
const { natPmp, gateway } = require('../lib/publicip');

test('NAT-PMP: the external address, then each port mapped, renewed, and removed on stop', async () => {
  const seen = [];
  const r = dgram.createSocket('udp4');
  r.on('message', (m, from) => {
    const op = m[1];
    if (op === 0) { const b = Buffer.alloc(12); b[1] = 128; b.writeUInt32BE(1, 4); Buffer.from([203, 0, 113, 9]).copy(b, 8); return r.send(b, from.port, from.address); }
    seen.push({ op, port: m.readUInt16BE(4), life: m.readUInt32BE(8) });
    const b = Buffer.alloc(16); b[1] = op | 128; b.writeUInt16BE(m.readUInt16BE(4), 8); b.writeUInt16BE(m.readUInt16BE(6), 10); b.writeUInt32BE(m.readUInt32BE(8), 12);
    r.send(b, from.port, from.address);
  });
  await new Promise((ok) => r.bind(0, '127.0.0.1', ok));
  const port = r.address().port;
  assert.equal(await natPmp('127.0.0.1', { port }), '203.0.113.9', 'the router\'s outside address');
  const pm = new PortMapper({ ports: [{ proto: 'tcp', port: 443 }, { proto: 'udp', port: 3478 }], localIp: '192.168.1.5', gw: '127.0.0.1', pmpPort: port });
  const st = await pm.start();
  assert.deepEqual({ method: st.method, mapped: st.mapped, failed: st.failed, ip: st.externalIp }, { method: 'NAT-PMP', mapped: 2, failed: 0, ip: '203.0.113.9' });
  assert.deepEqual(seen.map((x) => [x.op, x.port, x.life]), [[2, 443, 3600], [1, 3478, 3600]]);
  await pm.stop();
  assert.deepEqual(seen.slice(2).map((x) => [x.op, x.port, x.life]), [[2, 443, 0], [1, 3478, 0]], 'removed');
  r.close();
});

test('UPnP IGD: found by SSDP, AddPortMapping for each port, the external address', async () => {
  const calls = [];
  const web = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      if (req.url === '/desc.xml') return res.end('<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>');
      calls.push({ action: String(req.headers.soapaction), body: b });
      if (/GetExternalIPAddress/.test(req.headers.soapaction)) return res.end('<s:Envelope><s:Body><u:x><NewExternalIPAddress>198.51.100.77</NewExternalIPAddress></u:x></s:Body></s:Envelope>');
      if (/<NewExternalPort>5061</.test(b)) { res.statusCode = 500; return res.end('<errorDescription>ConflictInMappingEntry</errorDescription>'); }
      res.end('<ok/>');
    });
  });
  await new Promise((ok) => web.listen(0, '127.0.0.1', ok));
  const ss = dgram.createSocket('udp4');
  ss.on('message', (m, from) => { if (/M-SEARCH/.test(m)) ss.send(Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${web.address().port}/desc.xml\r\nST: x\r\n\r\n`), from.port, from.address); });
  await new Promise((ok) => ss.bind(0, '127.0.0.1', ok));
  const pm = new PortMapper({ ports: [{ proto: 'tcp', port: 443 }, { proto: 'tcp', port: 5061 }, { proto: 'udp', port: 40000 }], localIp: '192.168.1.5', gw: '127.0.0.9', pmpPort: 1, ssdpTarget: '127.0.0.1', ssdpPort: ss.address().port });
  const st = await pm.start();
  assert.equal(st.method, 'UPnP'); assert.equal(st.mapped, 2); assert.equal(st.failed, 1); assert.match(st.error, /ConflictInMappingEntry/);
  assert.equal(st.externalIp, '198.51.100.77');
  const adds = calls.filter((c) => /AddPortMapping/.test(c.action));
  assert.match(adds[0].body, /<NewExternalPort>443<\/NewExternalPort><NewProtocol>TCP<\/NewProtocol><NewInternalPort>443<\/NewInternalPort><NewInternalClient>192\.168\.1\.5</);
  await pm.stop();
  assert.equal(calls.filter((c) => /DeletePortMapping/.test(c.action)).length, 3);
  web.close(); ss.close();
});

test('the relay\'s ports, and the default gateway from /proc/net/route', () => {
  const ports = relayPorts({ httpsPort: 443, sipTlsPort: 5061, probePort: 40000, mediaMin: 40002, mediaMax: 40005, turn: { enabled: true, port: 3478, min: 40100, max: 40101 } });
  assert.deepEqual(ports.map((p) => `${p.proto}/${p.port}`), ['tcp/443', 'tcp/5061', 'udp/3478', 'tcp/3478', 'udp/40100', 'udp/40101', 'udp/40000', 'udp/40002', 'udp/40003', 'udp/40004', 'udp/40005']);
  assert.equal(gateway('Iface\tDestination\tGateway\nens3\t00000000\t0101A8C0\t0003\n'), '192.168.1.1');
});
