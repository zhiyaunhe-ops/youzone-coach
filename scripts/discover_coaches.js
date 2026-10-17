#!/usr/bin/env node
// Discover the coach agents from the LIVE YonZone client (no hardcoded ids).
//
// Use this on a fresh machine / different account, or after the client shows a
// different set of agents. It reads the left-hand list (智能体 catalog first,
// conversation list as fallback) so it also sees coaches you have NEVER chatted
// with — clicking such a row starts the conversation, which is what lets
// coach_ask_server.js work on first use.
//
//   node scripts/discover_coaches.js               # count + resolved impl/delivery
//   node scripts/discover_coaches.js --all         # every ipa_ agent {id,title}
//   node scripts/discover_coaches.js --json        # machine-readable
//   node scripts/discover_coaches.js --resolve delivery
//   node scripts/discover_coaches.js --resolve "某个教练名字的一部分"
//
// Exit codes: 0 = list read (aliases may still be marked unresolved), 1 = the
// live list could not be read at all, 2 = default check found only part of the
// two coaches (see the printed hint / env overrides).
//
// Env overrides (when the official name differs on your tenant):
//   COACH_IMPL_ID / COACH_IMPL_TITLE / COACH_DELIVERY_ID / COACH_DELIVERY_TITLE
'use strict';
const cd = require('./coach-discover');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

function line(label, c) {
  if (c) return `  ${label.padEnd(8)} -> ${c.title}\n             ${c.id}`;
  return `  ${label.padEnd(8)} -> 未解析到（设 COACH_${label.toUpperCase()}_TITLE，` +
    '或确认该智能体在当前租户的「智能体」目录里）';
}

(async () => {
  const resolveTok = val('--resolve') || (has('--impl') ? 'impl' : has('--delivery') ? 'delivery' : null);

  if (resolveTok) {
    const c = await cd.resolveCoach(resolveTok);
    console.log(JSON.stringify(c, null, 2));
    return;
  }

  // One catalog read, resolve both aliases from it (no per-alias re-read).
  let coaches = await cd.coachList();
  let impl = cd.resolveFrom(coaches, 'impl');
  let delivery = cd.resolveFrom(coaches, 'delivery');
  if (!impl || !delivery) {
    // The client may be on the 全部 tab (conversations only); the 智能体 catalog
    // lists every authorized agent, including ones never chatted with.
    const catalog = await cd.discoverCoaches({ activateAgentTab: true });
    if (catalog.length) {
      coaches = catalog;
      impl = cd.resolveFrom(coaches, 'impl');
      delivery = cd.resolveFrom(coaches, 'delivery');
    }
  }

  if (has('--json')) {
    console.log(JSON.stringify({ count: coaches.length, impl, delivery, coaches }, null, 2));
    return;
  }

  console.log(`发现 ${coaches.length} 个 ipa_ 智能体（来自当前 YonZone 客户端的列表）`);
  console.log(line('impl', impl));
  console.log(line('delivery', delivery));

  if (has('--all')) {
    console.log('\n全部：');
    for (const c of coaches) console.log(`  ${c.id}  ${c.title}`);
    return;
  }

  const coachLike = coaches.filter(c => /教练/.test(c.title));
  if (coachLike.length) {
    console.log(`\n名字含「教练」的 ${coachLike.length} 个（用 --all 看全部）：`);
    for (const c of coachLike) console.log(`  ${c.id}  ${c.title}`);
  }
  console.log('\n想换成本租户的其它智能体：COACH_IMPL_TITLE / COACH_DELIVERY_TITLE，或 --resolve "<标题片段>"');
  if (!impl || !delivery) process.exitCode = 2;
})().catch(e => { console.error(e.message); process.exit(1); });
