#!/usr/bin/env node
// Headless coach client: asks the YonZone 高级版实施总教练 a question over the IM
// WebSocket protocol directly - no UI automation, no CDP required (CDP is only
// used, when available, to refresh the yht_access_token from live cookies).
//
//   node coach_headless.js "问题" [--timeout 180000] [--json] [--peer ipa_<uuid>] [--file q.txt]
//
// Wire format (verified live; see references/protocol-map.md). Application frame
// = 13-byte header + payload, all big-endian:
//   [0] sFrame(0)  [1..3) opcode u16  [3..7) packetLen u32
//   [7..9) version=0x0100             [9..13) seqId u32
//   opcodes: 1=AUTH (client frame / server AUTH.KEY reply), 2=ping, 4098=receipts,
//            12289=presence, 4176=pubaccountMessage
// Auth is an APPLICATION frame, not a handshake cookie: the subprotocol header is
// just "xmpp" (Origin: file://), and the first frame we send is AUTH with imToken.
//
// Flow: connect -> AUTH(imToken) -> presence -> question(4176) -> receipts ->
//       metadata message carrying callbackStreamUrl -> POST it -> SSE deltas ->
//       final answer (the same text is also pushed back over the WS).
//
// Credentials: yht_access_token from YonZone's live cookies (CDP :8089), else from
// the newest question row in the local message DB (~install snapshot, may be
// stale). imToken is always exchanged fresh:
//   GET /yonbip-ec-base/user/pc/imToken?accessToken=<yht>  (header yht_access_token)
//
// Nothing about the conversation is hardcoded: memberId / chatId / tenantId /
// atRobotId / staffId / digitalCode come from that DB question row when present.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const { wsConnect } = require('./ws_client');
const { dbGlob, memberIdOf, parseMessage, messageStreamUrl, questionSnapshot, PEER_COACH } = require('./lib');

const IM_URL = 'wss://imws.yonyoucloud.com:5225';
const OP = { AUTH: 1, PING: 2, RECEIPTS: 4098, PRESENCE: 12289, PUBACCOUNT: 4176 };
const VERSION = 0x0100;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) youzone/8.5.1 Chrome/104.0.5112.124 Electron/20.3.12 Safari/537.36';

// YZ_CLIENT_IDENTIFY / --identify: override the AUTH device fingerprint (the derived
// one is the default so we do not impersonate the desktop renderer). Note that the
// fingerprint is NOT what takes the desktop client down: the IM server keeps a
// single session per account/device group, so ANY second AUTH from this channel makes
// the server push opcode 16640 {"code":409} to the desktop client and it logs out.
// See references/protocol-map.md; use channel C when the client must stay online.
//
// Public-safe fallback placeholders. Real identity must come from the local
// YonZone message DB on the current machine. These example values are never
// intended to authenticate against the service.
const FALLBACK = {
  peerId: PEER_COACH,
  memberId: 'example-member-id',
  chatId: 'example-chat-id',
  tenantId: 'example-tenant-id',
  yhtUserId: 'example-user-id',
  userName: 'Example User',
  digitalCode: 'example-digital-code',
  atRobotId: 'example-robot-id',
  staffId: 'example-staff-id',
  robotCallback: 'https://c1.yonyoucloud.com/iuap-aip-vpa/apiregister/im/message/chat',
  deviceType: 'pc',
  chatSource: 2004,
  imBr: 'pc-v2.8',
  imAppType: 8,
  imClientIdentify: 'example-client-identify',
};

// ---- IM frame codec --------------------------------------------------------

function imFrame(opcode, payloadBuf, seqId = 0) {
  const h = Buffer.alloc(13);
  h[0] = 0;                                  // sFrame
  h.writeUInt16BE(opcode, 1);
  h.writeUInt32BE(payloadBuf.length, 3);
  h.writeUInt16BE(VERSION, 7);
  h.writeUInt32BE(seqId >>> 0, 9); // >>> 0: & 0xffffffff keeps the sign bit and throws on big values
  return Buffer.concat([h, payloadBuf]);
}

function decodeFrame(buf) {
  const packetLen = buf.readUInt32BE(3);
  return {
    opcode: buf.readUInt16BE(1),
    packetLen,
    version: buf.readUInt16BE(7),
    seqId: buf.readUInt32BE(9),
    payload: buf.subarray(13, 13 + packetLen),
  };
}

