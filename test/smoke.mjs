// nine-balance-widget smoke test: stub the SDK import, then verify
// ① nine-provider template completeness & structure ② executor pure functions & three-tier fetching (mock fetch) ③ registration structure
// usage: node test/smoke.mjs   (run python build.py first)
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'

const rootDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))
const pluginPath = path.join(rootDir, '..', 'plugin.js')
let src = fs.readFileSync(pluginPath, 'utf8')

// —— stub SDK / react imports (string search, no regex: the specifier contains a bare /)——
function replaceOnce(hay, startNeedle, endNeedle, replacement) {
  const s = hay.indexOf(startNeedle)
  if (s < 0) throw new Error('start needle missing: ' + startNeedle.slice(0, 60))
  const e = hay.indexOf(endNeedle, s)
  if (e < 0) throw new Error('end needle missing: ' + endNeedle.slice(0, 60))
  return hay.slice(0, s) + replacement + hay.slice(e + endNeedle.length)
}

src = replaceOnce(src, 'import {', "} from '@hermes/plugin-sdk'",
  `const host = { notify() {}, navigate() {}, request() { return Promise.resolve(null) } }
const haptic = () => {}
const ROUTES_AREA = 'routes'
const SIDEBAR_NAV_AREA = 'sidebar.nav'
const PALETTE_AREA = 'palette'
const Input = 'Input', Button = 'Button', ToggleRow = 'ToggleRow'`)
src = src.replace("import { jsx, jsxs } from 'react/jsx-runtime'", 'const jsx = () => null, jsxs = () => null')
src = src.replace("import { useState } from 'react'", 'const useState = (init) => [typeof init === "function" ? init() : init, () => {}]')

if (src.includes("from '@hermes/plugin-sdk'")) throw new Error('SDK import not stubbed')
if (src.includes("from 'react")) throw new Error('react import not stubbed')

// each source module exports on its own; no extra exports needed

// browser global stub (no DOM operations at module top level)
globalThis.window = { sessionStorage: { getItem: () => null, setItem: () => {} },
                      localStorage: { getItem: () => null, setItem: () => {} } }

