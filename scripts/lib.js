// youzone-coach shared helpers (zero-dependency, Node >= 22.5)
// - locates the local YYIMDB sqlite message store
// - makes a shared-read copy (db + -wal + -shm) so we never touch the original
// - decodes GBK/UTF-8 text stored in the DB
// - parses newMessage rows into {question | answer | ...} (single source of truth
//   for dump_chat.js / coach_ask_server.js / coach_headless.js)
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Coach peer IDs. These are GLOBAL agent registration IDs, not per-user IDs --
// anyone can write them into a frame and reach the same agent (subject to that
// user's own authorization in their tenant). Sessions and data are isolated one
// level down, at `chatId` + `yht_access_token`.
// On a different account/tenant, discover the IDs rather than trusting these:
//   node scripts/list_peers.js        (enumerate ipa_ conversations in the local DB)
//   node scripts/probe_peer_scope.js  (tenantId / chatId / digitalCode per peer)
// Evidence: references/peer-id-scope.md
const PEER_COACH = 'ipa_ff71df3a-f6ee-410a-af14-9dd51e60e9e5'; // 高级版实施总教练（多智能验证版）
const PEER_COACH_DELIVERY = 'ipa_2c491083-4854-4206-aac7-27d122c364bd'; // 交付赋能总教练

// Alias -> peer id. There are (at least) two coaches and every question must go to
// BOTH: they are backed by different agent graphs and routinely disagree.
const PEERS = {
  impl: PEER_COACH,
  implementation: PEER_COACH,
  coach: PEER_COACH,
  delivery: PEER_COACH_DELIVERY,
  empower: PEER_COACH_DELIVERY,
};
const PEER_NAMES = {
  [PEER_COACH]: '高级版实施总教练（多智能验证版）',
  [PEER_COACH_DELIVERY]: '交付赋能总教练',
};

// Accept a peer id, an alias, or null/undefined (= the implementation coach).
function resolvePeer(p) {
  if (!p) return PEER_COACH;
  if (PEER_NAMES[p]) return p;
  return PEERS[String(p).toLowerCase()] || p;
}
function peerName(p) { return PEER_NAMES[resolvePeer(p)] || resolvePeer(p); }

function dbDir() {
  return path.join(process.env.APPDATA || '', 'youzone', 'sqlite');
}

function dbGlob() {
  const dir = dbDir();
  if (!fs.existsSync(dir)) throw new Error('youzone sqlite dir not found: ' + dir);
  const files = fs.readdirSync(dir).filter(f => /^YYIMDB_\d+_esn\.db$/.test(f));
  if (!files.length) throw new Error('no YYIMDB_*.db found in ' + dir);
  if (files.length > 1) {
    // multi-member install: prefer the most recently written DB, and say so.
    files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    console.error('[lib] multiple message DBs, using newest: ' + files[0] + ' (others: ' + files.slice(1).join(', ') + ')');
  }
  return path.join(dir, files[0]);
}

function memberIdOf(dbPathOrName) {
  const m = /YYIMDB_(\d+)_esn\.db$/.exec(String(dbPathOrName));
  return m ? m[1] : null;
}

// Shared-read copy: the client keeps the DB open (WAL), so we copy db+wal+shm
// to a temp dir and open the copy; SQLite replays the WAL on open.
function copyDb(destDir) {
  const src = dbGlob();
  const tmp = destDir || fs.mkdtempSync(path.join(os.tmpdir(), 'yzcoach-'));
  const base = path.basename(src);
  const out = {};
  for (const suffix of ['', '-wal', '-shm']) {
    const s = src + suffix, d = path.join(tmp, base + suffix);
    if (fs.existsSync(s)) fs.copyFileSync(s, d);
    if (!suffix) out.db = d;
  }
  return { tmp, dbPath: out.db, srcBase: base, src, memberId: memberIdOf(base) };
}

// Open a copied DB read-only. Always CAST columns AS BLOB when selecting text:
// node:sqlite would decode TEXT as UTF-8 and mangle GBK bytes irrecoverably.
function openCopy(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

const decUtf8 = new TextDecoder('utf-8', { fatal: true });
const decGbk = new TextDecoder('gbk');
const decLat1 = new TextDecoder('latin1');
function decodeText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v; // already fine (numeric etc.)
  const u8 = v instanceof Uint8Array ? v : Uint8Array.from(v);
  try { return decUtf8.decode(u8); }
  catch { try { return decGbk.decode(u8); } catch { return decLat1.decode(u8); } }
}

// Read every column of a row as decoded text, no matter its declared type.
function rowAllText(db, table, rowid) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
    .map(c => c.name);
  const sel = cols.map(c => `CAST(${JSON.stringify(c)} AS BLOB)`).join(', ');
  const row = db.prepare(`SELECT rowid AS _rowid, ${sel} FROM ${table} WHERE rowid = ?`).get(rowid);
  if (!row) return null;
  const out = { _rowid: row._rowid };
  for (let i = 0; i < cols.length; i++) out[cols[i]] = decodeText(row[i + 1]);
  return out;
}