// ---- identity --------------------------------------------------------------

const pick = (v, d) => (v === undefined || v === null || v === '' ? d : v);

// The real client writes every question row with its full robotBusiness block;
// that row is the most accurate description of this install, so prefer it over
// the captured constants. Requires no running client (shared-read DB copy).
function resolveIdentity({ peer = null, log = console.error } = {}) {
  let memberId = null;
  try { memberId = memberIdOf(dbGlob()); } catch (e) { log('[db] ' + e.message); }
  const snap = questionSnapshot(peer || FALLBACK.peerId, log);
  const rb = (snap && snap.robotBusiness) || null;
  const source = rb ? 'db-question-row' : 'example-placeholder';
  const peerId = peer || FALLBACK.peerId;
  if (!rb || !memberId) {
    throw new Error('no local YonZone identity found: open the coach chat once on this machine, then retry');
  }
  const resolvedMemberId = memberId;
  const identify = process.env.YZ_CLIENT_IDENTIFY
    || crypto.createHash('sha1').update('youzone-coach/headless/' + resolvedMemberId).digest('hex');
  const identifySource = process.env.YZ_CLIENT_IDENTIFY
    ? (process.env.YZ_CLIENT_IDENTIFY === FALLBACK.imClientIdentify ? 'desktop-captured (explicit)' : 'env override')
    : 'derived (own device)';
  const id = {
    source, peerId,
    peerJid: peerId + '.esn.upesn@pubaccount.im.yyuap.com',
    memberId: resolvedMemberId,
    chatId: pick(rb && rb.chatId, FALLBACK.chatId),
    tenantId: pick(rb && rb.tenantId, FALLBACK.tenantId),
    yhtUserId: pick(rb && rb.yhtUserId, FALLBACK.yhtUserId),
    userName: pick(rb && rb.userName, FALLBACK.userName),
    digitalCode: pick(rb && rb.digitalCode, FALLBACK.digitalCode),
    atRobotId: pick(rb && rb.atRobotId, FALLBACK.atRobotId),
    staffId: pick(rb && rb.staffId, FALLBACK.staffId),
    robotCallback: pick(rb && rb.callback, FALLBACK.robotCallback),
    deviceType: pick(rb && rb.deviceType, FALLBACK.deviceType),
    chatSource: pick(rb && rb.chatSource, FALLBACK.chatSource),
    imBr: FALLBACK.imBr,
    imAppType: FALLBACK.imAppType,
    imClientIdentify: identify,
    identifySource,
    dbToken: rb ? rb.yht_access_token : null,
    dbTokenTs: snap && snap.ts ? snap.ts : null,
  };
  return id;
}

// ---- credentials -----------------------------------------------------------

// Live token from the running YonZone (CDP :8089, enabled via
// resources/app/process.env YOUZONE_LOG_LEVEL=1).
// The cookie jar is per renderer partition and /json/list order is not stable
// (observed: same command succeeded, then missed the cookie a minute later), so
// try the main renderer first and then every other page target, keeping the first hit.
async function tokenFromYonZoneCdp(log = () => {}) {
  const zc = require('./youzone_cdp');
  const targets = (await zc.listTargets()).filter(t => t.webSocketDebuggerUrl && t.type === 'page');
  if (!targets.length) throw new Error('no page target');
  const isMain = t => /renderer\/index\.html/.test(t.url || '');
  const ordered = targets.slice().sort((a, b) => (isMain(b) ? 1 : 0) - (isMain(a) ? 1 : 0));
  const tried = [];
  for (const t of ordered) {
    const cdp = new zc.CDP(t.webSocketDebuggerUrl);
    try {
      await cdp.connect();
      await cdp.send('Network.enable');
      const all = await cdp.send('Network.getAllCookies', {});
      const n = (all.cookies || []).length;
      const tk = (all.cookies || []).find(c => c.name === 'yht_access_token' && c.domain === '.yonyoucloud.com');
      tried.push((t.url || '?').slice(-28) + '=' + n + 'cookies');
      if (tk) {
        log('[creds] yht_access_token from ' + (isMain(t) ? 'main renderer' : t.url || '?') + ' (' + n + ' cookies)');
        return tk.value;
      }
    } catch (e) {
      tried.push((t.url || '?').slice(-28) + '=err:' + String(e.message).slice(0, 40));
    } finally { try { cdp.close(); } catch {} }
  }
  throw new Error('yht_access_token cookie not found - tried ' + targets.length + ' page target(s) [' + tried.join(' | ') + ']');
}

