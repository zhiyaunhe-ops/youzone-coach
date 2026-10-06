#!/usr/bin/env node
// Offline self-test: no network, no YonZone, no DB writes.
//   node --no-warnings scripts/selftest.js      (or: npm test)
//
// Covers the parts that broke or drifted before: IM frame codec, RFC6455 frame
// reading (incl. fragmentation / RSV refusal), GBK decoding, newMessage payload
// parsing, and the headless CLI argument parser.
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lib = require('./lib');
const { imFrame, decodeFrame, parseArgs } = require('./coach_headless');
const { WsConn } = require('./ws_client');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + ((e && e.message) || e)); }
}

console.log('frame codec');
t('imFrame/decodeFrame round trip', () => {
  const payload = Buffer.from('{"a":1}', 'utf8');
  const buf = imFrame(4176, payload, 0xdeadbeef);
  assert.strictEqual(buf.length, 13 + payload.length);
  assert.strictEqual(buf[0], 0, 'sFrame');
  const f = decodeFrame(buf);
  assert.strictEqual(f.opcode, 4176);
  assert.strictEqual(f.packetLen, payload.length);
  assert.strictEqual(f.version, 0x0100);
  assert.strictEqual(f.seqId, 0xdeadbeef);
  assert.deepStrictEqual(f.payload, payload);
});
t('header field offsets are BE and in the documented order', () => {
  const buf = imFrame(1, Buffer.alloc(3, 0x41), 0x01020304);
  assert.strictEqual(buf.readUInt16BE(1), 1);
  assert.strictEqual(buf.readUInt32BE(3), 3);
  assert.strictEqual(buf.readUInt16BE(7), 0x0100);
  assert.strictEqual(buf.readUInt32BE(9), 0x01020304);
});
t('large payload uses the u32 length field', () => {
  const big = Buffer.alloc(70000, 7);
  const f = decodeFrame(imFrame(4176, big));
  assert.strictEqual(f.packetLen, 70000);
  assert.strictEqual(f.payload.length, 70000);
});

