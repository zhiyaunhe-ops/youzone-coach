// General, account-independent coach discovery for youzone-coach.
//
// Why this file exists: the coach peer IDs / display names are NOT guaranteed
// to be the same on every YonZone login (different tenant, different agent
// registration, renamed agent). Hardcoding two `ipa_` ids in lib.js made the
// skill work only on the machine it was written on.
//
// Discovery reads the LIVE left-hand list, which YonZone renders in one of two
// ways depending on the active tab:
//
//   * 智能体 tab  -> li.agent-item[data-id^="ipa_"]   (the full agent catalog:
//                    hundreds of agents, including ones you have never chatted
//                    with -> this is the path that works on first use)
//   * 全部 tab    -> li.all-item[data-id^="ipa_"]     (conversations you have)
//
// Each row carries the peer id in @data-id and the clean display name in
// `.mid-info[title]` (the `.title` text also contains a trailing "智能体" label,
// so it is only the fallback). Clicking a row opens the conversation; for a
// catalog row that has never been chatted with, the client starts it, which is
// exactly what a first-time user needs.
//
// So: read both lists, dedupe by id, match the coach by its stable display name
// (or an explicit id / title from env), and never depend on list order.
//
// Zero dependencies, Node >= 22.5.
'use strict';
const { listTargets, CDP, foreground, sleep, JS_CLICK } = require('./youzone_cdp');

// Left-pane "智能体" tab. The DOM id starts with "-10", which is NOT a valid CSS
// identifier, so it must be addressed by attribute selector / getElementById.
// It has been stable across the 8.5.x builds we tested; discovery degrades
// gracefully if it is absent (older clients only have the conversation list).
const AGENT_TAB_SEL = '[id="-10_menu"]';

// How long to wait for the list to paint (the client is slow right after boot).
const LIST_WAIT_MS = 12000;
const TAB_WAIT_MS = 1800;

const LIST_JS = `(() => {
  const clean = s => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim()
    .replace(/\\s*智能体$/, '');
  const out = [], seen = new Set();
  const add = (el, from) => {
    const id = el.getAttribute('data-id') || '';
    if (!/^ipa_/i.test(id) || seen.has(id)) return;
    seen.add(id);
    const mid = el.querySelector('.mid-info');
    const p = el.querySelector('.title p') || el.querySelector('.title');
    const title = clean((mid && mid.getAttribute('title')) || (p && p.textContent) || '');
    if (!title) return;
    out.push({ id, title, from, current: el.classList.contains('current') });
  };
  document.querySelectorAll('li.agent-item[data-id]').forEach(el => add(el, 'agents'));
  document.querySelectorAll('li.all-item[data-id]').forEach(el => add(el, 'conversations'));
  return {
    hash: location.hash,
    items: out,
    hasAgentTab: !!document.getElementById('-10_menu'),
    agentTabActive: !!(document.getElementById('-10_menu') &&
      document.getElementById('-10_menu').classList.contains('activeTable')),
  };
})()`;

async function mainPage() {
  const ts = await listTargets();
  const p = ts.find(t => t.type === 'page' && (t.url || '').includes('/main/im'));
  if (!p) throw new Error('main im page not found (is YonZone open?)');
  const c = new CDP(p.webSocketDebuggerUrl);
  await c.connect();
  return c;
}

// Normalize a display name: collapse whitespace and drop the "智能体" label the
// list appends after the agent name (the webview title does NOT carry it).
function normTitle(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().replace(/\s*智能体$/, '');
}

// Read the live list. Waits for it to paint; if there are no ipa_ rows at all it
// (a) routes to the message pane once when the client is on some other module,
// and (b) activates the 智能体 tab once when asked to (or when everything is empty).
// Never navigates away from an already-working conversation.
async function readList({ waitMs = LIST_WAIT_MS, activateAgentTab = false } = {}) {
  await foreground();
  const main = await mainPage();
  const t0 = Date.now();
  let last = null, triedNav = false, triedTab = false;
  try {
    while (Date.now() - t0 <= waitMs) {
      last = await main.eval(LIST_JS);
      const hasRows = last.items.length > 0;
      const tabSettled = !last.hasAgentTab || last.agentTabActive;
      if (hasRows && (!activateAgentTab || tabSettled)) return last.items;

      if (!last.hasAgentTab && !triedNav) {
        // Not on a tabbed message route at all (e.g. 工作台): go to messages once.
        triedNav = true;
        await main.eval('location.hash = "#/main/im/0/0/0"; 1');
        await sleep(2000);
        continue;
      }
      if (!triedTab && last.hasAgentTab && !last.agentTabActive) {
        // Prefer the catalog: it contains agents we have never chatted with.
        triedTab = true;
        try { await main.eval(JS_CLICK(AGENT_TAB_SEL)); } catch {}
        await sleep(TAB_WAIT_MS);
        continue;
      }
      await sleep(1200);
    }
    return last ? last.items : [];
  } finally { main.close(); }
}