const tmp = path.join(rootDir, '..', '__smoke_mod.mjs')
fs.writeFileSync(tmp, src, 'utf8')
try {
  const mod = await import('file:///' + tmp.replace(/\\/g, '/'))

  /* ── ① Nine-provider templates (multi-source: subscription and pay-as-you-go as separate rows)─────────────────────── */
  const expected = ['deepseek', 'minimax', 'glm', 'kimi', 'mimo', 'chatgpt', 'claude', 'gemini', 'grok']
  assert.deepEqual(Object.keys(mod.PROVIDERS).sort(), [...expected].sort(), '9 provider ids')
  assert.deepEqual(mod.PROVIDER_ORDER, expected, 'display order')
  const allSources = []
  for (const id of expected) {
    const p = mod.PROVIDERS[id]
    assert.ok(p.name && Array.isArray(p.sources) && p.sources.length >= 1, id + ' has sources[]')
    const sids = p.sources.map((s) => s.id)
    assert.equal(new Set(sids).size, sids.length, id + ' source ids unique')
    for (const s of p.sources) {
      assert.ok(s.id && s.label && s.keyRef, id + '/' + s.id + ' basic fields')
      assert.ok(['balance', 'quota', 'probe'].includes(s.kind), id + '/' + s.id + ' kind')
      assert.ok(s.currency === 'CNY' || s.currency === 'USD', id + '/' + s.id + ' currency')
      if (s.kind === 'balance') assert.ok(s.balance && s.balance.url.startsWith('https://'), id + '/' + s.id + ' balance url')
      if (s.kind === 'quota') assert.ok(s.quota && s.quota.url.startsWith('https://'), id + '/' + s.id + ' quota url')
      if (s.kind === 'probe') assert.ok(s.probeUrl && s.probeUrl.startsWith('https://'), id + '/' + s.id + ' probe url')
      allSources.push({ pid: id, ...s })
    }
  }
  // tier distribution (13 sources): 3 pay-as-you-go + 5 subscription + 5 probe
  const tiers = allSources.map((s) => mod.sourceTier(s)).sort()
  assert.deepEqual(tiers,
    ['balance', 'balance', 'balance',
     'quota', 'quota', 'quota', 'quota', 'quota',
     'probe', 'probe', 'probe', 'probe', 'probe'].sort(),
    'tier distribution 3/5/5 across 13 sources')
  // subscription and pay-as-you-go must stay separate: kimi has both balance and quota sources
  const kimi = mod.PROVIDERS.kimi
  assert.ok(kimi.sources.some((s) => s.kind === 'balance'), 'kimi has payg source')
  assert.ok(kimi.sources.some((s) => s.kind === 'quota'), 'kimi has subscription source')
  assert.equal(kimi.sources.length, 3, 'kimi 3 sources (payg CN / coding / payg intl)')
  // international site is its own source (separate key)
  assert.equal(mod.PROVIDERS.minimax.sources.length, 2, 'minimax CN + intl')
  assert.equal(mod.PROVIDERS.glm.sources.length, 2, 'glm CN + intl')
  // key live endpoint URLs must not be wrong
  assert.equal(mod.PROVIDERS.deepseek.sources[0].balance.url, 'https://api.deepseek.com/user/balance')
  assert.equal(mod.PROVIDERS.minimax.sources[0].quota.url, 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains')
  assert.equal(mod.PROVIDERS.minimax.sources[1].quota.url, 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains')
  assert.equal(mod.PROVIDERS.kimi.sources[1].quota.url, 'https://api.kimi.com/coding/v1/usages')
  assert.equal(mod.PROVIDERS.kimi.sources[2].balance.url, 'https://api.moonshot.ai/v1/users/me/balance')
  assert.equal(mod.PROVIDERS.glm.sources[1].quota.url, 'https://api.z.ai/api/monitor/usage/quota/limit')
  assert.equal(mod.PROVIDERS.mimo.sources[0].probeUrl, 'https://token-plan-cn.xiaomimimo.com/v1/models')
  // Claude probe dual headers (x-api-key + anthropic-version)
  assert.deepEqual(mod.PROVIDERS.claude.sources[0].headers,
    { 'x-api-key': '{key}', 'anthropic-version': '2023-06-01' }, 'claude probe dual headers')
  // storage key convention: the first source keeps key.<pid> (zero migration for old configs), the rest carry the source id; obs keys follow the same shape
  assert.equal(mod.srcKey('kimi', 0, 'payg_cn'), 'key.kimi', 'idx0 keeps legacy key')
  assert.equal(mod.srcKey('kimi', 1, 'coding'), 'key.kimi.coding', 'idx>0 suffix')
  assert.equal(mod.obsKey('kimi', 0, 'payg_cn'), 'obs.kimi', 'obs idx0 legacy')
  assert.equal(mod.obsKey('kimi', 2, 'payg_intl'), 'obs.kimi.payg_intl', 'obs idx>0 suffix')

  /* ── ② Executor pure functions ─────────────────────────────────────────────────── */
  const sample = { data: { available_balance: 42.5, limits: [
    { type: 'TIME_LIMIT', unit: 0, percentage: 9 },
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 63.2, nextResetTime: 1791476218840 },
    { type: 'TOKENS_LIMIT', unit: 6, percentage: 12.8 },
  ] }, arr: [{ deep: { v: 7 } }] }
  assert.equal(mod.jsonPath(sample, 'data.available_balance'), 42.5, 'dot path')
  assert.equal(mod.jsonPath(sample, 'arr[0].deep.v'), 7, 'index path')
  assert.equal(mod.jsonPath(sample, 'nope.nope'), undefined, 'missing → undefined')
  assert.deepEqual(mod.buildHeaders('Bearer {key}', 'sk-test'), { Authorization: 'Bearer sk-test' }, 'bearer tpl')
  assert.deepEqual(mod.buildHeaders('{key}', 'rawkey'), { Authorization: 'rawkey' }, 'bare tpl (zhipu style)')
  assert.deepEqual(mod.buildHeaders('', 'k'), {}, 'empty auth → {}')
  // headers table (Claude probe dual headers): the {key} placeholder in values is substituted
  assert.deepEqual(mod.buildHeaders(undefined, 'sk-ant-x', { 'x-api-key': '{key}', 'anthropic-version': '2023-06-01' }),
    { 'x-api-key': 'sk-ant-x', 'anthropic-version': '2023-06-01' }, 'extra headers tpl')

  /* ── ③ Three-tier fetch (mock fetch, per source)──────────────────────────────────── */
  const mock = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body })
  const sr = (pid, i) => mod.PROVIDERS[pid].sources[i || 0]

  // balance: deepseek pay-as-you-go true balance
  const r1 = await mod.fetchBalance(sr('deepseek'), 'k', mock({
    balance_infos: [{ total_balance: 12.3456 }],
  }))
  assert.ok(r1.ok && r1.remaining === 12.3456 && r1.currency === 'CNY', 'deepseek balance parse')

  // quota: minimax simple fields
  const r2 = await mod.fetchQuota(sr('minimax'), 'k', mock({
    model_remains: [{ current_interval_remaining_percent: 87.5,
                      current_weekly_remaining_percent: 40.2, end_time: 1791476218840 }],
  }))
  assert.ok(r2.ok && r2.windows.length === 2, 'minimax two windows')
  assert.equal(r2.windows[0].percent, 87.5, 'interval pct')
  assert.equal(r2.windows[1].label, 'Week', 'weekly label')

  // quota: zhipu windows + pick (list/types/unit filtering)
  const r3 = await mod.fetchQuota(sr('glm'), 'k', mock(sample))
  assert.ok(r3.ok && r3.windows.length === 2, 'zhipu picked windows')
  assert.equal(r3.windows[0].percent, 63.2, 'unit=3 picked (not [0])')
  assert.equal(r3.windows[1].percent, 12.8, 'unit=6 weekly')
  assert.equal(r3.windows[0].resetAt, 1791476218840, 'resetAt passthrough')

  // quota: Kimi Coding subscription (usage.remaining/limit → percentage window)
  const rkc = await mod.fetchQuota(sr('kimi', 1), 'k', mock({
    usage: { remaining: 63, limit: 100, resetTime: 1791476218840 },
  }))
  assert.ok(rkc.ok && rkc.windows.length === 1, 'kimi coding window')
  assert.equal(rkc.windows[0].percent, 63, 'kimi coding pct = remain/total*100')
  assert.equal(rkc.windows[0].resetAt, 1791476218840, 'kimi coding resetAt')

  // probe: openai probe 401 → not ok
  const r4 = await mod.probe(sr('chatgpt'), 'bad', mock({}, false, 401))
  assert.equal(r4.ok, false, 'probe 401 → fail')
  const r5 = await mod.probe(sr('gemini'), 'k', mock({}, true, 200))
  assert.equal(r5.ok, true, 'gemini ?key= probe ok')

  // claude probe: headers must carry both x-api-key and anthropic-version
  let seenHeaders = null
  await mod.probe(sr('claude'), 'sk-ant-1', async (u, init) => { seenHeaders = init.headers; return { ok: true, status: 200 } })
  assert.equal(seenHeaders['x-api-key'], 'sk-ant-1', 'claude x-api-key header')
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01', 'claude version header')
  assert.ok(!seenHeaders.Authorization, 'claude probe no Authorization')

  // fetchBalance on a non-balance source → unsupported (no request is fired)
  let fetched = false
  const r6 = await mod.fetchBalance(sr('claude'), 'k', async () => { fetched = true; return mock({})() })
  assert.equal(r6.unsupported, true, 'probe source → balance unsupported')
  assert.equal(fetched, false, 'no request fired for wrong kind')

  // fetchSource dispatches by kind + probeOnly flag
  const r7 = await mod.fetchSource(sr('kimi'), 'k', mock({ data: { available_balance: 3.14 } }))
  assert.ok(r7.ok && r7.remaining === 3.14, 'fetchSource(balance) → balance tier')
  const r8 = await mod.fetchSource(sr('grok'), 'k', mock({}, true, 200))
  assert.ok(r8.probeOnly && r8.ok, 'fetchSource(probe) → probe tier')

  // fetchAll: fetches each source in turn, sources without a key are marked unconfigured, order matches sources
  const seen = []
  const ra = await mod.fetchAll(mod.PROVIDERS.kimi, (s, i) => {
    seen.push(s.id)
    return i === 0 ? 'k1' : (i === 1 ? '' : 'k3')   // 2nd source (Kimi Coding) left unconfigured
  }, mock({ data: { available_balance: 7.77 } }))
  assert.deepEqual(seen, ['payg_cn', 'coding', 'payg_intl'], 'fetchAll visits in order')
  assert.equal(ra.length, 3, 'fetchAll 3 entries')
  assert.ok(ra[0].result.ok && ra[0].result.remaining === 7.77, 'src0 fetched')
  assert.equal(ra[1].result.unconfigured, true, 'src1 unconfigured (empty key)')
  assert.ok(ra[2].result.ok, 'src2 fetched (payg intl balance parse)')

  /* ── ④ Mascot asset table ───────────────────────────────────────────────────── */
  assert.equal(Object.keys(mod.MASCOTS).length, 9, 'nine mascots embedded')
  for (const id of expected) {
    const uri = mod.MASCOTS[id]
    assert.ok(typeof uri === 'string' && uri.startsWith('data:image/webp;base64,'), id + ' data uri')
    assert.ok(uri.length > 5000 && uri.length < 120000, id + ' size sane: ' + uri.length)
  }

  /* ── ⑤ Phase 2.5 widget popup/sound/alert static assertions ───────────────────────────── */
  for (const needle of [
    'hbw-p-big',                    // popup structure
    '--theme-background-seed',      // day/night theme detection source
    'data-theme',                   // glass dual-mode switch
    'cubic-bezier(.34,1.56,.64,1)', // springy rebound curve
    'AudioContext',                 // WebAudio sound
    'observeDrop',                  // used-today observation
    'focusedUsage',                 // per-turn cost / usage subscription
    'alertThreshold',               // balance alert threshold
    'PHRASES',                      // random phrase lines
    'Widget size',                    // size control
    '--hbw-s',                      // CSS variable scaling (1:1 coordinates, no drift)
    'setScale',                     // scale in place (visual center stays put)
    'data-side',                    // comic bubble direction
    '--hbw-tail-x',                 // bubble tail points at the mascot
    'positionPop',                  // measure height after render (empty shell must not be pushed off-screen)
    'hbw-pop-in',                   // popup entrance animation
  ]) {
    assert.ok(src.includes(needle), 'phase2.5 presence: ' + needle)
  }

  /* ── ⑤b model-driven mascot switch + per-mascot phrase pools + 200% size baseline ───────────────────── */
  // keyword match (case-insensitive; slug looks like provider/model)
  assert.equal(mod.pidFromModel('DeepSeek/DeepSeek-V4-Flash'), 'deepseek', 'upper slug → deepseek')
  assert.equal(mod.pidFromModel('deepseek/deepseek-v4-flash'), 'deepseek', 'lower slug → deepseek')
  assert.equal(mod.pidFromModel('XIAOMI/MIMO-V2.6-PRO'), 'mimo', 'XIAOMI/MIMO mixed upper → mimo')
  assert.equal(mod.pidFromModel('xiaomi/mimo-v2.6-flash'), 'mimo', 'xiaomi → mimo')
  assert.equal(mod.pidFromModel('MiniMax/minimax-m2.5'), 'minimax', 'MiniMax → minimax')
  assert.equal(mod.pidFromModel('anthropic/claude-sonnet-4.5'), 'claude', 'anthropic → claude')
  assert.equal(mod.pidFromModel('x-ai/grok-4'), 'grok', 'x-ai → grok')
  assert.equal(mod.pidFromModel('zhipu/glm-4.7'), 'glm', 'zhipu → glm')
  assert.equal(mod.pidFromModel('moonshotai/kimi-k2'), 'kimi', 'moonshot → kimi')
  assert.equal(mod.pidFromModel('google/gemini-3.1-pro'), 'gemini', 'gemini hit')
  assert.equal(mod.pidFromModel('openai/gpt-5.2'), 'chatgpt', 'openai/gpt → chatgpt')
  assert.equal(mod.pidFromModel('qwen/qwen3-max'), null, 'unknown slug → null (falls back to mainPid)')
  assert.equal(mod.pidFromModel(''), null, 'empty → null')
  assert.equal(mod.pidFromModel(null), null, 'null → null')
  // every mascot has >=5 lines
  assert.equal(Object.keys(mod.PHRASES_BY_PID).length, 9, 'nine phrase pools')
  for (const id of expected) {
    const pool = mod.PHRASES_BY_PID[id]
    assert.ok(Array.isArray(pool) && pool.length >= 5, id + ' phrases >= 5 (got ' + (pool && pool.length) + ')')
    for (const s of pool) assert.ok(typeof s === 'string' && s.trim().length > 0, id + ' phrase non-empty')
  }
  // user-named samples present verbatim (the deepseek line was split in two with the user's OK)
  assert.ok(mod.PHRASES_BY_PID.claude.includes('New IP? That’s a ban, not a bug.'), 'claude sample verbatim')
  assert.ok(mod.PHRASES_BY_PID.deepseek.includes('I beat the top models at chess by ignoring the rules.')
    && mod.PHRASES_BY_PID.deepseek.includes('Pawn takes queen. That really happened.'),
    'deepseek sample verbatim (chess pair)')
  assert.ok(mod.PHRASES_BY_PID.minimax.includes('What’s your question for teacher M?'), 'minimax sample verbatim')
  // 200% size baseline + switch wiring
  for (const needle of [
    'calc(124px * var(--hbw-s))',   // fixed-height baseline (mascot height; width follows bbox)
    'host.state.model',             // subscribe to the current model
    'switchTo',                      // switch function
    'autoSwitch',                    // switch toggle config
    'phrasePool',                    // pick a line from the per-mascot pool
  ]) assert.ok(src.includes(needle), 'auto-switch presence: ' + needle)

  /* ── ⑤c box model (assets tightly cropped to their bbox, box-hugging mascot)────────────────────────────── */
  // clip-path hitbox removed with the tight crop: cropping after zeroing the asset padding would cut into the mascot body
  assert.ok(!src.includes('hitClip'), 'clip-path hitbox removed after tight crop')
  assert.ok(!src.includes('HITBOX'), 'HITBOX table removed')
  for (const needle of [
    'calc(124px * var(--hbw-s))',    // fixed height = the mascot-height equivalent of the old fixed 235px width
    'width: auto',                   // width follows each mascot's actual width
    'pointer-events: none',          // root passes clicks through (outside the box falls back to the page)
    'pointer-events: auto',          // mascot body re-enables hit testing
    '.addEventListener(\'load\'',    // re-layout after decode
  ]) assert.ok(src.includes(needle), 'box model presence: ' + needle)

  /* ── ⑤d token pricing (default list price / custom override / estimate)────────────────────── */
  // all nine have a default price and a valid currency
  for (const id of expected) {
    const d = mod.DEFAULT_PRICES[id]
    assert.ok(d, id + ' default price exists')
    assert.ok(d.cur === 'CNY' || d.cur === 'USD', id + ' price currency')
    assert.ok(typeof d.in === 'number' && d.in >= 0, id + ' price in')
    assert.ok(typeof d.out === 'number' && d.out >= 0, id + ' price out')
    assert.ok(d.note && d.note.length > 8, id + ' price note cites source')
  }
  // custom values override per field; empty fields fall back to defaults; 0 is legal (free)
  const eff1 = mod.effectivePrices('claude', { in: 5 })
  assert.equal(eff1.in, 5, 'custom in overrides default')
  assert.equal(eff1.out, 10, 'untouched field falls back to default')
  assert.equal(eff1.hit, 0.2, 'hit falls back to default')
  assert.equal(eff1.cur, 'USD', 'currency from default table')
  const eff2 = mod.effectivePrices('mimo', { in: 0, out: null })
  assert.equal(eff2.in, 0, 'explicit 0 kept (free tier)')
  assert.equal(eff2.out, 2, 'null falls back to default')
  assert.equal(mod.effectivePrices('nope', {}).in, null, 'unknown pid → all null')
  // estimate: non-hit input×in + hit×hit + output×out, /1e6
  const cost = mod.estimateCost(
    { in: 800000, inHit: 200000, out: 100000 },
    { cur: 'USD', in: 2, out: 10, hit: 0.2 })
  // 0.6M×2 + 0.2M×0.2 + 0.1M×10 = 1.2 + 0.04 + 1.0 = 2.24
  assert.equal(cost, 2.24, 'estimate math: plain×in + hit×hit + out×out')
  // missing hit price -> billed at the in price (never understate)
  const cost2 = mod.estimateCost({ in: 1000000, inHit: 1000000, out: 0 },
    { cur: 'CNY', in: 3, out: 6, hit: null })
  assert.equal(cost2, 3, 'missing hit price → billed at in price')
  // missing in/out price -> not estimable
  assert.equal(mod.estimateCost({ in: 100, out: 100 }, { cur: 'CNY', in: null, out: 2 }), null,
    'missing in price → null')
  assert.equal(mod.estimateCost(null, { in: 1, out: 1 }), null, 'no tokens → null')
  // inHit clamped (never above total input)
  const cost3 = mod.estimateCost({ in: 1000000, inHit: 5000000, out: 0 },
    { cur: 'CNY', in: 1, out: 1, hit: 0 })
  assert.equal(cost3, 0, 'inHit clamped to inTotal (all billed at hit=0)')
  // today's token observation: deltas, session rollover, cross-day reset (exported for test)
  // now injected as Beijing 12:00 (mimo peak) -- without it the test would run in the small hours (Leibusi window)
  // deltas would be split into the d bucket and the base-bucket assertions below would fail; the split itself is covered by ⑤e
  const peakNoon = new Date('2026-10-14T04:00:00Z')
  const mem = new Map()
  const ctxT = { storage: { get: (k, d) => (mem.has(k) ? mem.get(k) : d), set: (k, v) => mem.set(k, v) } }
  mod.observeTokens(ctxT, 'mimo', { input: 1000, output: 100, cache_hit_pct: 50 }, peakNoon)
  let t = mod.todayTokens(ctxT, 'mimo')
  assert.equal(t.in, 0, 'first sight = baseline, no accounting')
  mod.observeTokens(ctxT, 'mimo', { input: 3000, output: 400, cache_hit_pct: 50 }, peakNoon)
  t = mod.todayTokens(ctxT, 'mimo')
  assert.equal(t.in, 2000, 'delta accounted')
  assert.equal(t.out, 300, 'output delta accounted')
  assert.equal(t.inHit, 1000, 'hit split = delta × pct')
  mod.observeTokens(ctxT, 'mimo', { input: 500, output: 50, cache_hit_pct: 50 }, peakNoon)
  t = mod.todayTokens(ctxT, 'mimo')
  assert.equal(t.in, 2500, 'session reset → current value fully accounted')
  assert.equal(mod.todayTokens(ctxT, 'other'), null, 'untracked pid → null')
  // cross-day: day mismatch -> todayTokens null, observeTokens resets the baseline
  mem.set(mod.tokenKey('mimo'), Object.assign({}, t, { day: '2000-01-01' }))
  assert.equal(mod.todayTokens(ctxT, 'mimo'), null, 'stale day → null')
  mod.observeTokens(ctxT, 'mimo', { input: 9999, output: 999, cache_hit_pct: 0 }, peakNoon)
  t = mod.todayTokens(ctxT, 'mimo')
  assert.equal(t.day, new Date().toISOString().slice(0, 10), 'new day re-baselined')
  assert.equal(t.in, 0, 'cross-day: old accumulation not carried over')
  // key conventions
  assert.equal(mod.priceKey('kimi'), 'price.kimi', 'priceKey shape')
  assert.equal(mod.tokenKey('kimi'), 'tk.kimi', 'tokenKey shape')
  assert.equal(mod.fmtTokens(1500000), '1.5M', 'fmtTokens M')
  assert.equal(mod.fmtTokens(2345), '2.3k', 'fmtTokens k')
  assert.equal(mod.fmtTokens(999), '999', 'fmtTokens raw')
  // settings page and widget wiring
  for (const needle of [
    'observeTokens',              // per-session token delta accounting
    'probeEstimate',              // probe-tier estimate
    'Today\'s estimate',          // display copy
    'Key not configured',         // not-configured notice
    'per 1M tokens',              // settings price field label
    'effectivePrices',            // override logic
    'tokAtBusyStart',             // per-turn cost token fallback
  ]) assert.ok(src.includes(needle), 'pricing presence: ' + needle)

  /* ── ⑤e time-of-day pricing (three vendors' windows + two-bucket estimate + accounting split)────────────────────── */
  assert.deepEqual(Object.keys(mod.SCHEDULES).sort(), ['deepseek', 'glm', 'mimo'],
    'exactly three scheduled vendors')
  for (const pid of Object.keys(mod.SCHEDULES)) {
    const sc = mod.SCHEDULES[pid]
    assert.ok(sc.discMult > 0 && sc.discMult < 1, pid + ' discount mult in (0,1)')
    assert.ok(typeof sc.isPeak === 'function' && sc.note && sc.note.includes('Beijing'),
      pid + ' window fn + note cites timezone')
    assert.equal(mod.scheduleMult(pid, new Date(0)), mod.scheduleMult(pid, new Date(0)),
      'deterministic for same instant')
  }
  // Beijing-time windows: 10-14 is Wednesday, 10-17 is Saturday (independent of local timezone, +8h to read the UTC fields)
  const wed10 = new Date('2026-10-14T02:00:00Z')   // Beijing 10:00 Wednesday
  const wed13 = new Date('2026-10-14T05:00:00Z')   // Beijing 13:00 Wednesday (lunch break)
  const wed15 = new Date('2026-10-14T07:00:00Z')   // Beijing 15:00 Wednesday
  const sat10 = new Date('2026-10-17T02:00:00Z')   // Beijing 10:00 Saturday
  const tue04 = new Date('2026-10-13T20:00:00Z')   // Beijing 04:00 Tuesday
  // deepseek: weekdays 9-12 / 14-18 peak, everything else off-peak at half price, weekends off all day
  assert.equal(mod.scheduleState('deepseek', wed10).peak, true, 'ds Wed 10:00 peak')
  assert.equal(mod.scheduleState('deepseek', wed13).peak, false, 'ds Wed 13:00 lunch off')
  assert.equal(mod.scheduleState('deepseek', wed15).peak, true, 'ds Wed 15:00 peak')
  assert.equal(mod.scheduleState('deepseek', sat10).peak, false, 'ds Sat 10:00 off (weekend)')
  assert.equal(mod.scheduleMult('deepseek', sat10), 0.5, 'ds weekend half price')
  // glm: weekdays 14-18 peak, everything else x0.5
  assert.equal(mod.scheduleState('glm', wed15).peak, true, 'glm Wed 15:00 peak')
  assert.equal(mod.scheduleState('glm', wed10).peak, false, 'glm Wed 10:00 off')
  assert.equal(mod.scheduleMult('glm', wed10), 0.5, 'glm off-peak half')
  // mimo: night 0-8 x0.8, daytime full price
  assert.equal(mod.scheduleState('mimo', tue04).peak, false, 'mimo 04:00 night')
  assert.equal(mod.scheduleMult('mimo', tue04), 0.8, 'mimo night 0.8x')
  assert.equal(mod.scheduleMult('mimo', wed10), 1, 'mimo day full price')
  assert.equal(mod.scheduleState('kimi', wed10), null, 'non-scheduled vendor → null')
  assert.equal(mod.scheduleMult('kimi', wed10), 1, 'non-scheduled mult → 1')
  // two-bucket estimate: base at full price + d bucket x discMult
  const dTok = { in: 1000000, inHit: 0, out: 1000000, d: { in: 1000000, inHit: 0, out: 1000000 } }
  const dCost = mod.dayEstimate('deepseek', dTok, { in: 4, out: 8, hit: null })
  // base: 1×4 + 1×8 = 12；d: (1×4 + 1×8) × 0.5 = 6 → 18
  assert.equal(dCost, 18, 'dayEstimate = base + d×discMult')
  assert.equal(mod.dayEstimate('deepseek', { in: 1000000, inHit: 0, out: 0 }, { in: 4, out: 8 }),
    4, 'base-only tokens unchanged (no d bucket)')
  assert.equal(mod.dayEstimate('deepseek', null, {}), null, 'no tokens → null')
  // non-scheduled provider: d bucket billed at full price, no discount (kimi defaults in20/out100 -> 1x20+1x100=120)
  assert.equal(mod.dayEstimate('kimi', dTok, {}), 120, 'non-scheduled: d bucket billed at full price')
  // provider with no default price + empty custom -> in/out unavailable -> null
  assert.equal(mod.dayEstimate('nope', dTok, {}), null, 'no default + no custom → null')
  // accounting split: mimo night now -> tokens go into the d bucket
  const memS = new Map()
  const ctxS = { storage: { get: (k, v) => (memS.has(k) ? memS.get(k) : v), set: (k, v) => memS.set(k, v) } }
  mod.observeTokens(ctxS, 'mimo', { input: 1000, output: 100, cache_hit_pct: 50 }, tue04)
  mod.observeTokens(ctxS, 'mimo', { input: 4000, output: 600, cache_hit_pct: 50 }, tue04)
  let tr = mod.todayTokens(ctxS, 'mimo')
  assert.equal(tr.in, 0, 'night delta → base bucket untouched')
  assert.equal(tr.d.in, 3000, 'night delta → d bucket in')
  assert.equal(tr.d.out, 500, 'night delta → d bucket out')
  assert.equal(tr.d.inHit, 1500, 'night hit split in d bucket')
  // daytime continuation -> base bucket
  mod.observeTokens(ctxS, 'mimo', { input: 5000, output: 800, cache_hit_pct: 50 }, wed10)
  tr = mod.todayTokens(ctxS, 'mimo')
  assert.equal(tr.in, 1000, 'day delta → base bucket')
  assert.equal(tr.d.in, 3000, 'd bucket preserved')
  // wiring
  for (const needle of [
    'dayEstimate',                    // schedule-aware estimate
    'scheduleState',                  // window detection
    'Current window',                 // popup row
    'schMultAtBusyStart',             // per-turn cost multiplier
    'off-peak split',                 // token bucket split comment
  ]) assert.ok(src.includes(needle), 'schedule presence: ' + needle)
  assert.ok(src.includes("Currently ' + sch.label"), 'settings shows live schedule tier')
  assert.ok(src.includes('Coding Plan credits offset 50%'), 'settings shows glm schedule note')

  /* ── ⑤f header tier badges (pure probe renders nothing)───────────────────────────────── */
  assert.equal(mod.tierBadges([{ kind: 'probe' }]), '', 'pure probe → no badge text')
  assert.equal(mod.tierBadges([{ kind: 'probe' }, { kind: 'probe' }]), '', 'all probe → no badge text')
  assert.equal(mod.tierBadges([{ kind: 'balance' }, { kind: 'probe' }]), 'Balance', 'balance + probe')
  assert.equal(mod.tierBadges([]), '', 'no sources → no badge text')
  // real providers: kimi's three sources aggregate to 'true balance + subscription', mimo's single probe source renders empty
  assert.equal(mod.tierBadges(mod.PROVIDERS.kimi.sources), 'Balance + Subscription', 'kimi aggregated badge')
  assert.equal(mod.tierBadges(mod.PROVIDERS.mimo.sources), '', 'mimo is probe-only → no badge')
  assert.equal(mod.tierBadges(mod.PROVIDERS.minimax.sources), 'Subscription', 'minimax quota-only badge')
  // render wiring: pure-probe providers no longer show the old fallback copy, and the badge is conditionally attached
  // (the old probe fallback badge copy is covered by the pure-probe assertions above)
  assert.ok(src.includes('if (badgeTxt)'), 'badge conditionally attached to header')
  // the whole header row is skipped for pure-probe providers (name and badge together)
  assert.ok(src.includes('probe-only vendors skip it entirely'), 'header gated on tier text')
  // three probe detail rows already removed: status row, duplicate estimate row, why row (why moved to the headline subtitle)
  assert.ok(!src.includes("rows.push(['Status', r && r.ok"), 'probe ok-status row removed')
  assert.ok(!src.includes("rows.push(['Today's estimate', money("), 'duplicate estimate row removed')
  assert.ok(!src.includes("rows.push(['Today's estimate', est.why)"), 'why row no longer a detail row')
  assert.ok(src.includes('sub = est.why'), 'why surfaces in headline sub instead')

  /* ── ⑤g used-today read keys (once always 0 due to a doubled obs. prefix)─────────────────────── */
  {
    const memU = new Map()
    const ctxU = { storage: { get: (k, v) => (memU.has(k) ? memU.get(k) : v), set: (k, v) => memU.set(k, v) } }
    const today = new Date().toISOString().slice(0, 10)
    memU.set('obs.deepseek', { day: today, last: 42.5, used: 8.72 })
    assert.equal(mod.todayUsed(ctxU, mod.obsKey('deepseek', 0, undefined)), 8.72,
      'todayUsed reads the exact obsKey (no double prefix)')
    assert.equal(mod.todayUsed(ctxU, 'obs.deepseek'), 8.72, 'explicit key path')
    memU.set('obs.kimi.payg', { day: today, last: 1, used: 2.5 })
    assert.equal(mod.todayUsed(ctxU, mod.obsKey('kimi', 1, 'payg')), 2.5, 'multi-source keyed read')
    memU.set('obs.stale', { day: '2000-01-01', used: 9 })
    assert.equal(mod.todayUsed(ctxU, 'obs.stale'), 0, 'stale day resets to 0')
    assert.equal(mod.todayUsed(null, 'obs.deepseek'), null, 'no ctx → null')
    // the implementation must not prepend obs. again
    assert.ok(!src.includes("ctx.storage.get('obs.' + "), 'no double obs. prefix in reader')
  }

  /* ── ⑥ Registration structure ─────────────────────────────────────────────────────── */
  const contributions = []
  const stored = new Map()
  const ctx = {
    register(c) { contributions.push(c); return () => {} },
    storage: { get: (k, fb) => (stored.has(k) ? stored.get(k) : fb),
               set: (k, v) => stored.set(k, v), remove: (k) => stored.delete(k) },
    onDispose() {},
  }
  mod.default.register(ctx)
  assert.equal(mod.default.id, 'nine-balance-widget', 'plugin id')
  assert.equal(contributions.length, 3, 'three contributions')
  const areas = contributions.map((c) => c.area).sort()
  assert.deepEqual(areas, ['palette', 'routes', 'sidebar.nav'], 'areas')
  const route = contributions.find((c) => c.area === 'routes')
  assert.equal(route.data.path, '/balance-widget', 'route path')
  assert.equal(typeof route.render, 'function', 'settings page render')
  const nav = contributions.find((c) => c.area === 'sidebar.nav')
  assert.equal(nav.data.path, '/balance-widget', 'nav pairs route')
  const pal = contributions.find((c) => c.area === 'palette')
  assert.equal(pal.data.label, 'Balance Widget: Open settings', 'palette label')

  console.log('SMOKE OK — providers/jsonPath/three-state fetch/registration structure assertions passed')
} finally {
  fs.rmSync(tmp, { force: true })
}
