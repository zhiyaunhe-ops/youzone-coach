#!/usr/bin/env node
// Zero-dependency CDP client for the YonZone (友空间) Electron client.
// Works as CLI (list/eval/evalfile/click/insfile/fg) and as a library.
//
// Env: YOUZONE_CDP_PORT (default 8089), YOUZONE_TARGET (url/title keyword,
//      e.g. "single-agent" picks the secretary webview; empty = main page).
//
// Gotchas baked in (from live sessions):
// - background windows throttle renderers -> run `fg` before evals with timers
// - Vue listens to native events -> click() dispatches mousedown/mouseup/click
// - textarea needs the native value setter + input event, Input.insertText
//   drops characters when document.hasFocus() === false
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.YOUZONE_CDP_PORT || 8089);
const TARGET_KW = process.env.YOUZONE_TARGET || '';

function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function listTargets() {
  return getJSON('/json/list');
}

// Pick a target by keyword; 'single-agent' style webviews match on url/title.
function pickTarget(targets, kw = TARGET_KW) {
  const pages = targets.filter(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview'));
  if (kw) {
    const hit = pages.find(t => (t.url + ' ' + t.title).toLowerCase().includes(kw.toLowerCase()));
    if (hit) return hit;
    throw new Error(`no target matching "${kw}"; have: ` +
      pages.map(t => `${t.type}:${(t.url || '').slice(0, 80)}`).join(' | '));
  }
  const main = pages.find(t => /main\/index\.html|workbench|im\//.test(t.url)) || pages[0];
  if (!main) throw new Error('no page targets at all');
  return main;
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this._id = 0; this._pending = new Map(); this._handlers = []; }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws connect timeout')); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); this.ws = ws; resolve(this); };
      ws.onerror = e => { clearTimeout(timer); reject(new Error('ws error')); };
      ws.onclose = () => {
        for (const { reject: r } of this._pending.values()) r(new Error('ws closed'));
        this._pending.clear();
      };
      ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && this._pending.has(m.id)) {
          const { resolve: rs, reject: rj } = this._pending.get(m.id);
          this._pending.delete(m.id);
          m.error ? rj(new Error(m.error.message || JSON.stringify(m.error))) : rs(m.result);
        } else if (m.method) {
          for (const h of this._handlers) h(m);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, 30000);
    });
  }

  on(handler) { this._handlers.push(handler); }

  async eval(expr, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval failed: ' + (d.exception?.description || d.text || JSON.stringify(d)));
    }
    return r.result?.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

async function connect(sel) {
  const t = pickTarget(await listTargets(), sel === undefined ? TARGET_KW : sel);
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.target = t;
  return cdp;
}

// ---- DOM helpers (evaluated inside the page/webview) ----

const JS_CLICK = sel => `(() => {
  const sel = ${JSON.stringify(sel)};
  const el = document.querySelector(sel);
  if (!el) throw new Error('not found: ' + sel);
  el.scrollIntoView({block: 'center'});
  const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  const opts = {bubbles: true, cancelable: true, view: window, clientX: x, clientY: y};
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  return true;
})()`;

// Native value setter + input event: React/Vue controlled components ignore
// plain assignment; Input.insertText loses chars when the window is blurred.
const JS_INSERT = (sel, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) throw new Error('not found: ' + ${JSON.stringify(sel)});
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', {bubbles: true}));
  return el.value.length;
})()`;

const JS_TEXTAREA = 'textarea.Footer-module__textarea--tcK0J';
const JS_SENDBTN = 'img.Footer-module__send--O8Qrd';

// Send a question into the open secretary conversation.
async function sendQuestion(cdp, text) {
  const n = await cdp.eval(JS_INSERT(JS_TEXTAREA, text));
  if (!n) throw new Error('textarea empty after insert');
  await cdp.eval(JS_CLICK(JS_SENDBTN));
  return true;
}

// Open a public-account conversation from the main page session list.
async function openConversation(cdpMain, peerId) {
  const sel = `li.all-item[data-id="${peerId}"]`;
  await cdpMain.eval(JS_CLICK(sel));
}

// Bring YonZone to the foreground (renderer throttling breaks evals otherwise).
function foreground() {
  const script = path.join(__dirname, 'fg.ps1');
  return new Promise((resolve, reject) => {
    spawn('pwsh', ['-NoProfile', '-File', script], { windowsHide: true })
      .on('exit', c => c === 0 ? resolve() : reject(new Error('fg.ps1 exit ' + c)))
      .on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- CLI ----
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'list') { console.log(JSON.stringify(await listTargets(), null, 2)); return; }
  if (cmd === 'fg') { await foreground(); console.log('foregrounded'); return; }
  const cdp = await connect();
  try {
    if (cmd === 'eval') console.log(JSON.stringify(await cdp.eval(rest[0])));
    else if (cmd === 'evalfile') console.log(JSON.stringify(await cdp.eval(fs.readFileSync(rest[0], 'utf8'))));
    else if (cmd === 'click') console.log(JSON.stringify(await cdp.eval(JS_CLICK(rest[0]))));
    else if (cmd === 'insfile') console.log(JSON.stringify(await cdp.eval(JS_INSERT(JS_TEXTAREA, fs.readFileSync(rest[0], 'utf8')))));
    else if (cmd === 'send') { await sendQuestion(cdp, fs.readFileSync(rest[0], 'utf8')); console.log('sent'); }
    else console.error('usage: youzone_cdp.js list|fg|eval <expr>|evalfile <f>|click <sel>|insfile <f>|send <f>');
  } finally { cdp.close(); }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = {
  PORT, TARGET_KW, listTargets, pickTarget, CDP, connect, eval: (c, e) => c.eval(e),
  sendQuestion, openConversation, foreground, sleep, JS_CLICK, JS_INSERT, JS_TEXTAREA, JS_SENDBTN,
};