// Discover all ipa_* agents visible to this login, deduped by id.
// [{id, title, from: 'agents'|'conversations', current}]
async function discoverCoaches(opts = {}) {
  const items = await readList(opts);
  const seen = new Set();
  return items.filter(it => {
    if (!/^ipa_/i.test(it.id || '') || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  }).map(it => ({ id: it.id, title: normTitle(it.title), from: it.from, current: !!it.current }));
}

async function coachList(opts = {}) { return discoverCoaches(opts); }

// ---- alias resolution ------------------------------------------------------
// Exact-name matches first (order matters: the same tenant can carry both
// "高级版实施总教练（多智能验证版）" and a plain "高级版实施总教练"), then
// keyword heuristics. Env overrides let a deployment pin an unusual name:
//   COACH_IMPL_ID / COACH_IMPL_TITLE / COACH_DELIVERY_ID / COACH_DELIVERY_TITLE
function envOverride(alias) {
  const A = alias.toUpperCase();
  return {
    id: process.env[`COACH_${A}_ID`] || '',
    title: normTitle(process.env[`COACH_${A}_TITLE`] || ''),
  };
}

const ALIAS_RULES = {
  impl: {
    score: t =>
      t === '高级版实施总教练（多智能验证版）' ? 100 :
      t === '高级版实施总教练' ? 95 :
      /^高级版实施总教练/.test(t) ? 90 :
      (/实施/.test(t) && /总教练/.test(t) && !/客开|交付|超级版|旗舰版/.test(t)) ? 60 :
      /实施总教练/.test(t) ? 40 : 0,
  },
  delivery: {
    score: t =>
      t === '交付赋能总教练' ? 100 :
      /^交付赋能总教练/.test(t) ? 95 :
      (/交付赋能|赋能总教练/.test(t)) ? 80 :
      (/^交付.*总教练/.test(t) && !/超级版|旗舰版/.test(t)) ? 50 : 0,
  },
};

function pickBest(coaches, alias) {
  const rule = ALIAS_RULES[alias];
  const ov = envOverride(alias);
  // An explicit override is a PIN: if the pinned id/title is not visible, do NOT
  // silently fall back to a same-keyword agent — that would ask the wrong coach.
  if (ov.id || ov.title) {
    return coaches.find(c =>
      (ov.id && c.id === ov.id) || (ov.title && c.title === ov.title)) || null;
  }
  let best = null, bestScore = 0;
  for (const c of coaches) {
    const s = rule.score(c.title);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return best;
}

function fmtCandidates(coaches) {
  const seen = new Set();
  return coaches
    .filter(c => /教练|助理|智能体|助手/.test(c.title))
    .filter(c => (seen.has(c.title) ? false : (seen.add(c.title), true)))
    .slice(0, 20)
    .map(c => c.title + ' (' + c.id + ')')
    .join(', ');
}

// Pure resolver against an already-fetched list: {id,title} or null.
// Exported so callers that already have the list (discover CLI, batched tools)
// don't re-read the client once per alias.
function resolveFrom(list, token) {
  const key = String(token == null ? '' : token).trim();
  const lower = key.toLowerCase();
  const alias = (!key || ['impl', 'implementation', 'coach'].includes(lower)) ? 'impl'
    : (['delivery', 'empower'].includes(lower) ? 'delivery' : null);
  if (!list.length) return null;
  if (alias) {
    const best = pickBest(list, alias);
    if (best) return best;
  }
  if (!key) return pickBest(list, 'impl');
  if (lower.startsWith('ipa_')) {
    return list.find(c => c.id.toLowerCase() === lower) || null;
  }
  const want = normTitle(key);
  return list.find(c => normTitle(c.title) === want)
    || list.find(c => normTitle(c.title).includes(want))
    || null;
}

// Resolve a coach to {id, title} from the live list.
//   null / "impl" / "implementation" / "coach" -> implementation coach
//   "delivery" / "empower"                       -> delivery coach
//   "ipa_..."                                    -> exact id
//   anything else                                -> exact title, then substring
// If the active tab has no coach, it retries once on the 智能体 catalog tab.
async function resolveCoach(token, { waitMs } = {}) {
  const key = String(token == null ? '' : token).trim();
  let coaches = await discoverCoaches({ waitMs });
  let hit = resolveFrom(coaches, key);

  if (!hit) {
    // Maybe the client was on the 全部 tab (conversations only): try the catalog.
    const catalog = await discoverCoaches({ waitMs, activateAgentTab: true });
    if (catalog.length !== coaches.length || catalog.some((c, i) => !coaches[i] || c.id !== coaches[i].id)) {
      coaches = catalog;
      hit = resolveFrom(coaches, key);
    }
  }
  if (hit) return hit;

  if (!coaches.length) throw new Error('no ipa_ agents found in the live YonZone list ' +
    '(is YonZone open and the message list loaded? try: node scripts/discover_coaches.js)');
  throw new Error('no coach matching "' + key + '" among ' + (fmtCandidates(coaches) || coaches.length + ' agents') +
    ' — set COACH_IMPL_TITLE / COACH_DELIVERY_TITLE to pin an unusual name');
}

module.exports = {
  discoverCoaches, resolveCoach, resolveFrom, coachList, readList, normTitle, AGENT_TAB_SEL,
};