async function getCredentials({ id, log = console.error } = {}) {
  let yht = null, source = null;
  if (!process.env.YZ_NO_CDP) {
    try { yht = await tokenFromYonZoneCdp(log); source = 'yonzone-cdp'; }
    catch (e) { log('[creds] YonZone CDP unavailable: ' + e.message); }
  }
  if (!yht) {
    if (!id.dbToken) {
      throw new Error('no credentials: YonZone not reachable on CDP and no question row in the local DB to fall back to; '
        + 'start YonZone (CDP on 127.0.0.1:8089) or open the coach chat once');
    }
    yht = id.dbToken;
    source = 'db-snapshot@' + (id.dbTokenTs ? new Date(id.dbTokenTs).toISOString() : 'unknown-ts');
    log('[creds] falling back to the DB snapshot token - it may be stale, start YonZone to refresh');
  }
  const res = await fetch('https://c2.yonyoucloud.com/yonbip-ec-base/user/pc/imToken?accessToken=' + encodeURIComponent(yht), {
    headers: { 'yht_access_token': yht, 'User-Agent': UA },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.data || !body.data.token) {
    const code = body.code !== undefined ? body.code : (body.errcode !== undefined ? body.errcode : res.status);
    throw new Error('imToken exchange rejected (' + code + '): ' + JSON.stringify(body).slice(0, 200)
      + ' - the yht_access_token is stale; start/refresh YonZone and retry'
      + (source.startsWith('db-snapshot') ? ' (currently using source: ' + source + ')' : ''));
  }
  return { yht, imToken: body.data.token, expiration: body.data.expiration, source };
}

// ---- question frame --------------------------------------------------------

function buildQuestionInner(q, token, id) {
  return JSON.stringify({
    content: q,
    robotBusiness: {
      fileList: [], folderList: [], commandId: '',
      chatId: id.chatId, chatType: 0,
      pageContext: { businessData: {} },
      userName: id.userName,
      digitalCode: id.digitalCode,
      atRobotId: id.atRobotId,
      domainId: 'yonbip-ec-pc',
      tenantId: id.tenantId,
      yhtUserId: id.yhtUserId,
      yht_access_token: token,
      callback: id.robotCallback,
      deviceType: id.deviceType,
      chatSource: id.chatSource,
      streamConfig: { scene: 'secretary' },
      staffId: id.staffId,
    },
  });
}

function buildQuestionFrame(q, token, id) {
  const inner = buildQuestionInner(q, token, id);
  const msg = {
    id: crypto.randomUUID().toUpperCase(),
    type: 'pubaccount',
    contentType: 2,
    dateline: Date.now(),
    content: inner,
    to: id.peerJid,
    oppositeId: id.memberId,
    from: id.memberId,
    senderId: id.memberId + '.esn.upsen', // sic - replicate the client's own spelling
  };
  return { msgId: msg.id, frame: imFrame(OP.PUBACCOUNT, Buffer.from(JSON.stringify(msg), 'utf8')), msg };
}

function parseWsAnswer(payloadStr) {
  const p = parseMessage(18, payloadStr);
  return p.kind === 'answer' ? p : null;
}

// POST the callbackStreamUrl (no body) and assemble the streamed answer.
async function readSseAnswer(streamUrl, yhtToken, onFrame) {
  const res = await fetch(streamUrl, {
    method: 'POST',
    headers: {
      'yht_access_token': yhtToken,
      'accept': '*/*',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
  });
  if (!res.ok || !res.body) throw new Error('sse open failed: ' + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out = { text: '', steps: [], traceId: null, questionId: null, finished: false };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const d = JSON.parse(line.slice(5));
        if (d.result) out.text += d.result;
        for (const t of d.thoughtChainResponses || []) if (t.stepName) out.steps.push(t.type + ':' + t.stepName);
        if (d.traceId) out.traceId = d.traceId;
        if (d.questionId) out.questionId = d.questionId;
        if (d.finishReason === true) out.finished = true;
        if (onFrame) onFrame(d);
      } catch {}
    }
    if (out.finished) break;
  }
  return out;
}