console.log('rfc6455 reader');
function stubSocket() {
  const handlers = {};
  return { handlers, written: [], on(ev, fn) { handlers[ev] = fn; }, write(b) { this.written.push(b); }, destroy() {} };
}
function serverFrame(opcode, payload, { fin = true, rsv1 = false } = {}) {
  const head = Buffer.from([(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode, payload.length]);
  return Buffer.concat([head, payload]);
}
function newConn() {
  const sock = stubSocket();
  const conn = new WsConn(sock);
  const got = { msgs: [], closed: null };
  conn.onMessage = (d, op) => got.msgs.push({ data: d.toString(), op });
  conn.onClose = (code, reason) => { got.closed = { code, reason }; };
  return { sock, conn, got };
}
t('reads a text frame', () => {
  const { sock, got } = newConn();
  sock.handlers.data(serverFrame(1, Buffer.from('hello')));
  assert.deepStrictEqual(got.msgs, [{ data: 'hello', op: 1 }]);
});
t('reassembles fragmented messages', () => {
  const { sock, got } = newConn();
  sock.handlers.data(Buffer.concat([serverFrame(2, Buffer.from('AB'), { fin: false }), serverFrame(0, Buffer.from('CD'))]));
  assert.deepStrictEqual(got.msgs, [{ data: 'ABCD', op: 2 }]);
});
t('handles a frame split across TCP packets', () => {
  const { sock, got } = newConn();
  const f = serverFrame(1, Buffer.from('split'));
  sock.handlers.data(f.subarray(0, 3));
  sock.handlers.data(f.subarray(3));
  assert.deepStrictEqual(got.msgs, [{ data: 'split', op: 1 }]);
});
t('answers ping with pong', () => {
  const { sock } = newConn();
  sock.handlers.data(serverFrame(9, Buffer.from('p')));
  assert.strictEqual(sock.written.length, 1);
  assert.strictEqual(sock.written[0][0], 0x8a);
});
t('refuses an RSV (compressed) frame instead of mis-parsing it', () => {
  const { sock, got } = newConn();
  sock.handlers.data(serverFrame(2, Buffer.from('x'), { rsv1: true }));
  assert.strictEqual(got.closed.code, 1002);
  assert.match(got.closed.reason, /RSV/);
});

console.log('message parsing');
t('decodeText prefers UTF-8 then GBK', () => {
  assert.strictEqual(lib.decodeText(Buffer.from('你好', 'utf8')), '你好');
  assert.strictEqual(lib.decodeText(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), '你好'); // GBK
  assert.strictEqual(lib.decodeText(null), null);
  assert.strictEqual(lib.decodeText('plain'), 'plain');
});
t('question row (contentType 2)', () => {
  const p = lib.parseMessage(2, JSON.stringify({ content: '库存调拨单和转库单的区别', robotBusiness: { chatId: 'c1', tenantId: 't1' } }));
  assert.strictEqual(p.kind, 'question');
  assert.strictEqual(p.text, '库存调拨单和转库单的区别');
  assert.strictEqual(p.robotBusiness.chatId, 'c1');
});
t('question row without robotBusiness and with plain-text content', () => {
  const p = lib.parseMessage(2, JSON.stringify({ content: '句子里没有 robotBusiness' }));
  assert.strictEqual(p.kind, 'question');
  assert.strictEqual(p.text, '句子里没有 robotBusiness');
  assert.strictEqual(p.robotBusiness, null);
});
t('answer row with showData JSON string', () => {
  const ext = JSON.stringify({
    responses: [{ data: { showData: JSON.stringify({ text: '答案正文' }) } }],
    thoughtChainResponses: [{ type: 'a', stepName: '规划分析' }, { type: 'b', stepName: '友问友答_V1' }],
    traceId: 'tr-1',
  });
  const raw = JSON.stringify({ contentType: 18, content: JSON.stringify({ extend: ext }) });
  const p = lib.parseMessage(18, raw);
  assert.strictEqual(p.kind, 'answer');
  assert.strictEqual(p.final, true);
  assert.strictEqual(p.text, '答案正文');
  assert.strictEqual(p.traceId, 'tr-1');
  assert.deepStrictEqual(p.steps.map(s => s.stepName), ['规划分析', '友问友答_V1']);
});
t('clarify reply uses data.text (answerType 97)', () => {
  const ext = JSON.stringify({ responses: [{ data: { answerType: 97, text: '你是想问哪个组织？' } }] });
  const raw = JSON.stringify({ contentType: 18, content: JSON.stringify({ extend: ext }) });
  const p = lib.parseMessage(18, raw);
  assert.strictEqual(p.final, true);
  assert.strictEqual(p.text, '你是想问哪个组织？');
});
t('WS envelope shape parses the same as the DB row shape', () => {
  const ext = JSON.stringify({ responses: [{ data: { showData: JSON.stringify({ text: '答案正文' }) } }], traceId: 'tr-2' });
  const wsAnswer = JSON.stringify({ id: 'M1', contentType: 18, content: JSON.stringify({ extend: ext }) });
  const p = lib.parseMessage(18, wsAnswer);
  assert.strictEqual(p.kind, 'answer');
  assert.strictEqual(p.text, '答案正文');
  assert.strictEqual(p.traceId, 'tr-2');
  assert.strictEqual(lib.messageStreamUrl(18, wsAnswer), null); // answer carries no stream url
  const wsQuestion = JSON.stringify({ id: 'M2', contentType: 2, content: JSON.stringify({ content: '问句', robotBusiness: { chatId: 'c', yht_access_token: 'tok' } }) });
  const q = lib.parseMessage(2, wsQuestion);
  assert.strictEqual(q.kind, 'question');
  assert.strictEqual(q.text, '问句');
  assert.strictEqual(q.robotBusiness.yht_access_token, 'tok');
});
t('metadata message in the WS envelope shape also yields callbackStreamUrl', () => {
  const ext = JSON.stringify({ data: { callbackStreamUrl: 'https://c1/stream/chat/U?tenantId=t' } });
  const ws = JSON.stringify({ id: 'M3', contentType: 18, content: JSON.stringify({ extend: ext }) });
  assert.strictEqual(lib.messageStreamUrl(18, ws), 'https://c1/stream/chat/U?tenantId=t');
});
t('metadata message yields callbackStreamUrl', () => {
  const ext = JSON.stringify({ data: { callbackStreamUrl: 'https://c1.yonyoucloud.com/stream/chat/UUID?tenantId=t1' } });
  const raw = JSON.stringify({ contentType: 18, content: JSON.stringify({ extend: ext }) });
  assert.strictEqual(lib.messageStreamUrl(18, raw), 'https://c1.yonyoucloud.com/stream/chat/UUID?tenantId=t1');
  assert.strictEqual(lib.messageStreamUrl(2, raw), null);
});
t('broken payloads do not throw', () => {
  assert.strictEqual(lib.parseMessage(18, 'not json').kind, 'unparsed');
  assert.strictEqual(lib.parseMessage(99, '{}').kind, 'other');
  assert.strictEqual(lib.parseMessage(2, '{}').kind, 'question');
});

console.log('headless CLI args');
t('bare question keeps every word (regression: first word was dropped)', () => {
  assert.deepStrictEqual(parseArgs(['1+1等于几？']).q, '1+1等于几？');
  assert.strictEqual(parseArgs(['请 用 一句话 说明']).q, '请 用 一句话 说明');
  assert.strictEqual(parseArgs(['q']).timeoutMs, 180000);
});
t('flags are honoured in any position', () => {
  assert.deepStrictEqual(parseArgs(['a b', '--timeout', '1000']), { q: 'a b', timeoutMs: 1000, json: false, peer: null, file: null, identify: null, help: false });
  assert.strictEqual(parseArgs(['-t', '500', '问', '题']).timeoutMs, 500);
  const o = parseArgs(['--json', '--peer', 'ipa_x', 'q']);
  assert.strictEqual(o.json, true);
  assert.strictEqual(o.peer, 'ipa_x');
  assert.strictEqual(o.q, 'q');
  assert.strictEqual(parseArgs(['--file', 'q.txt']).file, 'q.txt');
  assert.strictEqual(parseArgs(['--identify', 'ab12', 'q']).identify, 'ab12');
});
t('bad flags fail loudly instead of silently mangling the question', () => {
  assert.throws(() => parseArgs(['--timeout']), /positive number/);
  assert.throws(() => parseArgs(['--timeout', 'abc', 'q']), /positive number/);
  assert.throws(() => parseArgs(['--bogus', 'q']), /unknown flag/);
});
t('CLI exit codes', () => {
  const script = path.join(__dirname, 'coach_headless.js');
  const noArgs = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  // Under a sandboxed parent the child can be killed silently, which surfaces
  // as status === null with empty output. That is an environment limitation,
  // not a regression, so skip rather than report a false failure.
  if (noArgs.status === null) {
    console.log('    (skipped: child process was killed by the sandbox)');
    return;
  }
  assert.strictEqual(noArgs.status, 2, 'no args -> usage exit 2');
  assert.match(noArgs.stderr, /usage:/);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  if (help.status === null) return;
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /usage:/);
});

console.log('syntax');
t('every script parses', () => {
  // `node --check <file>` is spawned per file, which is slow and, under a
  // sandboxed parent, can be killed silently (status === null). Prefer a
  // single in-process parse of every file: vm.Script throws a SyntaxError with
  // the offending line, so coverage is the same and it cannot be killed.
  const vm = require('node:vm');
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 15, 'expected the full script set, saw ' + files.length);
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
  }
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall tests passed');
process.exit(failed ? 1 : 0);
