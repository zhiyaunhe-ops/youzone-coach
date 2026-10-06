#!/usr/bin/env node
// Capture the network traffic behind one coach Q&A round, via CDP Network
// domain on ALL page/webview targets (the question POST may leave from the
// secretary webview while the answer stream may arrive elsewhere).
//
//   node coach_capture.js [--dur 90000] [--out file] [--ask "question"]
//
// With --ask the script arms the capture first, then sends the question
// itself (native setter + click), so one run owns the whole round.
// Output: JSON with every request/response/WebSocket frame, plus a stdout
// summary of candidate API endpoints.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zc = require('./youzone_cdp');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const DUR = Number(opt('dur', 90000));
const OUT = opt('out', null);
const ASK = args.includes('--ask') ? opt('ask', '你好，请用一句话介绍你自己') : null;

const MAX_BODY = 120000, MAX_WS = 6000;

(async () => {
  const targets = (await zc.listTargets())
    .filter(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview')
      && !/browserwindow|browserview\.html/.test(t.url));
  if (!targets.length) { console.error('no targets'); process.exit(1); }

  const events = [];
  const sessions = [];
  const tagOf = t => /single-agent/.test(t.url) ? 'webview'
    : /renderer\/index\.html/.test(t.url) ? 'main'
    : (t.url.split('/').pop() || t.url).slice(0, 24);

  const onEvent = (tag, url) => m => {
    const { method, params } = m;
    const ev = { ts: Date.now(), target: tag };
    if (method === 'Network.requestWillBeSent') {
      Object.assign(ev, {
        type: 'request', requestId: params.requestId, url: params.request.url,
        method: params.request.method, resourceType: params.type,
        headers: params.request.headers,
        postData: params.request.postData ? String(params.request.postData).slice(0, MAX_BODY) : undefined,
      });
      if (params.request.postDataEntries) {
        ev.postData = Buffer.concat(params.request.postDataEntries.map(p => Buffer.from(p.bytes || '', 'base64'))).toString('utf8').slice(0, MAX_BODY);
      }
    } else if (method === 'Network.responseReceived') {
      Object.assign(ev, { type: 'response', requestId: params.requestId, url: params.response.url,
        status: params.response.status, mimeType: params.response.mimeType, fromServiceWorker: params.response.fromServiceWorker });
    } else if (method === 'Network.loadingFailed') {
      Object.assign(ev, { type: 'loadingFailed', requestId: params.requestId, errorText: params.errorText, canceled: params.canceled });
    } else if (method === 'Network.webSocketCreated') {
      Object.assign(ev, { type: 'wsCreated', requestId: params.requestId, url: params.url });
    } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const p = params.response;
      Object.assign(ev, { type: method === 'Network.webSocketFrameSent' ? 'wsSent' : 'wsRecv',
        requestId: params.requestId, opcode: p.opcode,
        payload: String(p.payloadData || '').slice(0, MAX_WS) });
    } else if (method === 'Network.eventSourceMessageReceived') {
      Object.assign(ev, { type: 'sse', requestId: params.requestId, eventName: params.eventName,
        data: String(params.data || '').slice(0, MAX_WS) });
    } else return;
    events.push(ev);
  };

  for (const t of targets) {
    const tag = tagOf(t);
    try {
      const cdp = new zc.CDP(t.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Network.enable', { maxPostDataSize: MAX_BODY });
      cdp.on(onEvent(tag, t.url));
      sessions.push({ tag, cdp, url: t.url });
      console.error(`capturing [${tag}] ${t.url.slice(0, 90)}`);
    } catch (e) { console.error(`skip [${tag}]: ${e.message}`); }
  }

  const startedAt = Date.now();
  if (ASK) {
    await zc.foreground();
    await new Promise(r => setTimeout(r, 800));
    const wv = sessions.find(s => s.tag === 'webview');
    if (!wv) { console.error('no webview session; cannot send'); }
    else { await zc.sendQuestion(wv.cdp, ASK); console.error('question sent, capturing...'); }
  }

  await new Promise(r => setTimeout(r, DUR));

  // fetch response bodies for API-looking requests (skip static/media)
  const reqs = events.filter(e => e.type === 'request');
  for (const s of sessions) {
    for (const r of reqs.filter(x => x.target === s.tag)) {
      if (!/xhr|fetch|eventsource|websocket|other/i.test(r.resourceType || '')) continue;
      try {
        const body = await s.cdp.send('Network.getResponseBody', { requestId: r.requestId });
        if (body && body.body && body.body.length < MAX_BODY) {
          r.respBody = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        }
      } catch {}
    }
  }

  const out = OUT || path.join(__dirname, '..', 'references', `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ startedAt, durationMs: DUR, asked: ASK, sessions: sessions.map(s => ({ tag: s.tag, url: s.url })), events }, null, 1));
  console.error(`saved ${events.length} events -> ${out}`);

  // summary: distinct API endpoints
  const seen = new Map();
  for (const e of reqs) {
    if (!/^https?:/.test(e.url)) continue;
    if (/\.(js|css|png|jpg|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(e.url)) continue;
    const u = new URL(e.url);
    const key = `${e.method} ${u.host}${u.pathname}`;
    if (!seen.has(key)) seen.set(key, { n: 0, hasOurQuestion: false, status: '', firstReqId: `${e.target}|${e.requestId}` });
    seen.get(key).n++;
    if (ASK && e.postData && e.postData.includes(ASK)) seen.get(key).hasOurQuestion = true;
  }
  const statusById = new Map();
  for (const r of events.filter(e => e.type === 'response')) statusById.set(`${r.target}|${r.requestId}`, String(r.status));
  console.log('=== API endpoints seen ===');
  for (const [k, v] of [...seen].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${v.hasOurQuestion ? '>>>' : '   '} ${k}  x${v.n} ${v.status || statusById.get(v.firstReqId) || ''}`);
  }
  const ws = events.filter(e => e.type === 'wsCreated');
  console.log('=== WebSockets ===');
  for (const w of ws) console.log(`[${w.target}] ${w.url}`);
  const wsFrames = events.filter(e => e.type === 'wsSent' || e.type === 'wsRecv');
  console.log(`ws frames: ${wsFrames.length} (sent ${wsFrames.filter(f => f.type === 'wsSent').length} / recv ${wsFrames.filter(f => f.type === 'wsRecv').length})`);
  const sse = events.filter(e => e.type === 'sse');
  console.log(`sse events: ${sse.length}`);

  for (const s of sessions) s.cdp.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
