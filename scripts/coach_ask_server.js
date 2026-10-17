#!/usr/bin/env node
// Local HTTP service that turns the YonZone coaches into an API:
//   POST /ask    {q, peer?, timeoutMs?, mode?}  -> ask one coach (async by default)
//   GET  /result?taskId= | /stream?taskId=       -> fetch a pending/终稿 result
//   GET  /history?n=20&peer=impl|delivery|<id>   -> recent Q/A pairs from the DB
//   GET  /health                 -> cdp/webview/discovered coaches/db status
//   GET  /discover               -> live-discovered ipa_ agents {id,title}
//   GET  /targets                -> CDP target list
//
// Requires: YonZone running with CDP on 127.0.0.1:8089 (YOUZONE_LOG_LEVEL=1 in
// resources/app/process.env). Coach ids are discovered LIVE from the client
// (see coach-discover.js) — no hardcoded ids, and no prior chat history needed:
// the 智能体 catalog tab lists every authorized agent, and clicking a row starts
// the conversation. Zero dependencies, Node >= 22.5.
//
// How it works: send = drive the secretary webview over CDP; read = poll a
// shared-read copy of %APPDATA%/youzone/sqlite/YYIMDB_*.db. Answer rows are
// contentType=18 with the final text in content->extend(JSON string)
// ->responses[0].data.showData.text. Baselines use message ts + id, NOT rowid
// (newest rows can carry the LOWEST rowid because history pages are appended).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { copyDb, openCopy, decodeText, parseMessage } = require('./lib');
const cd = require('./coach-discover');
const zc = require('./youzone_cdp');

const PORT = Number(process.env.COACH_PORT || 8765);
// Default coach TOKEN (alias, title substring, or ipa_ id) — never a hardcoded
// id, so a different login/tenant still lands on its implementation coach.
const PEER = process.env.COACH_PEER || 'impl';
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
function peerRows(db, peer) {
  if (!peer) throw new Error('peerRows: peer id required');
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

// Titles of the live 'single-agent' webview(s). Both coaches render in ONE such
// webview, but its title only flips to the target coach AFTER the reload that
// the conversation click triggers -- so a hash-only check can pass while the
// webview is still painting the PREVIOUS coach.
async function webviewTitles() {
  const ts = await zc.listTargets();
  return ts.filter(t => (t.url || '').includes('single-agent'))
    .map(t => (t.title || '').trim());
}

// Make sure the webview shows `peer`; click the conversation row if it does not.
// Without this check a question aimed at one coach would land in the other's chat.
// TWO conditions must hold: main-page hash == peer AND the single-agent webview
// title == that coach's display name (otherwise we would race the reload).
// `peerTitle` is the display name discovered live from the conversation list
// (coach-discover), NOT a hardcoded constant -- so this works on any login.
async function ensureConversation(peer, peerTitle) {
  // The list row also carries a trailing "智能体" label; the webview title does
  // not. Normalize both sides before comparing.
  const want = cd.normTitle(peerTitle || '');
  const main = await mainPage();
  let cur = null, titles = [];
  try {
    for (let i = 0; i < 16; i++) {
      cur = await currentPeer(main);
      titles = await webviewTitles();
      if (cur === peer && (!want || titles.some(t => cd.normTitle(t) === want))) { main.close(); return true; }
      // i=0 switches the conversation; i=6 re-clicks in case the first click was
      // swallowed while the renderer was still busy bringing the window up.
      if (i === 0 || i === 6) await zc.openConversation(main, peer);
      await sleep(1500);
    }
    cur = await currentPeer(main);
    titles = await webviewTitles();
    main.close();
    if (cur === peer && (!want || titles.some(t => cd.normTitle(t) === want))) return true;
    throw new Error('could not switch conversation to ' + (want || peer) + ' (' + peer + ')' +
      ' — now at ' + cur + ', webview titles: ' + JSON.stringify(titles));
  } catch (e) { try { main.close(); } catch {} throw e; }
}

// Row parsing lives in lib.js (shared with dump_chat.js / coach_headless.js).
function parseRow(row) { return parseMessage(row.ct, row.raw); }

// The composer rewrites line endings (CRLF -> LF) and trims trailing blanks, so
// raw-string equality false-negatives on multi-line questions and would drop a
// good answer as "send failed". Compare on collapsed whitespace instead.
function normalize(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

// Serialize asks: one question in flight at a time.
let chain = Promise.resolve();

// ---- async task store ------------------------------------------------------
// /ask in its original form was SYNCHRONOUS: the HTTP connection stayed open
// until the coach's final answer was ready, which can take 1-3+ minutes.
// Callers that impose their own short client timeout (sub-agents / 派子 Agent,
// ~2 min) would disconnect and lose the result even though generation kept
// running. We now return a taskId immediately and keep the result here so a
// caller can re-fetch it (GET /result or GET /stream) even after its own
// timeout/retry — the long-running work is no longer tied to one connection.
const TASK_TTL_MS = 1 * 60 * 60 * 1000; // results kept for 1h
const tasks = new Map(); // id -> { state, q, peer, ts, startedAt, finishedAt, result }

function newTask(q, peer, opts = {}) {
  const id = randomUUID();
  const t = { id, state: 'pending', q, peer, ts: now(), startedAt: null, finishedAt: null, result: null,
    // feedback channels: how the sub-agent wants to be told when it's done.
    callback: opts.callback || null,          // URL the server POSTs the result to on completion
    notifyFile: opts.notifyFile || null,      // file path the server writes the result JSON to
    callbackStatus: null, notifyFileStatus: null };
  tasks.set(id, t);
  // lazy sweep of expired tasks
  if (tasks.size > 64) for (const [k, v] of tasks) if (now() - v.ts > TASK_TTL_MS) tasks.delete(k);
  return t;
}

// Only allow http/https callbacks; block the cloud metadata endpoint (SSRF).
function safeCallbackUrl(u) {
  if (!u) return null;
  let x; try { x = new URL(u); } catch { return null; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
  if (x.hostname === '169.254.169.254') return null;
  // By default we only push to localhost; set COACH_ALLOW_REMOTE_CB=1 to allow
  // other hosts (only if the sub-agents really run on another machine).
  const local = x.hostname === '127.0.0.1' || x.hostname === 'localhost' || x.hostname === '[::1]' || x.hostname === '::1';
  if (!local && process.env.COACH_ALLOW_REMOTE_CB !== '1') return null;
  return x;
}

// Push the finished result to whatever feedback channel the caller asked for.
// Best-effort: failures are recorded on the task, never throw (the answer is safe
// in GET /result regardless).
async function notifyTask(t) {
  if (t.callback) {
    const url = safeCallbackUrl(t.callback);
    if (!url) { t.callbackStatus = 'rejected:url'; }
    else {
      try {
        const r = await fetch(String(url), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: t.id, state: t.state, q: t.q, result: t.result }),
        });
        t.callbackStatus = r.ok ? 'sent' : ('http_' + r.status);
      } catch (e) { t.callbackStatus = 'error:' + e.message; }
    }
  }
  if (t.notifyFile) {
    try {
      fs.mkdirSync(require('node:path').dirname(t.notifyFile), { recursive: true });
      fs.writeFileSync(t.notifyFile, JSON.stringify({ taskId: t.id, state: t.state, q: t.q, result: t.result }, null, 2));
      t.notifyFileStatus = 'written';
    } catch (e) { t.notifyFileStatus = 'error:' + e.message; }
  }
  return t;
}

