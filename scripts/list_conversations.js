// DEPRECATED alias — use discover_coaches.js (--all / --json) instead.
//
// The old implementation read only `li.all-item` (conversations you already
// have), which returns nothing on the 智能体 catalog tab and hides agents you
// have never chatted with. Delegating to coach-discover keeps the command
// working with the correct two-DOM logic.
'use strict';
const cd = require('./coach-discover');

(async () => {
  const items = await cd.coachList();
  console.log(JSON.stringify({ count: items.length, items }, null, 2));
  console.log('\n--- ipa_* (agents/coaches) ---');
  for (const c of items) console.log(c.id, '|', c.title);
})().catch(e => { console.error(e.message); process.exit(1); });
