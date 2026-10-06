// Probe: are the two coach peer IDs globally unique, or tenant/user scoped?
//
// What we want to answer with evidence:
//  1. How many ipa_ (bot) conversations exist in this local DB?
//  2. For each, what tenantId / memberId / digitalCode does the question row carry?
//  3. Is there any field in the message that binds a coach peer to a tenant?
//
// Uses lib.parseMessage (the validated parser) rather than ad-hoc JSON.parse --
// the payload is a nested JSON string and hand-rolling it silently finds nothing.
'use strict';
const fs = require('node:fs');
const { copyDb, openCopy, decodeText, parseMessage, memberIdOf, PEERS, PEER_NAMES } = require('./lib');

const c = copyDb();
const db = openCopy(c.dbPath);
try {
  console.log('memberId (from db filename) :', memberIdOf(c.dbPath));

  // all ipa_ conversations
  const rows = db.prepare(
    `SELECT oppositeId, COUNT(*) n, MIN(ts) first_ts, MAX(ts) last_ts
     FROM newMessage WHERE oppositeId LIKE 'ipa_%' GROUP BY oppositeId ORDER BY n DESC`
  ).all();
  console.log('\n=== ipa_ bot conversations in this local DB:', rows.length, '===');
  for (const r of rows) {
    const known = PEER_NAMES[r.oppositeId] || '';
    console.log(`  ${r.oppositeId}  msgs=${String(r.n).padStart(4)}  ${known}`);
  }

  // For each, dig the newest question row's robotBusiness
  console.log('\n=== per-peer binding fields (from newest question row) ===');
  const tenants = new Map();
  for (const r of rows) {
    const qs = db.prepare(
      `SELECT id, ts, CAST(contentType AS BLOB) ct, CAST(content AS BLOB) c
       FROM newMessage WHERE oppositeId = ? ORDER BY ts DESC LIMIT 60`
    ).all(r.oppositeId);
    let found = null;
    for (const q of qs) {
      if (Number(decodeText(q.ct)) !== 2) continue;
      let p;
      try { p = parseMessage(2, decodeText(q.c)); } catch { continue; }
      if (p.kind === 'question' && p.robotBusiness) { found = p.robotBusiness; break; }
    }
    if (!found) { console.log(`\n  ${r.oppositeId}: no robotBusiness in last 60 rows`); continue; }
    if (found.tenantId) {
      if (!tenants.has(found.tenantId)) tenants.set(found.tenantId, []);
      tenants.get(found.tenantId).push(r.oppositeId);
    }
    const pick = ['tenantId', 'chatId', 'atRobotId', 'staffId', 'digitalCode', 'robotCode', 'appCode'];
    console.log(`\n  ${r.oppositeId}${PEER_NAMES[r.oppositeId] ? '  [' + PEER_NAMES[r.oppositeId] + ']' : ''}`);
    for (const k of pick) {
      if (found[k] !== undefined) console.log(`      ${k.padEnd(12)} = ${found[k]}`);
    }
    console.log(`      keys: ${Object.keys(found).join(', ')}`);
  }

  console.log('\n=== tenantId distribution across bots ===');
  for (const [t, list] of tenants) console.log(`  ${t}  <- ${list.length} bot(s): ${list.join(', ')}`);
  if (tenants.size === 1) console.log('  => ALL bots share ONE tenantId: peer id is NOT tenant-scoped');
} finally {
  db.close();
  try { fs.rmSync(c.tmp, { recursive: true, force: true }); } catch {}
}