async function ask(q, timeoutMs = DEFAULT_TIMEOUT, coachArg = PEER) {
  // Accept a coach already resolved by the caller (the HTTP layer resolves once
  // per request) or a token to resolve LIVE from the running YonZone. Never a
  // hardcoded id: {id,title} comes from the client's own agent catalog.
  let coach;
  if (coachArg && coachArg.id) coach = coachArg;
  else {
    try { coach = await cd.resolveCoach(coachArg); }
    catch (e) { throw new Error('coach discovery failed: ' + e.message); }
  }
  const peer = coach.id;            // the real ipa_ id for this login
  const peerTitle = coach.title;    // display name used to verify the webview
  const t0 = now();
  await zc.foreground();

  // 1) make sure the RIGHT conversation is open: both coaches render in the same
  //    'single-agent' webview, so trusting the existing webview sends to the wrong one.
  await ensureConversation(peer, peerTitle);

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
    const qNorm = normalize(q);
    let qts = null, anchor = null, newestNew = null;
    for (let i = 0; i < 8 && qts === null; i++) {
      await sleep(2000);
      withDb(db => {
        for (const r of peerRows(db, peer)) {
          if (baseIds.has(r.id) || r.ct !== 2) continue;
          const p = parseRow(r);
          if (p.kind !== 'question') continue;
          if (normalize(p.text) === qNorm) { qts = r.ts; anchor = 'text'; baseIds.add(r.id); break; }
          if (newestNew === null || r.ts > newestNew) newestNew = r.ts;
        }
      });
    }
    // Fallback: a brand-new ct=2 row for THIS peer appeared after our send, so it
    // is ours even if the echoed text differs (composer edits / truncation).
    if (qts === null && newestNew !== null) { qts = newestNew; anchor = 'newest-question-row'; }
    if (qts === null) {
      // Distinguish a silent send failure from a MISROUTE: if an identical new
      // question row showed up under a DIFFERENT coach, the webview had not
      // swapped yet and the question landed in the wrong conversation.
      const others = (await cd.discoverCoaches()).map(c => c.id).filter(id => id !== peer);
      let misroutedTo = null;
      withDb(db => {
        for (const other of others) {
          for (const r of peerRows(db, other)) {
            if (baseIds.has(r.id) || r.ct !== 2) continue;
            const p = parseRow(r);
            if (p.kind === 'question' && normalize(p.text) === qNorm) { misroutedTo = other; break; }
          }
          if (misroutedTo) break;
        }
      });
      throw new Error(misroutedTo
        ? 'question was misrouted to another coach (' + misroutedTo + ') (webview had not switched yet)'
        : 'sent question not found in DB (send likely failed)');
    }

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
          if (!prev || prev.text !== p.text) { answers.set(r.id, { ...p, ts: r.ts }); changed = true; }
        }
      });
      if (changed) lastChange = now();
      const finals = [...answers.values()].filter(a => a.final);
      if (finals.length && now() - lastChange > QUIET_MS) break;
    }
    const finals = [...answers.values()].filter(a => a.final);
    if (!finals.length) {
      return { ok: false, error: 'timeout without final answer', q,
        peer, peerName: peerTitle, qTs: qts, anchor,
        sentAt: new Date(qts).toISOString(), elapsedMs: now() - t0,
        partial: [...answers.values()].map(p => p.text) };
    }
    const last = finals[finals.length - 1];
    return { ok: true, q, peer, peerName: peerTitle, answer: last.text,
      traceId: last.traceId, questionId: last.questionId, steps: last.steps,
      qTs: qts, answerTs: last.ts || null, anchor,
      sentAt: new Date(qts).toISOString(),
      answeredAt: last.ts ? new Date(last.ts).toISOString() : null,
      allAnswers: finals.map(f => f.text), elapsedMs: now() - t0 };
  } finally { webviewCdp.close(); }
}

