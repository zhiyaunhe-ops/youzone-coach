// Identify what each ipa_* bot peer actually is: pull recent messages per peer and
// surface the robotBusiness identity (atRobotId / app / agent name) + a text preview.
'use strict';
const { copyDb, openCopy, decodeText, parseMessage } = require('./lib');

const PEERS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'ipa_ff71df3a-f6ee-410a-af14-9dd51e60e9e5',
  'ipa_2c491083-4854-4206-aac7-27d122c364bd',
  'ipa_c172e13d-199f-40a9-8be5-b8de8c93bda5',
  'ipa_804d5075-43c4-476a-90f3-931903fe716a',
  'ipa_9ff95198-a7f0-4348-955c-e59d36fd28f7',
];

const { tmp, dbPath } = copyDb();
let db;
try {
  db = openCopy(dbPath);
  for (const peer of PEERS) {
    console.log('\n================ ' + peer);
    const rows = db.prepare(
      `SELECT id, ts, CAST(contentType AS BLOB) ct, CAST(content AS BLOB) c
       FROM newMessage WHERE oppositeId = ? ORDER BY ts DESC LIMIT 40`
    ).all(peer);
    // 1) any robotBusiness identity anywhere
    let rb = null, lastQ = null;
    for (const r of rows) {
      const ct = Number(decodeText(r.ct));
      const raw = decodeText(r.c);
      const p = parseMessage(ct, raw);
      if (p.kind === 'question' && p.robotBusiness && !rb) rb = p.robotBusiness;
      if (p.kind === 'question' && p.text && !lastQ) lastQ = p.text;
    }
    if (rb) {
      const keep = {};
      for (const k of Object.keys(rb)) if (/robot|app|agent|name|tenant|chat|staff|type|code|biz|digital/i.test(k)) keep[k] = rb[k];
      console.log('  [robotBusiness]', JSON.stringify(keep));
    } else console.log('  [robotBusiness] <none in last 40>');
    if (lastQ) console.log('  [lastQ]', String(lastQ).slice(0, 150));

    // 2) newest answers + their agent chain
    let shown = 0;
    for (const r of rows) {
      const ct = Number(decodeText(r.ct));
      const p = parseMessage(ct, decodeText(r.c));
      if (p.kind === 'answer' && p.final && shown < 3) {
        console.log('  [answer]', String(p.text || '').replace(/\s+/g, ' ').slice(0, 200));
        if (p.steps && p.steps.length) console.log('  [steps]', p.steps.slice(0, 4).map(s => s.stepName || s.type).join(' > '));
        shown++;
      }
    }
    if (!shown) {
      // fallback: dump raw content preview of newest rows
      for (const r of rows.slice(0, 3)) {
        const raw = String(decodeText(r.c) || '').replace(/\s+/g, ' ');
        console.log('  [raw ct=' + decodeText(r.ct) + ']', raw.slice(0, 200));
      }
    }
  }
} finally {
  try { if (db) db.close(); } catch {}
  for (let i = 0; i < 3; i++) {
    try { require('node:fs').rmSync(tmp, { recursive: true, force: true }); break; }
    catch (e) { if (i === 2) console.error('warn: temp left', tmp); else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
}
