#!/usr/bin/env node
// Copy SSO cookies (diwork.com / yonyoucloud.com CAS family) from the YonZone
// embedded browser (CDP :8089) into desktop Chrome (CDP :9222) so that
// ikm.yonyou.com CAS auto-login works without typing credentials.
//   node cas_sso_transfer.js [--dry]
'use strict';
const zc = require('./youzone_cdp');

const SRC = Number(process.env.YZ_PORT || 8089);
const DST = Number(process.env.CHROME_PORT || 9222);
const DRY = process.argv.includes('--dry');
const DOMAINS = /(^|\.)diwork\.com$|(^|\.)yonyoucloud\.com$/;

async function withCDP(port, urlRegex, fn) {
  const orig = process.env.YOUZONE_CDP_PORT;
  process.env.YOUZONE_CDP_PORT = String(port);
  try {
    const targets = await zc.listTargets();
    const t = targets.find(x => x.webSocketDebuggerUrl && x.type === 'page' && (!urlRegex || urlRegex.test(x.url)))
      || targets.find(x => x.webSocketDebuggerUrl && x.type === 'page');
    if (!t) throw new Error('no page target on port ' + port);
    const cdp = new zc.CDP(t.webSocketDebuggerUrl);
    await cdp.connect();
    try { return await fn(cdp); } finally { cdp.close(); }
  } finally { if (orig === undefined) delete process.env.YOUZONE_CDP_PORT; else process.env.YOUZONE_CDP_PORT = orig; }
}

(async () => {
  const cookies = await withCDP(SRC, null, async cdp => {
    await cdp.send('Network.enable');
    const all = await cdp.send('Network.getAllCookies', {});
    return all.cookies.filter(c => DOMAINS.test(c.domain));
  });
  console.log(`source cookies: ${cookies.length}`);
  const seen = new Set();
  for (const c of cookies) {
    const k = c.domain + '|' + c.name + '|' + c.path;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${c.domain} ${c.name}${c.name === 'yht_access_token' ? ' (value len ' + String(c.value).length + ')' : ''}`);
  }
  if (DRY) return;

  const res = await withCDP(DST, null, async cdp => {
    await cdp.send('Network.enable');
    let ok = 0, fail = 0;
    for (const c of cookies) {
      const k = c.domain + '|' + c.name + '|' + c.path;
      if (seen.has(k) === false) continue;
      try {
        const r = await cdp.send('Network.setCookie', {
          name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
          secure: !!c.secure, httpOnly: !!c.httpOnly,
          sameSite: c.sameSite === 'no_restriction' ? 'no_restriction' : c.sameSite === 'lax' ? 'lax' : undefined,
        });
        r.success ? ok++ : fail++;
      } catch { fail++; }
    }
    return { ok, fail };
  });
  console.log(`written into Chrome: ok=${res.ok} fail=${res.fail}`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
