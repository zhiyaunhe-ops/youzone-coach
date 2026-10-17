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
// Env overrides (when the official name differs on your tenant):
//   COACH_IMPL_ID / COACH_IMPL_TITLE / COACH_DELIVERY_ID / COACH_DELIVERY_TITLE
'use strict';
const cd = require('./coach-discover');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

(async () => {
  const resolveTok = val('--resolve') || (has('--impl') ? 'impl' : has('--delivery') ? 'delivery' : null);

  if (resolveTok) {
    const c = await cd.resolveCoach(resolveTok);
    console.log(JSON.stringify(c, null, 2));
    return;
  }

  const coaches = await cd.coachList();
  const impl = await cd.resolveCoach('impl');
  const delivery = await cd.resolveCoach('delivery');

  if (has('--json')) {
    console.log(JSON.stringify({ count: coaches.length, impl, delivery, coaches }, null, 2));
    return;
  }

  console.log(`发现 ${coaches.length} 个 ipa_ 智能体（来自当前 YonZone 客户端的列表）`);
  console.log(`  impl     -> ${impl.title}\n             ${impl.id}`);
  console.log(`  delivery -> ${delivery.title}\n             ${delivery.id}`);

  if (has('--all')) {
    console.log('\n全部：');
    for (const c of coaches) console.log(`  ${c.id}  ${c.title}`);
  } else {
    const coachLike = coaches.filter(c => /教练/.test(c.title));
    if (coachLike.length) {
      console.log(`\n名字含「教练」的 ${coachLike.length} 个（用 --all 看全部）：`);
      for (const c of coachLike) console.log(`  ${c.id}  ${c.title}`);
    }
    console.log('\n想换成本租户的其它智能体：COACH_IMPL_TITLE / COACH_DELIVERY_TITLE 或 --resolve "<标题片段>"');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