async function ask(q, { timeoutMs = 180000, log = console.error, peer = null } = {}) {
  const id = resolveIdentity({ peer, log });
  log('[identity] clientIdentify = ' + id.identifySource + ' ' + id.imClientIdentify.slice(0, 10) + '...');
  log('[identity] member=' + id.memberId + ' peer=' + id.peerId + ' chatId=' + id.chatId + ' source=' + id.source);
  const creds = await getCredentials({ id, log });
  log('[creds] yht from ' + creds.source + ', imToken ' + creds.imToken.slice(0, 8) + '...'
    + (creds.expiration ? ' (exp ' + new Date(creds.expiration).toISOString() + ')' : ''));

  // Handshake mirrors the real renderer: subprotocol xmpp + Origin file://, no cookies.
  const conn = await wsConnect(IM_URL, {
    protocols: ['xmpp'],
    headers: { Origin: 'file://', 'User-Agent': UA },
  });
  log('[ws] connected');

  // JSJaCWebSocketConnection._onopen: first frame is AUTH (opcode 1) with
  // {usr, atk, br, appType, clientIdentify}; the server answers AUTH.KEY with code 200 + jid.
  // YZ_AUTH_FIELDS merges extra JSON into the frame (experiments, e.g. conflictStrategy).
  let authExtra = {};
  if (process.env.YZ_AUTH_FIELDS) {
    try { authExtra = JSON.parse(process.env.YZ_AUTH_FIELDS) || {}; }
    catch (e) { log('[auth] ignoring bad YZ_AUTH_FIELDS: ' + e.message); }
  }
  log('[ws] note: this second session takes the desktop client over (server pushes 16640/409); use the CDP ask server if it must stay online');
  conn.sendBinary(imFrame(OP.AUTH, Buffer.from(JSON.stringify({
    usr: id.memberId + '.esn.upesn', atk: creds.imToken, br: id.imBr,
    appType: id.imAppType, clientIdentify: id.imClientIdentify, ...authExtra,
  }), 'utf8')));
  log('[auth] AUTH sent (usr=%s)', id.memberId + '.esn.upesn');

  const result = { ok: false, q, answer: '', steps: [], traceId: null, msgId: null, raw: [], elapsedMs: 0 };
  const sse = { started: false, result: null };
  const t0 = Date.now();
  let sent = null, lastChange = Date.now(), authed = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finalize(), timeoutMs);
    function finalize() {
      clearTimeout(timer);
      result.elapsedMs = Date.now() - t0;
      try { conn.close(); } catch {}
      if (result.ok) resolve(result);
      else reject(Object.assign(new Error('timeout without final answer'), { result }));
    }

    conn.onClose = (code, reason) => {
      log('[ws] closed ' + code + ' ' + reason);
      if (!result.ok && !sent) reject(new Error('ws closed before send: ' + code));
      else finalize();
    };

    conn.onMessage = (data) => {
      if (data.length < 13) return;
      const { opcode, payload } = decodeFrame(data);
      if (opcode === OP.AUTH) {
        let info = {}; try { info = JSON.parse(payload.toString('utf8') || '{}'); } catch {}
        authed = info.code === 200;
        log('[auth] AUTH.KEY code=' + info.code + ' jid=' + (info.jid || '?'));
        if (!authed) { clearTimeout(timer); return reject(new Error('auth failed: ' + payload.toString('utf8').slice(0, 120))); }
        conn.sendBinary(imFrame(OP.PRESENCE, Buffer.from('{}', 'utf8')));
        return;
      }
      if (opcode === OP.PING) { conn.sendBinary(imFrame(OP.PING, Buffer.alloc(0))); return; }
      if (opcode !== OP.PUBACCOUNT && opcode !== OP.RECEIPTS) return;
      const s = payload.toString('utf8');
      let j = {}; try { j = JSON.parse(s); } catch { return; }
      if (opcode === OP.RECEIPTS) {
        if (j.id === sent && !result.acked) { result.acked = true; log('[im] server acked our message'); }
        return;
      }
      if (sent && j.id === sent && j.state !== undefined) return; // echo of our own send
      const ct = Number(j.contentType);
      if (ct !== 18) { lastChange = Date.now(); log('[im] message ct=' + ct + ' ignored'); return; }
      result.raw.push(s.slice(0, 400));
      if (result.raw.length > 10) result.raw.shift();
      // ack it so the server does not re-deliver
      conn.sendBinary(imFrame(OP.RECEIPTS, Buffer.from(JSON.stringify({
        to: j.from || id.peerJid, dateline: Date.now(),
        sessionVersion: j.sessionVersion || 0, id: j.id, state: 2,
      }), 'utf8')));
      const a = parseWsAnswer(s);
      if (a && a.final) {
        // WS-delivered final (server push after stream completion)
        result.steps = a.steps.map(x => x.stepName).filter(Boolean);
        result.traceId = a.traceId;
        if (a.text !== result.answer) {
          result.answer = a.text; result.ok = true; lastChange = Date.now();
          log('[im] final answer via WS push (' + a.text.length + ' chars)');
        }
        return;
      }
      const url = messageStreamUrl(18, s);
      if (url && !sse.started) {
        sse.started = true;
        log('[sse] reading stream...');
        sse.promise = readSseAnswer(url, creds.yht, () => { lastChange = Date.now(); })
          .then(r => { sse.result = r; log('[sse] finished, finished=' + r.finished + ' chars=' + r.text.length); })
          .catch(e => log('[sse] error: ' + e.message));
      } else {
        lastChange = Date.now();
        log('[im] intermediate message');
      }
    };

    // settle when the SSE stream finished (or a WS final arrived)
    (async () => {
      while (Date.now() - t0 < timeoutMs) {
        await new Promise(r => setTimeout(r, 1000));
        if (sse.result && (sse.result.finished || sse.result.text)) {
          if (!result.ok && sse.result.text) {
            result.ok = true;
            result.answer = sse.result.text;
            result.steps = [...new Set(sse.result.steps)];
            result.traceId = sse.result.traceId;
          }
          if (sse.result.finished || Date.now() - lastChange > 8000) return finalize();
        }
        if (result.ok && Date.now() - lastChange > 8000) return finalize();
      }
      finalize();
    })();

    // wait a beat for AUTH.KEY before sending the question
    (async () => {
      for (let i = 0; i < 40 && !authed; i++) await new Promise(r => setTimeout(r, 250));
      if (!authed) return; // auth failure path already rejected
      const qf = buildQuestionFrame(q, creds.yht, id);
      sent = qf.msgId;
      result.msgId = sent;
      conn.sendBinary(qf.frame);
      log('[im] question sent, msgId=' + sent);
    })().catch(e => { clearTimeout(timer); reject(e); });
  });
  return result;
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const out = { q: '', timeoutMs: 180000, json: false, peer: null, file: null, identify: null, help: false };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--timeout' || a === '-t') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error('--timeout needs a positive number of milliseconds');
      out.timeoutMs = v;
    } else if (a === '--peer') out.peer = argv[++i];
    else if (a === '--identify') out.identify = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a.startsWith('--')) throw new Error('unknown flag: ' + a);
    else words.push(a);
  }
  out.q = words.join(' ').trim();
  return out;
}

