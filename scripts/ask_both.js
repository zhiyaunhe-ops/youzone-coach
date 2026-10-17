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

// Ask by ALIAS, not by peer id: the server resolves each alias against the
// live YonZone agent list, so this works on any account/tenant (and with a
// coach that has never been chatted with). The ids printed by the server are
// recorded in the markdown for traceability.
const PEER_ORDER = ['impl', 'delivery'];
const LABELS = {
  impl: '高级版实施总教练（多智能验证版）',
  delivery: '交付赋能总教练',
};

function post(peer) {
  const body = JSON.stringify({ q, timeoutMs: timeout, peer, mode: 'sync' });
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

const HKT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function hkt(v) {
  if (v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : HKT.format(d).replace('T', ' ') + ' HKT';
}

async function main() {
  // SERIAL BY DESIGN: open coach A -> send -> wait until the final answer is on
  // disk -> only then switch the webview to coach B. Both coaches render in one
  // 'single-agent' webview and switching reloads it, so sending in parallel (or
  // switching tabs while an answer is streaming) loses the first answer and lets
  // the DB anchor land in the wrong conversation.
  const results = [];
  for (const peer of PEER_ORDER) {
    const label = LABELS[peer];
    process.stderr.write(`\n>>> asking ${label} (${peer}) ...\n`);
    const r = await post(peer);
    // The server reports which live coach the alias resolved to on THIS login.
    const name = r.peerName || label;
    r._peer = peer; r._peerName = name; r._peerId = r.peer || null;
    results.push(r);
    process.stderr.write(r.ok
      ? `<<< ok · asked ${hkt(r.qTs) || '?'} · answered ${hkt(r.answerTs) || '?'} · anchor=${r.anchor} · id=${r.peer || '?'} (${r.elapsedMs}ms)\n`
      : `<<< FAILED: ${r.error}${r.qTs ? ' (question row IS in DB at ' + hkt(r.qTs) + ')' : ''}\n`);
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
    '- 提问方式：串行（问完一个教练、等终稿落库后再切下一个会话）',
    `- 提问对象：${PEER_ORDER.map(p => LABELS[p]).join(' / ')}`,
    ...results.map(r => `- ${r._peerName}${r._peerId ? '（`' + r._peerId + '`）' : ''}：提问 ${hkt(r.qTs) || '（未落库）'} → 回答 ${hkt(r.answerTs) || '（本轮未取到）'}`),
    '',
    '## 问题',
    '',
    q.trim(),
    '',
    ...results.flatMap(r => [
      `## ${r._peerName}`,
      '',
      r.qTs
        ? `- 提问时间：${hkt(r.qTs)}（anchor=${r.anchor}）`
        : '- 提问时间：本地库未见提问行（发送很可能失败）',
      r.ok
        ? `- 回答时间：${hkt(r.answerTs) || '未知'}
- 请求耗时：${(r.elapsedMs / 1000).toFixed(1)}s`
        : `- 回答时间：本轮未取到终稿（${r.error}）${r.qTs ? `\n- 答案可能稍后落库：\`node scripts/dump_chat.js --peer ${r._peer}\`` : ''}`,
      '',
      r.ok ? r.answer.trim() : `> 提问${r.qTs ? '已发出，但本轮未取到答案' : '失败'}：${r.error}`,
      '',
      r.ok && r.steps && r.steps.length
        ? `<details><summary>意图流</summary>\n\n${r.steps.map(s => '- ' + (s.stepName || s.type)).join('\n')}\n\n</details>` : '',
      '',
    ]),
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md, 'utf8');
  console.log('\nWROTE ' + file);
  if (results.some(r => !r.ok)) process.exitCode = 3; // never report success on a dropped answer
}

main().catch(e => { console.error(e.message); process.exit(1); });
