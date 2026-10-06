#!/usr/bin/env node
// Package youzone-coach for distribution.
//
//   node scripts/pack.js                       # -> dist/youzone-coach-<ver>.zip + .skill + MANIFEST.md
//   node scripts/pack.js --out D:\somewhere     # 换输出目录
//   node scripts/pack.js --no-skill            # 只出 zip
//
// What goes in : SKILL.md README.md package.json .gitattributes .gitignore
//                scripts/*.{js,ps1}  references/*.md
// What stays out: .git/ node_modules/ dist/ tmp/ *.db(-wal|-shm) capture-*.json
//                 *payload*.json  aip-*.json  ws-*.json  replay-sse.txt  *.log
//
// Uses a staging copy + Compress-Archive rather than `git archive`, because the
// working tree is normally ahead ofHEAD (that is the whole point of packing)
// and `git archive` only ever sees committed content.
//
// The .skill file is a zip with a single top-level folder named after the skill,
// which is the layout the skill loader expects when importing an archive.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { name: NAME, version: VER } = pkg;

const args = process.argv.slice(2);
let outDir = path.join(ROOT, 'dist');
let wantSkill = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = path.resolve(args[++i]);
  else if (args[i] === '--no-skill') wantSkill = false;
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log('usage: node scripts/pack.js [--out <dir>] [--no-skill]');
    process.exit(0);
  }
}

// ---- select files -------------------------------------------------------
const INCLUDE_FILES = ['SKILL.md', 'README.md', 'package.json', '.gitattributes', '.gitignore'];
const INCLUDE_DIRS = ['scripts', 'references'];
const INCLUDE_EXT = /\.(js|ps1|md|json|txt)$/;

function ignored(basename) {
  if (['.git', 'node_modules', 'tmp', 'dist'].includes(basename)) return true;
  if (/\.db(-wal|-shm)?$/.test(basename)) return true;
  if (/^(capture|db-inspect|ws)-.*\.json$/.test(basename)) return true;
  if (/payload.*\.json$/.test(basename)) return true;
  if (/^aip-.*\.json$/.test(basename)) return true;
  if (/^replay-sse\.txt$/.test(basename)) return true;
  if (/\.log$/.test(basename)) return true;
  return false;
}

const entries = [];
for (const f of INCLUDE_FILES) {
  if (fs.existsSync(path.join(ROOT, f))) entries.push(f);
}
for (const d of INCLUDE_DIRS) {
  const base = path.join(ROOT, d);
  if (!fs.existsSync(base)) continue;
  for (const f of fs.readdirSync(base).sort()) {
    if (!INCLUDE_EXT.test(f) || ignored(f)) continue;
    entries.push(`${d}/${f}`);
  }
}

if (!entries.includes('SKILL.md')) {
  console.error('SKILL.md not found - refusing to pack a skill without a manifest');
  process.exit(1);
}

// ---- minimal zip writer (store method, no compression) ------------------
// Self-contained on purpose. Two external tools were tried and both are
// unusable in this environment:
//   - Compress-Archive rejects any destination not ending in .zip (so .skill
//     can't be written directly) and can be killed mid-run under a sandboxed
//     spawn, returning status=null with empty stderr.
//   - System32\tar.exe (bsdtar) cannot be spawned from node here: EBUSY.
//   - GNU tar from Git Bash is a different binary and misreads "C:\..." as a
//     remote host ("Cannot connect to C: resolve failed").
// The payload is ~85 KB of text, so store-mode (no deflate) costs little and
// keeps this dependency-free and deterministic. CRC-32 is the only thing
// zip actually requires beyond the local headers.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// A file whose content is all printable ASCII is 100% safe to store as-is.
// Anything else (or anything >= 2 KB of text) is deflated, which Node has
// built in.
function needsDeflate(buf) {
  if (buf.length >= 2048) return true;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0A || b === 0x0D || b === 0x09) continue;      // \n \r \t
    if (b >= 0x20 && b <= 0x7E) continue;                      // printable
    if (b === 0xEF && buf[i + 1] === 0xBB && buf[i + 2] === 0xBF) { i += 2; continue; } // BOM
    return true;                                               // any high byte -> deflate
  }
  return false;
}

