#!/usr/bin/env node
// Queue integration test: boots a stubbed copy of coach_ask_server (no YonZone
// or CDP needed) and verifies FIFO positions, phase heartbeats, /queue, /stream
// and the sync fallback. Run with: npm run test:queue
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.COACH_TEST_PORT || 8799);
const serverFile = path.join(__dirname, '_queue_test_server.js');
let src = fs.readFileSync(path.join(__dirname, 'coach_ask_server.js'), 'utf8');
src = src.replace('const PORT = Number(process.env.COACH_PORT || 8765);', `const PORT = ${PORT};`);
src = src.replace('async function ask(', 'async function _realAsk(');
const stub = `
cd.resolveCoach = async () => ({ id: 'ipa_test', title: 'Test Coach' });
const ask = async (q, timeoutMs, coachArg, onProgress) => {
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (onProgress) onProgress({ step: i < 3 ? 'streaming' : 'finalizing', answers: 1, partialChars: 100 * (i + 1), elapsedMs: Date.now() - t0 });
  }
  return { ok: true, q, peer: 'ipa_test', peerName: 'Test Coach', answer: 'FAKE:' + q, elapsedMs: Date.now() - t0, steps: [] };
};
`;
if (!src.includes('server.listen(PORT')) throw new Error('listen anchor missing');
src = src.replace('server.listen(PORT', stub + '\nserver.listen(PORT');
fs.writeFileSync(serverFile, src);

const child = spawn(process.execPath, [serverFile], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, p, payload) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload), 'utf8');
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} },
      res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => (b += c));
        res.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('bad JSON: ' + b)); } }); });
    r.on('error', reject); r.setTimeout(10000, () => r.destroy(new Error('timeout'))); r.end(body);
  });
}

function stream(taskId) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/stream?taskId=' + taskId, method: 'GET' },
      res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = (block.match(/^event: (.+)$/m) || [])[1];
            const data = (block.match(/^data: (.+)$/m) || [])[1];
            if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
          }
        });
        res.on('end', () => resolve(events));
      });
    r.on('error', reject); r.setTimeout(15000, () => r.destroy(new Error('stream timeout'))); r.end();
  });
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAILED: ' + msg); console.log('  ok   ' + msg); };

(async () => {
  try {
    await sleep(1200);
    console.log('queue test on port ' + PORT);

    const a = await req('POST', '/ask', { q: 'A', mode: 'async' });
    const b = await req('POST', '/ask', { q: 'B', mode: 'async' });
    const c = await req('POST', '/ask', { q: 'C', mode: 'async' });
    assert(a.taskId && b.taskId && c.taskId, 'three async acks carry taskIds');
    assert(b.position >= 2, `second ack queues behind the first (position=${b.position})`);
    assert(c.position > b.position, `third ack is behind the second (position=${c.position})`);

    const q0 = await req('GET', '/queue');
    assert(q0.active && q0.waiting.length === 2, 'GET /queue shows 1 active + 2 waiting');
    assert(q0.waiting[0].position === 2 && q0.waiting[1].position === 3, 'waiting positions count the active task');

    const rb = await req('GET', '/result?taskId=' + b.taskId);
    assert(rb.state === 'pending' && rb.phase === 'queued', 'queued result reports phase=queued');
    assert(rb.position === 2 && rb.ahead === 1, 'queued result reports position/ahead');

    // Stream a queued task: should see queued -> running -> done.
    const streamP = stream(c.taskId);
    const q1 = await req('GET', '/queue');
    assert(q1.active && q1.active.taskId === a.taskId, 'first task still owns the coach');
    const events = await streamP;
    const statuses = events.filter(e => e.event === 'status').map(e => e.data);
    assert(statuses.length >= 1, 'stream emits status events');
    assert(statuses.every(s => typeof s.phase === 'string'), 'stream status carries phase');
    assert(statuses.some(s => s.phase === 'queued') && statuses.some(s => s.phase === 'running'),
      'stream shows queued -> running');
    const done = events.find(e => e.event === 'done');
    assert(done && done.data && done.data.ok, 'stream ends with done result');

    for (const [label, t] of [['A', a], ['B', b], ['C', c]]) {
      let r;
      for (let i = 0; i < 40; i++) {
        r = await req('GET', '/result?taskId=' + t.taskId);
        if (r.state !== 'pending') break;
        await sleep(300);
      }
      assert(r.state === 'done' && r.result.answer === 'FAKE:' + label,
        `task ${label} finishes with its own answer (FIFO order)`);
    }

    const s = await req('POST', '/ask', { q: 'D', mode: 'sync' });
    assert(s.ok && s.answer === 'FAKE:D', 'sync mode still answers in-band');

    const bad = await req('POST', '/ask', { mode: 'async' });
    assert(bad.ok === false && /missing/.test(bad.error), 'missing q is rejected');

    console.log('\nall queue tests passed');
  } finally {
    child.kill();
    try { fs.unlinkSync(serverFile); } catch {}
  }
})().catch(e => { console.error('FAILED:', e.message); child.kill(); try { fs.unlinkSync(serverFile); } catch {} process.exit(1); });
