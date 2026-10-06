#!/usr/bin/env node
// Export the coach conversation (or any public-account chat) from the local
// message DB to Markdown. Replaces the old dump_coach_chat.py.
//   node dump_chat.js [--peer ipa_<uuid>] [--out file] [--limit 200]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PEER_COACH, copyDb, openCopy, decodeText, parseMessage } = require('./lib');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PEER = opt('peer', PEER_COACH);
const LIMIT = Number(opt('limit', 500));

// Row parsing lives in lib.js; this file only formats (steps as "type:name").
function parseRow(row) {
  const p = parseMessage(row.ct, row.raw);
  if (p.kind === 'answer') p.steps = p.steps.map(s => s.type + ':' + (s.stepName || ''));
  return p;
}

const { tmp, dbPath } = copyDb();
try {
  const db = openCopy(dbPath);
  const rows = db.prepare(
    `SELECT id, CAST(contentType AS BLOB) ct, ts, CAST(content AS BLOB) c
     FROM newMessage WHERE oppositeId = ? ORDER BY ts ASC`
  ).all(PEER).map(r => ({ id: r.id, ct: Number(decodeText(r.ct)), ts: r.ts, raw: decodeText(r.c) }));
  db.close();

  const pairs = [];
  for (const r of rows.slice(-LIMIT * 2)) {
    const p = parseRow(r);
    if (p.kind === 'question') pairs.push({ ts: r.ts, q: p.text, a: null, steps: [], traceId: null });
    else if (p.kind === 'answer' && pairs.length) {
      const last = pairs[pairs.length - 1];
      if (p.final && !last.a) last.a = p.text;
      last.steps.push(...p.steps);
      if (p.traceId) last.traceId = p.traceId;
    }
  }
  const lines = [`# 教练问答记录（${PEER}）`, '', `> 导出于 ${new Date().toLocaleString()}，共 ${pairs.length} 问`, ''];
  for (const [i, p] of pairs.entries()) {
    lines.push(`## ${i + 1}. ${new Date(p.ts).toLocaleString()}`, '');
    lines.push(`**问：** ${p.q}`, '');
    lines.push(p.a ? `**教练：**\n\n${p.a}` : `**教练：**（未捕获终稿）`);
    if (p.steps.length) lines.push('', `*意图流：${[...new Set(p.steps)].join(' → ')}*`);
    if (p.traceId) lines.push(`*traceId: ${p.traceId}*`);
    lines.push('', '---', '');
  }
  const out = opt('out', path.join(__dirname, '..', 'references', 'coach-chat-log.md'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`${pairs.length} Q/A pairs -> ${out}`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