// ---- newMessage payload parsing -------------------------------------------

function asJson(v) {
  if (v == null) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

// Same, but a non-JSON string is simply "not JSON" instead of an error: question
// rows whose content is a bare sentence must still parse as questions.
function tryJson(v) { try { return asJson(v); } catch { return null; } }

// User side: contentType=2 -> content = {content: <question>, robotBusiness}.
// Bot side: contentType=18 -> extend (itself a JSON string) holds
// responses[0].data.showData.text (normal answers) or data.text
// (clarify / ASK_USER replies, answerType=97) plus thoughtChainResponses[].
//
// The same message exists in two shapes and both must parse:
//   DB  (newMessage.content column) : {extend: "<json>"}          <- already inner
//   WS  (imws 4176 payload)         : {contentType:18, content:"<inner json>"}
function botParts(j) {
  if (j.extend !== undefined) return { inner: j, ext: asJson(j.extend) || {} };
  const inner = asJson(j.content);
  if (inner && typeof inner === 'object' && inner.extend !== undefined) {
    return { inner, ext: asJson(inner.extend) || {} };
  }
  return { inner: j, ext: {} };
}

function parseMessage(ct, raw) {
  const n = Number(ct);
  try {
    const j = asJson(raw);
    if (!j) return { kind: 'other' };
    if (n === 2) {
      let inner = j, rb = j.robotBusiness || null, text = j.content;
      if (typeof j.content === 'string' && !rb) { // WS envelope wrapping the inner question
        const cand = tryJson(j.content);
        if (cand && typeof cand === 'object' && ('content' in cand || 'robotBusiness' in cand)) {
          inner = cand; rb = cand.robotBusiness || null; text = cand.content;
        }
      }
      return { kind: 'question', text, robotBusiness: rb, meta: inner };
    }
    if (n !== 18) return { kind: 'other' };
    const e = botParts(j).ext;
    const resp = (e.responses || [])[0];
    const sd = resp && resp.data && resp.data.showData;
    let text = '';
    if (typeof sd === 'string') { try { text = (asJson(sd) || {}).text || ''; } catch { text = ''; } }
    else if (sd && typeof sd === 'object') text = sd.text || '';
    if (!text && resp && resp.data && typeof resp.data.text === 'string') text = resp.data.text;
    return {
      kind: 'answer', final: !!text, text,
      traceId: e.traceId, questionId: e.questionId, chatId: e.chatId,
      steps: (e.thoughtChainResponses || []).map(s => ({ type: s.type, stepName: s.stepName, result: s.result })),
      meta: e,
    };
  } catch (e) { return { kind: 'unparsed', error: String((e && e.message) || e) }; }
}

// The server sends a metadata message (ct=18) whose extend.data.callbackStreamUrl
// must be POSTed to open the SSE answer stream.
function messageStreamUrl(ct, raw) {
  try {
    if (Number(ct) !== 18) return null;
    const ext = botParts(asJson(raw) || {}).ext;
    return (ext.data && ext.data.callbackStreamUrl) || null;
  } catch { return null; }
}

// Newest question row of a peer: yields both the fallback yht_access_token and
// this install's robotBusiness identity (chatId/tenantId/atRobotId/staffId/...),
// so nothing has to be hardcoded per machine.
function latestQuestion(db, peer = PEER_COACH, scan = 40) {
  peer = peer || PEER_COACH; // null/undefined both mean "the coach"
  const rows = db.prepare(
    `SELECT id, ts, CAST(contentType AS BLOB) ct, CAST(content AS BLOB) c
     FROM newMessage WHERE oppositeId = ? ORDER BY ts DESC LIMIT ?`
  ).all(peer, scan);
  for (const r of rows) {
    const ct = Number(decodeText(r.ct));
    if (ct !== 2) continue;
    const raw = decodeText(r.c);
    const p = parseMessage(2, raw);
    if (p.kind === 'question' && p.robotBusiness) {
      return { id: r.id, ts: r.ts, robotBusiness: p.robotBusiness, raw };
    }
  }
  return null;
}

// One-shot: shared-read copy -> newest question snapshot -> cleanup.
function questionSnapshot(peer = PEER_COACH, log = null) {
  peer = peer || PEER_COACH;
  let tmp = null;
  try {
    const c = copyDb();
    tmp = c.tmp;
    const db = openCopy(c.dbPath);
    try {
      return { memberId: c.memberId, ...(latestQuestion(db, peer) || {}) };
    } finally { db.close(); }
  } catch (e) {
    if (log) log('[lib] DB snapshot unavailable: ' + e.message);
    return null;
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  }
}

module.exports = {
  PEER_COACH, PEER_COACH_DELIVERY, PEERS, PEER_NAMES, resolvePeer, peerName,
  dbDir, dbGlob, memberIdOf, copyDb, openCopy, decodeText, rowAllText,
  parseMessage, messageStreamUrl, latestQuestion, questionSnapshot,
};
