// List every bot/pubaccount/peer conversation in the local YonZone message DB.
// Goal: discover peer ids (oppositeId) of ALL coaches, e.g. 高级版实施总教练 / 交付赋能总教练.
'use strict';
const path = require('node:path');
const { copyDb, openCopy, decodeText } = require('./lib');

const { tmp, dbPath } = copyDb();
let db;
try {
  db = openCopy(dbPath);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  console.log('tables:', tables.join(', '));

  for (const t of ['pubaccount', 'digitals', 'roster', 'groupRobot']) {
    if (!tables.includes(t)) { console.log(`\n[${t}] <absent>`); continue; }
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    console.log(`\n[${t}] cols:`, cols.join(', '));
    const sel = cols.map(c => `CAST("${c}" AS BLOB)`).join(', ');
    const rows = db.prepare(`SELECT ${sel} FROM ${t} LIMIT 200`).all();
    for (const r of rows) {
      const o = {};
      cols.forEach((c, i) => { o[c] = decodeText(r[i]); });
      // keep it readable: print name-ish + id-ish fields only
      const keep = {};
      for (const k of cols) {
        if (/id|name|nick|title|desc|remark|account|robot|app/i.test(k)) {
          let v = o[k];
          if (typeof v === 'string' && v.length > 120) v = v.slice(0, 120) + '...';
          keep[k] = v;
        }
      }
      console.log('  ', JSON.stringify(keep));
    }
  }

  // distinct peers present in newMessage with a recent message count
  console.log('\n[newMessage] distinct oppositeId (with counts, newest first by ts):');
  const peers = db.prepare(
    'SELECT oppositeId, COUNT(*) AS n, MAX(ts) AS lastTs FROM newMessage GROUP BY oppositeId ORDER BY lastTs DESC'
  ).all();
  for (const p of peers) {
    console.log('  ', decodeText(p.oppositeId), '| n=', p.n, '| lastTs=', p.lastTs,
      p.lastTs ? new Date(Number(p.lastTs)).toISOString() : '');
  }
} finally {
  try { if (db) db.close(); } catch {}
  for (let i = 0; i < 3; i++) {
    try { require('node:fs').rmSync(tmp, { recursive: true, force: true }); break; }
    catch (e) { if (i === 2) console.error('warn: temp dir left at', tmp); else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
}
