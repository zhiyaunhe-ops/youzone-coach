#!/usr/bin/env node
// Preflight for the coach toolchain: verifies each prerequisite and reports which
// channel is usable right now. Sends NO question - the WS step only authenticates
// (AUTH frame -> AUTH.KEY code 200).
//
//   node scripts/preflight.js [--no-ws] [--json]
'use strict';
const { dbGlob, memberIdOf, questionSnapshot } = require('./lib');
const { resolveIdentity, getCredentials, tokenFromYonZoneCdp, imFrame, decodeFrame, IM_URL, UA, OP } = require('./coach_headless');
const { wsConnect } = require('./ws_client');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const NO_WS = argv.includes('--no-ws');
// The IM auth check is opt-in: it is a second session, and the server answers it by
// kicking the desktop client (opcode 16640/409), so a plain preflight stays harmless.
const WITH_WS = argv.includes('--ws');
const IDX = argv.indexOf('--identify');
if (IDX >= 0 && argv[IDX + 1]) process.env.YZ_CLIENT_IDENTIFY = argv[IDX + 1];
const log = JSON_OUT ? () => {} : (...a) => console.log(...a);

const report = { node: process.version, checks: [], ok: true };

// Read the live cookie again; used to tell whether our own connection took the
// desktop client offline (reusing its device fingerprint can do that).
async function cdpToken() { try { return await tokenFromYonZoneCdp(() => {}); } catch { return null; } }
function note(text) {
  report.checks.push({ name: text, ok: true, note: true });
  log('  note ' + text);
}
function check(name, ok, detail) {
  report.checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) report.ok = false;
  log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  - ' + detail : ''));
}

async function main() {
  log('node ' + process.version + ' (need >= 22.5 for node:sqlite)');
  check('node >= 22.5', Number(process.versions.node.split('.')[0]) >= 22 && Number(process.versions.node.split('.')[1]) >= 5);

  let dbPath = null;
  try { dbPath = dbGlob(); } catch (e) { check('local message DB', false, e.message); }
  if (dbPath) {
    const snap = questionSnapshot(null, null);
    check('local message DB', true, dbPath + ' (member ' + memberIdOf(dbPath) + ')');
    check('coach question row present', !!(snap && snap.robotBusiness && snap.robotBusiness.yht_access_token),
      snap && snap.robotBusiness
        ? 'newest ' + new Date(snap.ts).toISOString() + ' (age ' + ((Date.now() - snap.ts) / 3600000).toFixed(1) + 'h)'
        : 'none - only CDP credentials are possible');
  }

  // CDP (optional: only needed for the live token and for channels B/C)
  let cdpOk = false, webview = false;
  try {
    const zc = require('./youzone_cdp');
    const targets = await zc.listTargets();
    cdpOk = true;
    webview = targets.some(t => (t.url || '').includes('single-agent'));
    check('YonZone CDP', true, targets.length + ' targets, secretary webview ' + (webview ? 'open' : 'not open'));
  } catch (e) {
    check('YonZone CDP (optional)', false, e.message);
  }

  const id = resolveIdentity({ log: () => {} });
  report.identity = { memberId: id.memberId, peerId: id.peerId, chatId: id.chatId, tenantId: id.tenantId, source: id.source };
  log('identity: member=' + id.memberId + ' peer=' + id.peerId + ' chatId=' + id.chatId + ' source=' + id.source);
  log('clientIdentify: ' + id.identifySource + ' ' + id.imClientIdentify.slice(0, 10) + '...');

  let creds = null;
  try {
    creds = await getCredentials({ id, log: () => {} });
    report.credential = { source: creds.source, expiration: creds.expiration || null };
    check('credentials', true, 'yht from ' + creds.source + ', imToken exp ' + (creds.expiration ? new Date(creds.expiration).toISOString() : 'n/a'));
  } catch (e) {
    check('credentials', false, e.message);
  }

  if (creds && creds.source === 'yonzone-cdp') {
    const still = await cdpToken();
    check('desktop session intact after imToken exchange', !!still,
      still ? 'yht_access_token cookie still present' : 'yht_access_token cookie DISAPPEARED - the imToken exchange looks like a takeover');
  }

  if (creds && WITH_WS && !NO_WS) {
    let conn = null;
    try {
      conn = await wsConnect(IM_URL, { protocols: ['xmpp'], headers: { Origin: 'file://', 'User-Agent': UA } });
      const auth = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('AUTH.KEY timeout (15s)')), 15000);
        conn.onClose = (code, reason) => { clearTimeout(timer); reject(new Error('ws closed ' + code + ' ' + reason)); };
        conn.onMessage = (data) => {
          if (data.length < 13) return;
          const f = decodeFrame(data);
          if (f.opcode === OP.AUTH) { clearTimeout(timer); resolve(JSON.parse(f.payload.toString('utf8') || '{}')); }
        };
        conn.sendBinary(imFrame(OP.AUTH, Buffer.from(JSON.stringify({
          usr: id.memberId + '.esn.upesn', atk: creds.imToken, br: id.imBr,
          appType: id.imAppType, clientIdentify: id.imClientIdentify,
        }), 'utf8')));
      });
      report.im = { code: auth.code, jid: auth.jid || null };
      if (creds.source === 'yonzone-cdp') {
        const still = await cdpToken();
        note(still ? 'desktop cookie still present right after our AUTH'
                   : 'desktop session was taken over by our AUTH (expected for channel D)');
      }
      check('IM websocket auth', auth.code === 200, 'AUTH.KEY code=' + auth.code + ' jid=' + (auth.jid || '?'));
      note('channel D takes the desktop session over by design (server pushes 16640/409); the CDP ask server does not');
    } catch (e) {
      check('IM websocket auth', false, e.message);
    } finally { if (conn) try { conn.close(); } catch {} }
  }

  if (creds && !WITH_WS) note('skipped the IM auth check - add --ws to test it (it will take the desktop client over)');
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else log(report.ok ? '\npreflight OK - coach_headless.js is ready' : '\npreflight FAILED - see the FAIL lines above');
  process.exit(report.ok ? 0 : 1);
}

main().catch(e => { console.error('preflight crashed: ' + e.message); process.exit(1); });