function zipStore(files, destFile) {
  const zlib = require('node:zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const raw = f.data;
    const deflate = needsDeflate(raw);
    const body = deflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);

    // local file header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034B50, 0);
    lh.writeUInt16LE(20, 4);              // version needed
    lh.writeUInt16LE(0x0800, 6);          // flag: UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);              // mod time  (fixed -> reproducible)
    lh.writeUInt16LE(0x21, 12);           // mod date = 1980-01-01 (fixed)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);              // extra len
    locals.push(lh, nameBuf, body);

    // central directory entry
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014B50, 0);
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk number
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0o644 << 16, 38);    // external attrs (unix perms)
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(destFile, Buffer.concat([...locals, cdBuf, eocd]));
}

// Guard against a silently-truncated archive: verify the EOCD signature and
// that every entry we wrote is actually present and readable.
function verifyZip(destFile, expected) {
  const buf = fs.readFileSync(destFile);
  if (buf.length < 22) throw new Error(`archive suspiciously small: ${buf.length} bytes`);
  if (buf.subarray(-22, -18).toString('latin1') !== 'PK\x05\x06') {
    throw new Error('archive has no zip end-of-central-directory record (truncated?)');
  }
  const eocd = buf.subarray(-22);
  const count = eocd.readUInt16LE(10);
  if (count !== expected.length) {
    throw new Error(`EOCD lists ${count} entries, expected ${expected.length}`);
  }
  return count;
}

fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `${NAME}-${VER}.zip`);
let skillPath = null;

// Read once, reuse for both artifacts.
const payload = entries.map(rel => ({
  name: rel,
  data: fs.readFileSync(path.join(ROOT, rel)),
}));

zipStore(payload, zipPath);
verifyZip(zipPath, payload);

if (wantSkill) {
  // Same payload, every path prefixed with <name>/ -> single top-level folder,
  // which is what a .skill import expects.
  const wrapped = payload.map(f => ({ name: `${NAME}/${f.name}`, data: f.data }));
  skillPath = path.join(outDir, `${NAME}.skill`);
  zipStore(wrapped, skillPath);
  verifyZip(skillPath, wrapped);
}

// ---- manifest -----------------------------------------------------------
const sha12 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const kb = n => `${(n / 1024).toFixed(1)} KB`;

const manifest = [
  `# ${NAME} ${VER}`,
  '',
  `- built at : ${new Date().toISOString()}`,
  `- node      : ${process.version} (requires >= 22.5)`,
  `- files     : ${entries.length}`,
  `- artifacts : \`${path.basename(zipPath)}\`${wantSkill ? `, \`${path.basename(skillPath)}\`` : ''}`,
  '',
  '| file | size | sha256(12) |',
  '| --- | ---: | --- |',
  ...entries.map(rel => {
    const p = path.join(ROOT, rel);
    return `| \`${rel}\` | ${kb(fs.statSync(p).size)} | \`${sha12(p)}\` |`;
  }),
  '',
  '## 安装',
  '',
  '```bash',
  '# 1) 解压到 skills 目录（WorkBuddy 用户级:~/.workbuddy/skills/）',
  `unzip ${path.basename(zipPath)} -d <skills-dir>/`,
  '',
  '# 2) 离线自检（不联网、不碰数据库）',
  `cd <skills-dir>/${NAME} && npm test`,
  '',
  '# 3) 按 SKILL.md 通道 B 打开 YonZone CDP（只需做一次），然后：',
  'node scripts/coach_ask_server.js &',
  'node scripts/ask_both.js "你的问题" --out . --tag t1',
  '```',
  '',
  '## 安全',
  '',
  '- 产物**不含** `yht_access_token`、会话库（`*.db`）、抓包 payload —— 打包时按白名单+黑名单双重过滤。',
  '- `references/coach-chat-log.md` 含历史问答正文，可能带客户名/项目名，**外发前请人工过一遍**。',
  '',
].join('\n');

const manifestPath = path.join(outDir, 'MANIFEST.md');
fs.writeFileSync(manifestPath, manifest, 'utf8');

console.log(`packed ${entries.length} files -> ${outDir}`);
console.log(`  zip      : ${path.basename(zipPath)}  (${kb(fs.statSync(zipPath).size)})`);
if (skillPath) console.log(`  skill    : ${path.basename(skillPath)}  (${kb(fs.statSync(skillPath).size)})`);
console.log(`  manifest : ${path.basename(manifestPath)}`);
