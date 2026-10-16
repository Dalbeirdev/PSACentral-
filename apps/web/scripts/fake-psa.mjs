// A fake PSA for demonstrations and evidence: a custom-REST style API over TLS with a self-signed
// certificate (standing in for an on-premise PSA with a private CA). Runs as its own process so that a
// caller using synchronous shell calls cannot stall it. Usage: node fake-psa.mjs <hostIp> <apiKey> <caPemOutPath>
// Prints "PORT <n>" once listening; serves GET /api/health when the X-API-Key header matches.
import { webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createTcp } from 'node:net';
import * as x509 from '@peculiar/x509';

const [hostIp, apiKey, caOut] = process.argv.slice(2);
if (!hostIp || !apiKey || !caOut) throw new Error('usage: fake-psa.mjs <hostIp> <apiKey> <caPemOutPath>');
x509.cryptoProvider.set(webcrypto);
const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const cert = await x509.X509CertificateGenerator.createSelfSigned({
  serialNumber: '01', name: `CN=${hostIp}`, notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000), signingAlgorithm: alg, keys,
  extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: hostIp }]), new x509.BasicConstraintsExtension(true, undefined, true)],
});
const keyDer = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
const keyPem = `-----BEGIN PRIVATE KEY-----\n${keyDer.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
const caPem = cert.toString('pem');
writeFileSync(caOut, caPem);
const port = await new Promise((resolve) => { const s = createTcp(); s.listen(0, '0.0.0.0', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// A few demo tickets (synthetic) for the synchronization engine; pushes are recorded and applied.
// Timestamps are relative to the clock (the watermark follows the newest PSA change; fixed future dates would hide later changes).
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const tickets = [
  { id: '1001', title: 'Printer offline on floor 2', description: 'The HP on floor 2 shows E-04.', status: 'Open', priority: 'High', requesterEmail: 'anna@client.example', createdAt: hoursAgo(30), updatedAt: hoursAgo(3) },
  { id: '1002', title: 'VPN drops every hour', description: 'Since Monday.', status: 'Waiting Customer', priority: 'Medium', requesterEmail: 'ben@client.example', createdAt: hoursAgo(29), updatedAt: hoursAgo(2) },
  { id: '1003', title: 'New starter laptop', description: 'Starts Monday.', status: 'Complete', priority: 'Low', requesterEmail: 'hr@client.example', createdAt: hoursAgo(50), updatedAt: hoursAgo(1), resolvedAt: hoursAgo(1) },
  { id: '1004', title: 'Mailbox over quota', description: 'Cannot receive mail.', status: 'In Progress', priority: 'Critical', requesterEmail: 'cfo@client.example', createdAt: hoursAgo(5), updatedAt: hoursAgo(0.5) },
];
let created = 0;
const srv = createServer({ key: keyPem, cert: caPem }, (req, res) => {
  const url = new URL(req.url ?? '/', 'https://x');
  const authed = req.headers['x-api-key'] === apiKey;
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader('content-type', 'application/json');
    let status = 200;
    let out = { error: 'not found' };
    if (!authed) {
      status = 401;
      out = { error: 'invalid api key' };
    } else if (req.method === 'GET' && url.pathname === '/api/health') {
      out = { status: 'ok', product: 'Demo PSA' };
    } else if (req.method === 'GET' && url.pathname === '/api/tickets') {
      const since = new Date(url.searchParams.get('updated_since') ?? 0).getTime();
      out = { items: tickets.filter((t) => new Date(t.updatedAt).getTime() >= since), nextPage: null };
    } else if (req.method === 'PATCH' && /^\/api\/tickets\/[^/]+$/.test(url.pathname)) {
      const t = tickets.find((x) => x.id === url.pathname.split('/').pop());
      if (t && body?.status) { t.status = body.status; t.updatedAt = new Date().toISOString(); }
      out = {};
    } else if (req.method === 'POST' && /^\/api\/tickets\/[^/]+\/notes$/.test(url.pathname)) {
      status = 201;
      out = {};
    } else if (req.method === 'POST' && url.pathname === '/api/tickets') {
      created++;
      tickets.push({ id: `new-${created}`, title: body?.title ?? 'untitled', description: body?.description ?? '', status: 'New', priority: body?.priority ?? 'normal', requesterEmail: body?.requesterEmail ?? '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      status = 201;
      out = { id: `new-${created}` };
    } else {
      status = 404;
    }
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} -> ${status}`);
    res.statusCode = status;
    res.end(JSON.stringify(out));
  });
});
srv.listen(port, '0.0.0.0', () => console.log('PORT', port));
process.on('SIGTERM', () => srv.close(() => process.exit(0)));
