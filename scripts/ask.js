#!/usr/bin/env node
// CLI client for the coach ask service. Node argv is UTF-8-clean on Windows,
// unlike curl -d which sends argv in the ANSI codepage (GBK on this box) —
// so prefer this over curl for Chinese questions.
//   node ask.js "你好，请介绍一下自己"
//   node ask.js --file question.txt [--timeout 180000] [--port 8765]
//   node ask.js --peer delivery "..."      # 交付赋能总教练 (alias: impl = 高级版实施总教练)
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
if (!q) { console.error('usage: node ask.js "question" | --file f.txt [--peer impl|delivery]'); process.exit(2); }
const body = JSON.stringify({ q, timeoutMs: timeout, ...(peer ? { peer } : {}) });
const req = http.request({ host: '127.0.0.1', port, path: '/ask', method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } },
  res => {
    let b = ''; res.on('data', c => (b += c));
    res.on('end', () => {
      const r = JSON.parse(b || '{}');
      if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
      if (r.ok) {
        if (r.peerName) console.error(`[${r.peerName}] ${r.elapsedMs}ms`);
        console.log(r.answer);
      } else { console.error('FAILED:', JSON.stringify(r, null, 2)); process.exit(1); }
    });
  });
req.setTimeout(timeout + 30000);
req.on('error', e => { console.error('request error:', e.message); process.exit(1); });
req.end(body);
