#!/usr/bin/env node
// Hidden background launcher for the coach toolchain (Windows-first, zero deps).
//
// Why: a coach question takes minutes. Started in the foreground it owns a visible
// console window for that whole time and steals focus (the "总是前台弹cmd" complaint).
// Here the child is spawned DETACHED with windowsHide (CREATE_NO_WINDOW) and its stdio
// goes to logs/, so nothing shows on screen and the caller returns immediately.
//
//   node scripts/bg.js coach_ask_server.js                 # keep channel C up
//   node scripts/bg.js ask_both.js --file q.txt --out ..\proj --tag q2
//   node scripts/bg.js [--name <job>] [--cwd <dir>] <script.js> [args...]
//   node scripts/bg.js --list [--all]
//   node scripts/bg.js --tail <job> [lines]
//   node scripts/bg.js --kill <job|pid>
//
// Files: logs/<job>.pid (+ .out.log / .err.log). Job name = script basename unless --name.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');
const die = m => { console.error(m); process.exit(2); };

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const pidFile = job => path.join(LOGS, job + '.pid');
function readPid(job) {
  try {
    const parts = fs.readFileSync(pidFile(job), 'utf8').trim().split('\n');
    const pid = Number(String(parts[0] || '').trim().split(/\s+/)[0]); // tolerate the old one-line format
    return { job, pid, startedAt: parts[1] || '', cmd: parts.slice(2).join(' '), alive: alive(pid) };
  } catch { return null; }
}
function jobs() {
  if (!fs.existsSync(LOGS)) return [];
  return fs.readdirSync(LOGS).filter(f => f.endsWith('.pid'))
    .map(f => readPid(f.slice(0, -4))).filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
function lastLine(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return (t[t.length - 1] || '').trim().slice(0, 110);
  } catch { return ''; }
}
function resolveScript(spec) {
  const cands = [path.resolve(process.cwd(), spec), path.join(__dirname, spec),
    path.join(ROOT, spec), path.join(ROOT, 'scripts', spec)];
  const hit = cands.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!hit) die('script not found: ' + spec + '\n  tried:\n   - ' + cands.join('\n   - '));
  return hit;
}

const argv = process.argv.slice(2);
const has = n => argv.includes(n);
const val = n => { const i = argv.indexOf(n); return i < 0 ? null : (argv[i + 1] === undefined ? '' : argv[i + 1]); };

if (!argv.length || has('--help') || has('-h')) {
  console.log('usage: node scripts/bg.js [--name <job>] [--cwd <dir>] <script.js> [args...]');
  console.log('       node scripts/bg.js --list [--all] | --tail <job> [lines] | --kill <job|pid>');
  process.exit(0);
}

if (has('--list') || has('--all')) {
  const list = jobs().filter(j => has('--all') || j.alive || !Number.isFinite(j.pid));
  if (!list.length) { console.log('(no background jobs)'); process.exit(0); }
  for (const j of list) {
    console.log((j.alive ? '[running] ' : '[exited ] ') + j.job + '  pid=' + (j.pid || '?') + '  since ' + (j.startedAt || '?'));
    if (j.cmd) console.log('            ' + j.cmd.replace(path.dirname(process.execPath) + ' ', '').slice(0, 140));
    const e = lastLine(path.join(LOGS, j.job + '.err.log'));
    if (e) console.log('            last: ' + e);
  }
  process.exit(0);
}

if (has('--tail')) {
  const job = val('--tail') || die('--tail needs a job name');
  const n = Number(argv[argv.indexOf('--tail') + 2]) || 20;
  let shown = false;
  for (const kind of ['out', 'err']) {
    const f = path.join(LOGS, job + '.' + kind + '.log');
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').trimEnd().split('\n');
    console.log('--- ' + job + '.' + kind + '.log (last ' + n + ') ---');
    console.log(lines.slice(-n).join('\n'));
    shown = true;
  }
  if (!shown) die('no logs for job: ' + job);
  process.exit(0);
}

if (has('--kill')) {
  const target = val('--kill') || die('--kill needs a job name or pid');
  const rec = /^\d+$/.test(target)
    ? (jobs().find(j => j.pid === Number(target)) || { job: null, pid: Number(target) })
    : (readPid(target) || {});
  if (!rec.pid || !alive(rec.pid)) die('not running: ' + target);
  process.kill(rec.pid);
  if (rec.job) try { fs.unlinkSync(pidFile(rec.job)); } catch {}
  console.log('killed ' + (rec.job || '') + ' pid=' + rec.pid);
  process.exit(0);
}

let i = 0, name = null, cwd = null, script = null;
while (i < argv.length) {
  const a = argv[i];
  if (a === '--name') { name = argv[i + 1]; i += 2; continue; }
  if (a === '--cwd') { cwd = argv[i + 1]; i += 2; continue; }
  if (a.startsWith('-')) die('unknown option: ' + a);
  script = a; i += 1; break;
}
const childArgs = argv.slice(i);
if (!script) die('usage: node scripts/bg.js [--name <job>] [--cwd <dir>] <script.js> [args...]');

const scriptPath = resolveScript(script);
const job = name || path.basename(scriptPath).replace(/\.js$/, '');
fs.mkdirSync(LOGS, { recursive: true });
const prev = readPid(job);
if (prev && prev.alive) console.error('note: job "' + job + '" already running (pid=' + prev.pid + '); starting another anyway');

const outFd = fs.openSync(path.join(LOGS, job + '.out.log'), 'a');
const errFd = fs.openSync(path.join(LOGS, job + '.err.log'), 'a');
const child = spawn(process.execPath, [scriptPath].concat(childArgs), {
  cwd: cwd ? path.resolve(cwd) : ROOT,
  detached: true,
  windowsHide: true, // CREATE_NO_WINDOW: no console window is ever created
  stdio: ['ignore', outFd, errFd],
});
child.unref();
const started = new Date().toISOString();
fs.writeFileSync(pidFile(job), [String(child.pid), started, [process.execPath + ' ' + scriptPath].concat(childArgs).join(' ')].join('\n') + '\n');
fs.closeSync(outFd);
fs.closeSync(errFd);
console.log('started job "' + job + '" pid=' + child.pid + ' (detached, hidden, no window) at ' + started);
console.log('  logs : logs/' + job + '.out.log | logs/' + job + '.err.log');
console.log('  watch: node ' + path.relative(ROOT, __filename).replace(/\\/g, '/') + ' --tail ' + job);
console.log('  stop : node ' + path.relative(ROOT, __filename).replace(/\\/g, '/') + ' --kill ' + job);
process.exit(0);
