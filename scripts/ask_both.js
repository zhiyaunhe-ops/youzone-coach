#!/usr/bin/env node
// Ask BOTH coaches the same question and save a single merged Markdown record.
//
// Why: 高级版实施总教练 and 交付赋能总教练 are backed by different agent graphs and
// routinely disagree or cover different ground. Project rule: never ask just one.
//
//   node ask_both.js "你的问题" [--timeout 240000] [--port 8765] [--out <dir>] [--tag <name>]
//   node ask_both.js --file q.txt --out D:\...\cmh_scm_2026Q4
//
// Output: <out>/coach_qa_<tag|ts>.md  (markdown, ready to paste into a delivery doc)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { PEER_COACH, PEER_COACH_DELIVERY, peerName, resolvePeer } = require('./lib');

const args = process.argv.slice(2);
let q = null, port = 8765, timeout = 240000, out = null, tag = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') q = fs.readFileSync(args[++i], 'utf8');
  else if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--timeout') timeout = Number(args[++i]);
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--tag') tag = args[++i];
  else q = args[i];
}
if (!q) { console.error('usage: node ask_both.js "question" | --file f.txt [--out dir] [--tag name]'); process.exit(2); }

const PEER_ORDER = [PEER_COACH, PEER_COACH_DELIVERY];

function post(peer) {
  const body = JSON.stringify({ q, timeoutMs: timeout, peer });
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ask', method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let b = ''; res.on('data', c => (b += c));
        res.on('end', () => {
          try { resolve(JSON.parse(b || '{}')); }
          catch { resolve({ ok: false, error: 'bad JSON: ' + b.slice(0, 300) }); }
        });
      });
    req.setTimeout(timeout + 30000);
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

async function main() {
  const results = [];
  for (const peer of PEER_ORDER) {
    const name = peerName(peer);
    process.stderr.write(`\n>>> asking ${name} (${peer}) ...\n`);
    const r = await post(peer);
    r._peer = peer; r._peerName = name;
    results.push(r);
    process.stderr.write(r.ok ? `<<< ok (${r.elapsedMs}ms)\n` : `<<< FAILED: ${r.error}\n`);
    console.log('\n' + '='.repeat(70));
    console.log(`## ${name}`);
    console.log('='.repeat(70));
    console.log(r.ok ? r.answer : `(failed: ${r.error})`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(out || process.cwd(), `coach_qa_${tag || ts}.md`);
  const md = [
    `# 教练问答记录${tag ? ' · ' + tag : ''}`,
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 提问对象：${PEER_ORDER.map(p => peerName(p)).join(' / ')}`,
    '',
    '## 问题',
    '',
    q.trim(),
    '',
    ...results.flatMap(r => [
      `## ${r._peerName}`,
      '',
      r.ok ? r.answer.trim() : `> 提问失败：${r.error}`,
      '',
      r.ok && r.steps && r.steps.length
        ? `<details><summary>意图流</summary>\n\n${r.steps.map(s => '- ' + (s.stepName || s.type)).join('\n')}\n\n</details>` : '',
      '',
    ]),
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md, 'utf8');
  console.log('\nWROTE ' + file);
}

main().catch(e => { console.error(e.message); process.exit(1); });
