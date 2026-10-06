// Capture the REAL YonZone IM websocket handshake + first frames.
// Run right after relaunching YonZone (it connects within seconds):
//   node capture_ws_handshake.js [waitSeconds=90]
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const WAIT = Number(process.argv[2] || 90);
const events = [];

function listTargets(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

(async () => {
  process.env.YOUZONE_CDP_PORT = '8089';
  const zc = require('./youzone_cdp');
  const t0 = Date.now();
  let cdp = null;
  while (Date.now() - t0 < 120000 && !cdp) {
    const targets = await listTargets(8089);
    const page = targets.find(t => t.type === 'page' && /renderer\/index\.html/.test(t.url));
    if (page) {
      try {
        cdp = new zc.CDP(page.webSocketDebuggerUrl);
        await cdp.connect();
        await cdp.send('Network.enable');
        console.error('attached to main page, listening for ws events...');
      } catch { cdp = null; }
    }
    if (!cdp) await new Promise(r => setTimeout(r, 200));
  }
  if (!cdp) { console.error('could not attach in time'); process.exit(1); }

  cdp.on(m => {
    const p = m.params || {};
    if (m.method === 'Network.webSocketWillSendHandshakeRequest') {
      events.push({ ts: Date.now(), type: 'handshake', url: p.request.url, headers: p.request.headers });
      console.error('HANDSHAKE ->', p.request.url);
      console.error(JSON.stringify(p.request.headers, null, 1));
    }
    if (m.method === 'Network.webSocketCreated') events.push({ ts: Date.now(), type: 'wsCreated', url: p.url });
    if (m.method === 'Network.webSocketFrameSent' || m.method === 'Network.webSocketFrameReceived') {
      const pl = p.response.payloadData || '';
      let decoded = pl;
      if (pl.length > 4 && /^[A-Za-z0-9+/=]+$/.test(pl)) {
        try {
          const buf = Buffer.from(pl, 'base64');
          decoded = { bytes: buf.length, hex: buf.subarray(0, 13).toString('hex'), json: buf.length > 13 ? buf.subarray(13, Math.min(buf.length, 500)).toString('utf8') : '' };
        } catch {}
      }
      events.push({ ts: Date.now(), type: m.method === 'Network.webSocketFrameSent' ? 'sent' : 'recv', len: pl.length, decoded });
      console.error((m.method.endsWith('Sent') ? 'SENT ' : 'RECV ') + pl.length + 'B', typeof decoded === 'object' ? JSON.stringify(decoded).slice(0, 400) : String(decoded).slice(0, 200));
    }
  });

  await new Promise(r => setTimeout(r, WAIT * 1000));
  const out = path.join(__dirname, '..', 'references', 'ws-handshake-capture.json');
  fs.writeFileSync(out, JSON.stringify(events, null, 1));
  console.error('saved', events.length, 'events ->', out);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