const USAGE = 'usage: node coach_headless.js "问题" [--timeout 180000] [--json] [--peer ipa_<uuid>] [--file q.txt] [--identify <40hex>]';

module.exports = { ask, imFrame, decodeFrame, parseArgs, resolveIdentity, buildQuestionFrame, getCredentials, tokenFromYonZoneCdp, parseWsAnswer, IM_URL, UA, OP, FALLBACK };

if (require.main === module) {
  let opt;
  try { opt = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message + '\n' + USAGE); process.exit(2); }
  if (opt.help) { console.log(USAGE); process.exit(0); }
  if (opt.identify) process.env.YZ_CLIENT_IDENTIFY = opt.identify;
  if (opt.file) opt.q = fs.readFileSync(opt.file, 'utf8').trim();
  if (!opt.q) { console.error(USAGE); process.exit(2); }
  ask(opt.q, { timeoutMs: opt.timeoutMs, peer: opt.peer })
    .then(r => {
      if (opt.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log('--- ANSWER ---');
      console.log(r.answer);
      console.log('--- steps: ' + [...new Set(r.steps)].join(' -> ') + ' | elapsed ' + (r.elapsedMs / 1000).toFixed(1) + 's');
    })
    .catch(e => {
      console.error('FAILED: ' + e.message);
      if (e.result) console.error('partial: ' + JSON.stringify({ steps: e.result.steps, raw: (e.result.raw || []).slice(-2) }, null, 1).slice(0, 800));
      process.exit(1);
    });
}
