#!/usr/bin/env node
// Local HTTP service that turns the YonZone coach (高级版实施总教练) into an API:
//   POST /ask    {q, timeoutMs?}  -> ask the coach, wait for the final answer
//   GET  /history?n=20           -> recent Q/A pairs read from the local DB
//   GET  /health                 -> cdp/webview/db status
//   GET  /targets                -> CDP target list
//
// Requires: YonZone running with CDP on 127.0.0.1:8089 (YOUZONE_LOG_LEVEL=1 in
// resources/app/process.env) and the coach conversation openable from the
// session list. Zero dependencies, Node >= 22.5.
//
// How it works: send = drive the secretary webview over CDP; read = poll a
// shared-read copy of %APPDATA%/youzone/sqlite/YYIMDB_*.db. Answer rows are
// contentType=18 with the final text in content->extend(JSON string)
// ->responses[0].data.showData.text. Baselines use message ts + id, NOT rowid
// (newest rows can carry the LOWEST rowid because history pages are appended).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { PEER_COACH, PEER_COACH_DELIVERY, PEERS, PEER_NAMES, resolvePeer, peerName,
        copyDb, openCopy, decodeText, parseMessage } = require('./lib');
const zc = require('./youzone_cdp');

const PORT = Number(process.env.COACH_PORT || 8765);
const PEER = resolvePeer(process.env.COACH_PEER || PEER_COACH); // default coach; per-request peer overrides it
const POLL_MS = 4000, QUIET_MS = 8000, DEFAULT_TIMEOUT = 180000;

const sleep = zc.sleep;
const now = () => Date.now();

