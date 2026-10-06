// Show the digital-human (数字人 / 智能体) roster with codes, so peer ids can be
// matched to their display names (e.g. 高级版实施总教练 / 交付赋能总教练).
'use strict';
const { copyDb, openCopy, decodeText, rowAllText } = require('./lib');

const CODES = ['DG2541495968084787206', 'DG2303424676718706696'];
const { tmp, dbPath } = copyDb();
let db;
try {
  db = openCopy(dbPath);
  const cols = db.prepare('PRAGMA table_info(digitals)').all().map(c => c.name);
  console.log('digitals cols:', cols.join(', '));

  const dump = (row) => {
    const o = {};
    for (const c of cols) {
      let v = row[c];
      if (typeof v === 'string' && v.length > 200) v = v.slice(0, 200) + '...';
      o[c] = v;
    }
    console.log('  ', JSON.stringify(o));
  };

  console.log('\n-- by digitalCode --');
  for (const code of CODES) {
    const rows = db.prepare('SELECT rowid FROM digitals').all();
    let hit = false;
    for (const r of rows) {
      const t = rowAllText(db, 'digitals', r.rowid);
      const flat = JSON.stringify(t);
      if (flat.includes(code)) { dump(t); hit = true; }
    }
    if (!hit) console.log('   <no row for', code, '>');
  }

  console.log('\n-- all digitals (name-ish fields) --');
  const all = db.prepare('SELECT rowid FROM digitals').all();
  for (const r of all) {
    const t = rowAllText(db, 'digitals', r.rowid);
    const keep = {};
    for (const c of cols) if (/name|code|title|desc|remark|robot|app|type|jid|id$/i.test(c)) {
      let v = t[c]; if (typeof v === 'string' && v.length > 80) v = v.slice(0, 80) + '...';
      keep[c] = v;
    }
    console.log('  ', JSON.stringify(keep));
  }
} finally {
  try { if (db) db.close(); } catch {}
  for (let i = 0; i < 3; i++) {
    try { require('node:fs').rmSync(tmp, { recursive: true, force: true }); break; }
    catch (e) { if (i === 2) console.error('warn: temp left', tmp); else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
}
