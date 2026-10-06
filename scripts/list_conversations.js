// Enumerate the YonZone conversation list (left pane) on the main renderer page and
// print data-id + display title, so ipa_* peer ids can be matched to coach names.
'use strict';
const { listTargets, CDP } = require('./youzone_cdp');

const JS_LIST = `(() => {
  const out = [];
  document.querySelectorAll('li.all-item').forEach(el => {
    const id = el.getAttribute('data-id') || '';
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (id) out.push({ id, title: t.slice(0, 80) });
  });
  return { hash: location.hash, count: out.length, items: out };
})()`;

async function main() {
  const targets = await listTargets();
  const page = targets.find(t => t.type === 'page' && /\/main\/im/.test(t.url));
  if (!page) throw new Error('main im page not found; targets=' + targets.map(t => t.type + ':' + t.title).join(' | '));
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    let r = await cdp.eval(JS_LIST);
    if (!r || !r.count) {
      // list not mounted on this route: go back to the IM root and re-read
      await cdp.eval(`location.hash = '#/main/im'; 1`);
      await new Promise(s => setTimeout(s, 1500));
      r = await cdp.eval(JS_LIST);
    }
    console.log(JSON.stringify(r, null, 2));
    const coaches = (r.items || []).filter(i => i.id.startsWith('ipa_'));
    console.log('\n--- ipa_* (agents/coaches) ---');
    for (const c of coaches) console.log(c.id, '|', c.title);
  } finally { cdp.close(); }
}

main().catch(e => { console.error(e.message); process.exit(1); });
