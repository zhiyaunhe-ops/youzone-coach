#!/usr/bin/env node
// CLI client for the coach ask service. Node argv is UTF-8-clean on Windows,
// unlike curl -d which sends argv in the ANSI codepage (GBK on this box) —
// so prefer this over curl for Chinese questions.
//   node ask.js "你好，请介绍一下自己"
//   node ask.js --file question.txt [--timeout 180000] [--port 8765]
//   node ask.js --peer delivery "..."      # 交付赋能总教练 (alias: impl = 高级版实施总教练)
//   node ask.js --json "..."               # print the final result object
//
// The service defaults to ASYNC (returns a taskId at once). A human CLI wants the
// finished answer, so we explicitly request mode:"sync"; if a different server
// version still answers with a taskId, we poll /result — the CLI keeps working
// across mixed versions instead of printing an empty answer.
'use strict';
const fs = require('node:fs');
const http = require('node:http');

const args = process.argv.slice(2);
let q = null, port = 8765, timeout = 180000, peer = null, json = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') q = fs.readFileSync(args[++i], 'utf8');
  else if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--timeout') timeout = Number(args[++i]);
  else if (args[i] === '--peer' || args[i] === '--coach') peer = args[++i];
  else if (args[i] === '--json') json = true;
  else q = args[i];
}
if (!q) { console.error('usage: node ask.js "question" | --file f.txt [--peer impl|delivery] [--json]'); process.exit(2); }

function request(method, path, payload) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: body ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length } : {},
    }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b || '{}')); }
        catch { reject(new Error('bad JSON from server: ' + b.slice(0, 300))); }
      });
    });
    // A coach round can take minutes; the server enforces its own timeout. This
    // is only a safety net so the CLI fails loudly instead of hanging forever.
    const cap = method === 'POST' ? timeout + 60000 : 15000;
    req.setTimeout(cap, () => req.destroy(new Error('client timeout after ' + cap + 'ms')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  let r = await request('POST', '/ask', {
    q, timeoutMs: timeout, mode: 'sync', ...(peer ? { peer } : {}),
  });

  // Compatibility fallback: an async-only (or older default) server answers 202
  // with {ok:true, async:true, taskId}. Poll until the answer is final.
  if (r && r.ok && r.async && r.taskId) {
    const taskId = r.taskId;
    const deadline = Date.now() + timeout + 120000;
    process.stderr.write(`[task ${taskId}] waiting...\n`);
    for (;;) {
      if (Date.now() > deadline) throw new Error('timed out waiting for task ' + taskId);
      await sleep(2000);
      const s = await request('GET', '/result?taskId=' + encodeURIComponent(taskId));
      if (s.state === 'done') { r = s.result || { ok: false, error: 'done without result' }; break; }
      if (s.state === 'error') { r = s.result || { ok: false, error: s.error || 'task error' }; break; }
      if (s.error && !s.state) { r = { ok: false, error: s.error }; break; }
    }
  }

  if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  if (!r.ok) { console.error('FAILED:', JSON.stringify(r, null, 2)); process.exit(1); }
  if (r.peerName) console.error(`[${r.peerName}] ${r.elapsedMs}ms`);
  console.log(r.answer);
}

main().catch(e => { console.error('request error:', e.message); process.exit(1); });