function withDb(fn) {
  const { tmp, dbPath } = copyDb();
  try {
    const db = openCopy(dbPath);
    try { return fn(db); } finally { db.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// All messages of the coach conversation, decoded. content is a JSON string
// (question side) or a JSON string whose .extend is ANOTHER JSON string (bot).
function peerRows(db, peer = PEER) {
  const rows = db.prepare(
    `SELECT rowid rid, id, CAST(contentType AS BLOB) ct, ts, CAST(content AS BLOB) c
     FROM newMessage WHERE oppositeId = ? ORDER BY ts ASC`
  ).all(peer);
  return rows.map(r => ({
    rid: r.rid, id: r.id, ct: Number(decodeText(r.ct)), ts: r.ts,
    raw: decodeText(r.c),
  }));
}

// ---- conversation switching (two coaches share one webview) -----------------

// The main renderer page carries the open peer in its hash: #/main/im/<peer>/...
async function mainPage() {
  const ts = await zc.listTargets();
  const p = ts.find(t => t.type === 'page' && /\/main\/im/.test(t.url));
  if (!p) throw new Error('main im page not found (is YonZone open?)');
  const c = new zc.CDP(p.webSocketDebuggerUrl);
  await c.connect();
  return c;
}

async function currentPeer(main) {
  const hash = await main.eval('location.hash');
  const m = /\/main\/im\/([^/?#]+)/.exec(String(hash || ''));
  return m ? m[1] : null;
}

// Make sure the webview shows `peer`; click the conversation row if it does not.
// Without this check a question aimed at one coach would land in the other's chat.
async function ensureConversation(peer) {
  const main = await mainPage();
  try {
    for (let i = 0; i < 12; i++) {
      const cur = await currentPeer(main);
      if (cur === peer) { main.close(); return true; }
      if (i === 0) await zc.openConversation(main, peer);
      await sleep(1500);
    }
    const cur = await currentPeer(main);
    main.close();
    return cur === peer;
  } catch (e) { try { main.close(); } catch {} throw e; }
}

// Row parsing lives in lib.js (shared with dump_chat.js / coach_headless.js).
function parseRow(row) { return parseMessage(row.ct, row.raw); }

// Serialize asks: one question in flight at a time.
let chain = Promise.resolve();

async function ask(q, timeoutMs = DEFAULT_TIMEOUT, peerArg = PEER) {
  const peer = resolvePeer(peerArg);
  const t0 = now();
  await zc.foreground();

  // 1) make sure the RIGHT conversation is open: both coaches render in the same
  //    'single-agent' webview, so trusting the existing webview sends to the wrong one.
  if (!await ensureConversation(peer)) {
    throw new Error('could not switch conversation to ' + peerName(peer) + ' (' + peer + ')');
  }

  let webviewCdp;
  for (let i = 0; i < 10 && !webviewCdp; i++) {
    try { webviewCdp = await zc.connect('single-agent'); } catch { await sleep(1500); }
  }
  if (!webviewCdp) throw new Error('webview did not appear after opening conversation');

  try {
    // 2) baseline: snapshot existing message ids
    const baseIds = new Set(withDb(db => peerRows(db, peer).map(r => r.id)));

    // 3) send
    await zc.sendQuestion(webviewCdp, q);

    // 4) locate our question row to anchor the wait on its ts
    let qts = null;
    for (let i = 0; i < 8 && qts === null; i++) {
      await sleep(2000);
      withDb(db => {
        for (const r of peerRows(db, peer)) {
          if (!baseIds.has(r.id) && r.ct === 2) {
            const p = parseRow(r);
            if (p.kind === 'question' && p.text === q) { qts = r.ts; baseIds.add(r.id); break; }
          }
        }
      });
    }
    if (qts === null) throw new Error('sent question not found in DB (send likely failed)');

    // 5) poll for bot answers newer than the question
    const answers = new Map(); // id -> parsed answer (re-parsed each copy: rows update in place)
    let lastChange = now();
    while (now() - t0 < timeoutMs) {
      await sleep(POLL_MS);
      let changed = false;
      withDb(db => {
        for (const r of peerRows(db, peer)) {
          if (r.ct !== 18 || r.ts < qts || (baseIds.has(r.id) && !answers.has(r.id))) continue;
          const p = parseRow(r);
          if (p.kind !== 'answer') continue;
          const prev = answers.get(r.id);
          if (!prev || prev.text !== p.text) { answers.set(r.id, p); changed = true; }
        }
      });
      if (changed) lastChange = now();
      const finals = [...answers.values()].filter(a => a.final);
      if (finals.length && now() - lastChange > QUIET_MS) break;
    }
    const finals = [...answers.values()].filter(a => a.final);
    if (!finals.length) {
      return { ok: false, error: 'timeout without final answer', q, elapsedMs: now() - t0,
        partial: [...answers.values()] };
    }
    const last = finals[finals.length - 1];
    return { ok: true, q, answer: last.text, traceId: last.traceId, questionId: last.questionId,
      steps: last.steps, allAnswers: finals.map(f => f.text), elapsedMs: now() - t0 };
  } finally { webviewCdp.close(); }
}

function history(n = 20, peerArg = PEER) {
  const peer = resolvePeer(peerArg);
  return withDb(db => {
    const rows = peerRows(db, peer).slice(-n * 2);
    const out = [];
    let cur = null;
    for (const r of rows) {
      const p = parseRow(r);
      if (p.kind === 'question') { cur = { ts: r.ts, q: p.text, a: null, steps: [] }; out.push(cur); }
      else if (p.kind === 'answer' && cur) {
        if (p.final) cur.a = p.text;
        cur.steps.push(...p.steps.map(s => s.stepName).filter(Boolean));
        cur.traceId = p.traceId;
      }
    }
    return out.filter(x => x.a !== null).slice(-n);
  });
}

async function health() {
  let cdp = false, webview = false, targets = [];
  try {
    targets = await zc.listTargets();
    cdp = true;
    webview = targets.some(t => (t.url || '').includes('single-agent'));
  } catch {}
  const db = { peerRows: 0, lastTs: null };
  try { withDb(d => { const r = peerRows(d); db.peerRows = r.length; db.lastTs = r.length ? r[r.length - 1].ts : null; }); } catch {}
  return { cdp, webview, peer: PEER, peerName: peerName(PEER),
    availablePeers: Object.entries(PEER_NAMES).map(([id, name]) => ({ id, name, alias: aliasOf(id) })),
    db, port: PORT };
}

function aliasOf(id) {
  return Object.keys(PEERS).find(a => PEERS[a] === id) || null;
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/ask') {
    let b = ''; req.on('data', c => (b += c));
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
      const q = body.q || body.question;
      if (!q) return send(400, { ok: false, error: 'missing "q"' });
      const peer = resolvePeer(body.peer || body.coach);
      chain = chain.then(() => ask(q, Number(body.timeoutMs) || DEFAULT_TIMEOUT, peer))
        .then(r => { if (!res.writableEnded) send(r.ok ? 200 : 504, { ...r, peer, peerName: peerName(peer) }); })
        .catch(e => { if (!res.writableEnded) send(500, { ok: false, error: String(e.message || e) }); });
    });
  } else if (req.method === 'GET' && url.pathname === '/history') {
    send(200, history(Number(url.searchParams.get('n')) || 20,
      resolvePeer(url.searchParams.get('peer') || url.searchParams.get('coach'))));
  } else if (req.method === 'GET' && url.pathname === '/health') {
    health().then(h => send(200, h)).catch(e => send(500, { error: String(e) }));
  } else if (req.method === 'GET' && url.pathname === '/targets') {
    zc.listTargets().then(t => send(200, t.map(x => ({ type: x.type, title: x.title, url: x.url }))))
      .catch(e => send(500, { error: String(e) }));
  } else send(404, { error: 'use POST /ask {q}, GET /history?n=, GET /health, GET /targets' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`coach ask service on http://127.0.0.1:${PORT}`);
  console.log(`  default peer: ${PEER} (${peerName(PEER)})`);
  console.log(`  per-request: POST /ask {"q":"...","peer":"impl"|"delivery"|<peer id>}`);
  for (const [id, name] of Object.entries(PEER_NAMES)) console.log(`  - ${name} = ${id} (alias: ${aliasOf(id)})`);
});