function history(n = 20, peer) {
  if (!peer) throw new Error('history: a resolved peer id is required');
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
  // Coaches are discovered LIVE; never rely on a hardcoded id/name table.
  let coaches = [], defaultCoach = null, discoverError = null;
  try {
    coaches = await cd.coachList();
    defaultCoach = await cd.resolveCoach(PEER);
  } catch (e) { discoverError = String(e.message || e); }
  const db = { peerRows: 0, lastTs: null };
  try {
    if (defaultCoach) withDb(d => {
      const r = peerRows(d, defaultCoach.id);
      db.peerRows = r.length; db.lastTs = r.length ? r[r.length - 1].ts : null;
    });
  } catch {}
  return { cdp, webview, coaches: coaches.length,
    defaultCoach: defaultCoach ? { id: defaultCoach.id, title: defaultCoach.title } : null,
    defaultToken: PEER, discoverError, db, port: PORT };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/ask') {
    let b = ''; req.on('data', c => (b += c));
    req.on('end', async () => {
      let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
      const q = body.q || body.question;
      if (!q) return send(400, { ok: false, error: 'missing "q"' });
      // Resolve the coach token to a live {id,title} BEFORE queuing so the ack
      // carries the real peer; if discovery fails, fail fast instead of queuing
      // a doomed task behind the chain.
      let coach;
      try { coach = await cd.resolveCoach(body.peer || body.coach || PEER); }
      catch (e) { return send(400, { ok: false, error: 'coach resolution failed: ' + e.message }); }
      const peer = coach.id, peerTitle = coach.title;
      // mode: "async" (default) returns a taskId immediately and keeps the
      // result retrievable; "sync" blocks until done (legacy behaviour).
      const mode = body.mode === 'sync' ? 'sync' : 'async';
      // feedback: how the caller wants to be TOLD when generation finishes
      // (the sub-agent may have already given up on its own 2-min connection).
      const task = newTask(q, peer, {
        callback: body.callback || null,          // URL to POST the result to on completion
        notifyFile: body.notifyFile || null,      // file to write the result JSON to
      });

      // Mark final + push to feedback channels, then settle the HTTP response if
      // the connection is still open (sync callers). Centralised so both sync and
      // async paths notify identically.
      const finish = async (r) => {
        task.state = r.ok ? 'done' : 'error';
        task.result = { ...r, peer, peerName: peerTitle };
        task.finishedAt = now();
        await notifyTask(task);
        if (!res.writableEnded) send(r.ok ? 200 : (mode === 'sync' ? 504 : 200), { ...r, peer, peerName: peerTitle });
      };

      if (mode === 'sync') {
        chain = chain.then(() => ask(q, Number(body.timeoutMs) || DEFAULT_TIMEOUT, coach))
          .then(finish)
          .catch(async e => {
            task.state = 'error'; task.result = { ok: false, error: String(e.message || e) };
            task.finishedAt = now(); await notifyTask(task);
            if (!res.writableEnded) send(500, { ok: false, error: String(e.message || e) });
          });
        return;
      }

      // async: start work, return taskId at once. The sub-agent's own timeout
      // cannot lose the result: it is pushed via callback/notifyFile AND kept
      // for 1h under /result.
      chain = chain.then(() => ask(q, Number(body.timeoutMs) || DEFAULT_TIMEOUT, coach))
        .then(finish)
        .catch(async e => {
          task.state = 'error'; task.result = { ok: false, error: String(e.message || e) };
          task.finishedAt = now(); await notifyTask(task);
        });
      // immediate ack — the result is fetched via GET /result or GET /stream,
      // or pushed to the caller's callback/notifyFile as soon as it is ready.
      send(202, { ok: true, async: true, taskId: task.id, state: 'pending',
        peer, peerName: peerTitle,
        poll: `GET /result?taskId=${task.id}`,
        stream: `GET /stream?taskId=${task.id}`,
        callback: task.callback || undefined, notifyFile: task.notifyFile || undefined });
    });
  } else if (req.method === 'GET' && url.pathname === '/result') {
    const id = url.searchParams.get('taskId');
    const t = tasks.get(id);
    if (!t) return send(404, { ok: false, error: 'unknown taskId', taskId: id });
    if (t.state === 'pending') return send(200, { ok: true, state: 'pending', taskId: id,
      q: t.q, peer: t.peer, queuedMs: now() - t.ts,
      callback: t.callback || undefined, callbackStatus: t.callbackStatus,
      notifyFile: t.notifyFile || undefined, notifyFileStatus: t.notifyFileStatus });
    if (t.state === 'error') return send(200, { ok: false, state: 'error', taskId: id, result: t.result,
      callbackStatus: t.callbackStatus, notifyFileStatus: t.notifyFileStatus });
    // done
    send(200, { ok: true, state: 'done', taskId: id, result: t.result });
  } else if (req.method === 'GET' && url.pathname === '/stream') {
    const id = url.searchParams.get('taskId');
    const t = tasks.get(id);
    if (!t) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'unknown taskId' })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
    const emit = () => {
      if (res.writableEnded) return;
      if (t.state === 'pending') res.write(`event: status\ndata: ${JSON.stringify({ state: 'pending', queuedMs: now() - t.ts })}\n\n`);
      else res.write(`event: done\ndata: ${JSON.stringify(t.result || { ok: false, error: 'unknown error' })}\n\n`);
    };
    emit();
    let iv = null, onDone = null;
    if (t.state === 'pending') {
      iv = setInterval(() => { if (!res.writableEnded) emit(); }, 2000);
      onDone = setInterval(() => {
        if (t.state !== 'pending') { clearInterval(iv); clearInterval(onDone); emit();
          if (!res.writableEnded) res.end(); }
      }, 500);
    } else { if (!res.writableEnded) res.end(); }
    // Clear every timer on client disconnect (otherwise polling contexts leak).
    req.on('close', () => { clearInterval(ping); if (iv) clearInterval(iv); if (onDone) clearInterval(onDone); });
  } else if (req.method === 'GET' && url.pathname === '/history') {
    let coach;
    try { coach = await cd.resolveCoach(url.searchParams.get('peer') || url.searchParams.get('coach') || PEER); }
    catch (e) { return send(400, { ok: false, error: 'coach resolution failed: ' + e.message }); }
    send(200, history(Number(url.searchParams.get('n')) || 20, coach.id));
  } else if (req.method === 'GET' && url.pathname === '/health') {
    health().then(h => send(200, h)).catch(e => send(500, { error: String(e) }));
  } else if (req.method === 'GET' && url.pathname === '/discover') {
    cd.coachList().then(c => send(200, c)).catch(e => send(500, { error: String(e) }));
  } else if (req.method === 'GET' && url.pathname === '/targets') {
    zc.listTargets().then(t => send(200, t.map(x => ({ type: x.type, title: x.title, url: x.url }))))
      .catch(e => send(500, { error: String(e) }));
  } else send(404, { error: 'use POST /ask {q}, GET /history?n=, GET /health, GET /discover, GET /targets' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`coach ask service on http://127.0.0.1:${PORT}`);
  console.log(`  coaches are discovered LIVE from the YonZone client (no hardcoded IDs)`);
  console.log(`  default token: "${PEER}" (alias / title substring / ipa_ id)`);
  console.log(`  per-request: POST /ask {"q":"...","peer":"impl"|"delivery"|<substring>|<ipa_ id>}`);
  console.log(`  async by default -> returns taskId; fetch with GET /result?taskId= | GET /stream?taskId=`);
  console.log(`  legacy sync: POST /ask {"q":"...","mode":"sync"} (blocks until answer)`);
  console.log(`  GET /discover -> live-discovered {id,title} agents; GET /health for resolution status`);
});
