#!/usr/bin/env node
// Waiter for a coach async task. A sub-agent (派子 Agent) that submits a question
// via POST /ask (which returns a taskId at once) can spawn THIS as a detached,
// backgrounded process so the answer is waited for OUTSIDE the sub-agent's own
// ~2-minute connection cap. When the task reaches a terminal state, the waiter
// prints the answer to stdout and writes it to a result file (--out).
//
//   node await_task.js <taskId> [--port 8765] [--timeout 360000] [--out result.json]
//
// Exit 0 = final answer available; exit 1 = still pending/errored at timeout.
'use strict';
const fs = require('node:fs');
const http = require('node:http');

const args = process.argv.slice(2);
let taskId = null, port = 8765, timeout = 360000, out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--timeout') timeout = Number(args[++i]);
  else if (args[i] === '--out') out = args[++i];
  else if (!taskId) taskId = args[i];
}
if (!taskId) { console.error('usage: node await_task.js <taskId> [--port 8765] [--timeout 360000] [--out result.json]'); process.exit(2); }

const deadline = Date.now() + timeout;
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      let b = ''; res.on('data', c => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('get timeout')));
    req.end();
  });
}

(async () => {
  while (Date.now() < deadline) {
    let r;
    try { r = await get(`/result?taskId=${encodeURIComponent(taskId)}`); }
    catch { await new Promise(s => setTimeout(s, 3000)); continue; }
    if (r.state === 'done' || r.state === 'error') {
      if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
      const res = r.result || {};
      if (res.ok) { console.log(res.answer || JSON.stringify(res)); process.exit(0); }
      console.error('TASK ERROR:', JSON.stringify(res, null, 2)); process.exit(1);
    }
    await new Promise(s => setTimeout(s, 2000));
  }
  console.error('TIMEOUT waiting for task', taskId);
  process.exit(1);
})();
