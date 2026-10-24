#!/usr/bin/env node
// Print the coach ask queue: who owns the webview now and the FIFO behind them.
// The service runs one ask at a time (single webview), so this is the "why is my
// question still waiting?" view.
//
//   node queue.js [--port 8765] [--json]
'use strict';
const http = require('node:http');

const args = process.argv.slice(2);
let port = Number(process.env.COACH_PORT || 8765), json = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--json') json = true;
}

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b || '{}')); }
        catch { reject(new Error('bad JSON from server: ' + b.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const secs = ms => ms == null ? '?' : (ms / 1000).toFixed(1) + 's';

(async () => {
  let q;
  try { q = await get('/queue'); }
  catch (e) { console.error('cannot reach coach service on port ' + port + ': ' + e.message); process.exit(1); }
  if (json) { console.log(JSON.stringify(q, null, 2)); process.exit(0); }

  if (!q.active && !(q.waiting || []).length) { console.log('queue idle'); process.exit(0); }
  if (q.active) {
    const a = q.active;
    console.log(`running  ${a.peerName || a.peer}  ${a.taskId}  ${secs(a.elapsedMs)}` +
      (a.progress && a.progress.step ? `  step=${a.progress.step}` : ''));
    console.log(`         ${a.qPreview}`);
  }
  for (const w of q.waiting || []) {
    console.log(`waiting  #${w.position}  ${w.peerName || w.peer}  ${w.taskId}  queued ${secs(w.queuedMs)}`);
    console.log(`         ${w.qPreview}`);
  }
  console.log(`(${q.count} task(s) in flight)`);
})().catch(e => { console.error(e.message); process.exit(1); });
