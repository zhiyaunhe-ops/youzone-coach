// One-off: dump newMessage schema + recent coach-conversation rows to validate
// query design before building the ask service.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PEER_COACH, copyDb, openCopy, decodeText } = require('./lib');

const outDir = path.join(__dirname, '..', 'references');
fs.mkdirSync(outDir, { recursive: true });
const { tmp, dbPath } = copyDb();
let db;
try {
  db = openCopy(dbPath);
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const schema = {};
  for (const t of tables) schema[t.name] = t.sql;
  const nmCols = db.prepare('PRAGMA table_info(newMessage)').all().map(c => c.name);

  // recent rows in the coach conversation
  const ids = db.prepare(
    'SELECT rowid AS rid, CAST(contentType AS BLOB) ct, CAST(msgTime AS BLOB) mt FROM newMessage WHERE oppositeId = ? ORDER BY rowid DESC LIMIT 40'
  ).all(PEER_COACH);
  const rows = [];
  for (const r of ids.slice(0, 8)) {
    const cols = nmCols.map(c => `CAST("${c}" AS BLOB)`).join(', ');
    const raw = db.prepare(`SELECT rowid AS _rowid, ${cols} FROM newMessage WHERE rowid = ?`).get(r.rid);
    const o = { _rowid: raw._rowid };
    for (let i = 0; i < nmCols.length; i++) {
      let v = decodeText(raw[i + 1]);
      if (typeof v === 'string' && v.length > 1200) v = v.slice(0, 1200) + '...<truncated>';
      o[nmCols[i]] = v;
    }
    rows.push(o);
  }
  const result = { dbPath, newMessageColumns: nmCols, recentCoachRowids: ids.map(r => ({ rid: r.rid, ct: decodeText(r.ct), mt: decodeText(r.mt) })), sampleRows: rows, tables: Object.keys(tables) };
  const out = path.join(outDir, `db-inspect-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log('tables:', Object.keys(tables).join(', '));
  console.log('newMessage cols:', nmCols.join(', '));
  console.log('recent coach rowids (rid/ct/mt):');
  for (const r of ids.slice(0, 12)) console.log(' ', r.rid, decodeText(r.ct), decodeText(r.mt));
  console.log('full samples written to', out);
} finally {
  try { if (db) db.close(); } catch {}
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
    catch (e) { if (i === 2) console.error('warn: temp dir left at', tmp); else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
}
