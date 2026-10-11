/**
 * nine-balance-widget — Hermes desktop plugin shell
 * ============================================================================
 * Balance/quota widget for nine providers (ported from the dsh-whale-widget idea, MIT).
 * Phase 1: settings page (nine provider cards + key config + live fetch test)
 *          + route / sidebar / command palette entries.
 * Phase 2: the widget body itself, docked bottom-right (bubble, drag & snap, character swap).
 *
 * Single-file assembly convention: build.py splices the module sources of
 * ./providers.js and ./balance.js straight into the artifact (both ESM, so
 * coexisting exports are legal) and strips this file's two relative imports.
 */

import {
  host,
  haptic,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA,
  Input,
  Button,
  ToggleRow
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'
import { PROVIDERS, PROVIDER_ORDER, sourceTier, srcKey } from './providers.js'
import { mountWidget, unmountWidget } from './widget.js'
import { fetchSource } from './balance.js'
import { DEFAULT_PRICES, SCHEDULES, effectivePrices, estimateCost, dayEstimate, scheduleState, priceKey, tokenKey, fmtTokens } from './pricing.js'

const ID = 'nine-balance-widget'
/** Version: keep it in sync with the git tag at release (the plugin.js asset in Releases is this version). */
export const VERSION = '1.1.4'

/** Phase 1 fetch results live in component state only — they are never written to storage. */
let gCtx = null
/** Widget handle (Phase 2). */
let gWidget = null

function readCfgLocal(ctx) {
  const g = (k, d) => (ctx ? ctx.storage.get(k, d) : d)
  return {
    enabled: g('enabled', true) !== false,
    mainPid: String(g('mainPid', 'deepseek') || 'deepseek'),
    pos: g('pos', null),
    scale: Number(g('scale', 1)) || 1,
    sfx: g('sfx', true) !== false,
    sfxVolume: g('sfxVolume', 0.7) != null ? Number(g('sfxVolume', 0.7)) : 0.7,
    phrases: g('phrases', true) !== false,
    alertEnabled: !!g('alertEnabled', false),
    alertThreshold: Number(g('alertThreshold', 0)) || 0,
    autoSwitch: g('autoSwitch', true) !== false,
  }
}
function writeCfgLocal(ctx, patch) {
  if (!ctx) return
  for (const [k, v] of Object.entries(patch)) ctx.storage.set(k, v)
}
/** Restart the widget (after a toggle / primary-provider / position change). */
function remountWidget() {
  if (!gCtx) return
  const cfg = readCfgLocal(gCtx)
  if (gWidget) { gWidget.unmount(); gWidget = null }
  gWidget = mountWidget(gCtx, {
    enabled: cfg.enabled, mainPid: cfg.mainPid, pos: cfg.pos,
    scale: cfg.scale, sfx: cfg.sfx, sfxVolume: cfg.sfxVolume,
    phrases: cfg.phrases, alertEnabled: cfg.alertEnabled, alertThreshold: cfg.alertThreshold,
    autoSwitch: cfg.autoSwitch,
  })
}

/** Read/write keys per source: srcKey(pid, idx, sid) — the first source reuses key.<pid> (zero migration for old configs). */
function readKey(ctx, pid, idx, sid) {
  return ctx ? String(ctx.storage.get(srcKey(pid, idx, sid), '') || '') : ''
}
function writeKey(ctx, pid, idx, sid, value) {
  if (!ctx) return
  const v = String(value || '').trim()
  const k = srcKey(pid, idx, sid)
  if (v) ctx.storage.set(k, v)
  else ctx.storage.remove(k)
}

/** Rate read/write: {in,out,hit,create} numbers or null (null = use the list price). */
function readPrice(ctx, pid) {
  const raw = ctx ? ctx.storage.get(priceKey(pid), null) : null
  return raw && typeof raw === 'object' ? raw : {}
}
function writePrice(ctx, pid, patchObj) {
  if (!ctx) return
  const cur = readPrice(ctx, pid)
  ctx.storage.set(priceKey(pid), Object.assign({}, cur, patchObj))
}
const PRICE_FIELDS = [
  ['in', 'Input'], ['out', 'Output'], ['hit', 'Cache hit'], ['create', 'Cache write'],
]

const TIER_LABEL = {
  balance: { text: 'Pay-as-you-go · Real balance', color: '#16a34a' },
  quota: { text: 'Subscription quota', color: '#2563eb' },
  probe: { text: 'Probe · No balance API', color: '#a16207' },
}

const ROW_STYLE = {
  border: '1px solid rgba(128,128,128,.25)',
  borderRadius: 10,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}
const HEAD_STYLE = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const BADGE_STYLE = {
  fontSize: 11, padding: '2px 7px', borderRadius: 999,
  border: '1px solid currentColor', opacity: 0.95,
}
const RESULT_STYLE = { fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }

function formatResult(tier, r) {
  if (!r) return ''
  if (r.unconfigured) return '— No API key set' + (r.note ? ' (' + r.note + ')' : '')
  if (r.unsupported) return '— ' + (r.note || 'This template does not support this lookup')
  if (r.error) return 'Request failed: ' + r.error
  if (!r.ok) {
    if (r.probeOnly) return 'Probe failed' + (r.status ? ' (HTTP ' + r.status + ')' : '')
    return 'Fetch failed' + (r.status ? ' (HTTP ' + r.status + ')' : '') + (r.parse ? ' · fields not found' : '')
  }
  if (r.probeOnly) return '✓ Key works (HTTP ' + r.status + ') · no balance API — showing "—"'
  if (tier === 'balance') {
    const cur = r.currency === 'USD' ? '$' : '¥'
    const parts = ['✓ Balance ' + cur + (r.remaining != null ? r.remaining.toFixed(4) : '—')]
    if (r.total != null) parts.push('Total ' + cur + r.total.toFixed(4))
    if (r.used != null) parts.push('Used ' + cur + r.used.toFixed(4))
    return parts.join(' · ')
  }
  if (tier === 'quota') {
    return '✓ ' + r.windows.map((w) =>
      w.label + ' ' + (w.percent != null ? w.percent.toFixed(1) + '%' : (w.remain != null ? w.remain : '—'))
    ).join(' · ')
  }
  return '✓'
}

/** Key input + connectivity test for a single source (one provider can host several: subscription / pay-as-you-go on separate rows). */
function SourceRow({ pid, idx }) {
  const p = PROVIDERS[pid]
  const s = p.sources[idx]
  const [key, setKeyState] = useState(() => readKey(gCtx, pid, idx, s.id))
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  const tier = sourceTier(s)
  const badge = TIER_LABEL[tier]

  async function test() {
    if (!key.trim()) {
      setResult({ unsupported: true, note: 'Enter your ' + s.keyRef })
      return
    }
    haptic('tap')
    setBusy(true)
    setResult(null)
    const r = await fetchSource(s, key.trim())
    setResult(r)
    setBusy(false)
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 7,
             padding: '9px 0 0', borderTop: idx ? '1px dashed rgba(128,128,128,.28)' : 'none' },
    children: [
      jsxs('div', { style: HEAD_STYLE, children: [
        jsx('strong', { style: { fontSize: 12.5 }, children: s.label }),
        jsx('span', { style: { ...BADGE_STYLE, color: badge.color }, children: badge.text }),
        jsx('span', { style: { fontSize: 11, opacity: 0.6 }, children: s.keyRef }),
      ] }),
      jsxs('div', { style: { display: 'flex', gap: 8 }, children: [
        jsx(Input, {
          value: key,
          type: 'password',
          placeholder: 'Enter ' + s.keyRef,
          style: { flex: 1, fontSize: 12.5 },
          onChange: (e) => { setKeyState(e.target.value); writeKey(gCtx, pid, idx, s.id, e.target.value) },
        }),
        jsx(Button, { size: 'sm', disabled: busy, onClick: test, children: busy ? 'Testing…' : 'Test connection' }),
      ] }),
      s.apiNote ? jsx('div', { style: { fontSize: 11.5, opacity: 0.65, lineHeight: 1.5 }, children: s.apiNote }) : null,
      result ? jsx('div', { style: RESULT_STYLE, children: formatResult(tier, result) }) : null,
    ],
  })
}

/** Four rates (per 1M tokens; blank = fall back to the list price) + today's estimate preview. */
function PriceRow({ pid }) {
  const def = DEFAULT_PRICES[pid] || {}
  const cur = def.cur === 'USD' ? '$' : '¥'
  const [vals, setVals] = useState(() => {
    const stored = readPrice(gCtx, pid)
    return {
      in: stored.in != null ? String(stored.in) : '',
      out: stored.out != null ? String(stored.out) : '',
      hit: stored.hit != null ? String(stored.hit) : '',
      create: stored.create != null ? String(stored.create) : '',
    }
  })

  function set(field, text) {
    setVals((v) => Object.assign({}, v, { [field]: text }))
    const n = Number(text)
    writePrice(gCtx, pid, { [field]: text.trim() === '' || !isFinite(n) ? null : n })
  }

  const custom = readPrice(gCtx, pid)
  const eff = effectivePrices(pid, custom)
  const tok = gCtx ? gCtx.storage.get(tokenKey(pid), null) : null
  const est = tok && (tok.in > 0 || tok.out > 0) ? dayEstimate(pid, tok, custom) : null
  const sch = scheduleState(pid)

  const cell = { display: 'flex', flexDirection: 'column', gap: 3 }
  const lbl = { fontSize: 11, opacity: 0.65 }
  const inputStyle = { fontSize: 12.5, width: '100%', boxSizing: 'border-box' }

  return jsxs('div', {
    style: { marginTop: 9, paddingTop: 8, borderTop: '1px dashed rgba(128,128,128,.28)',
             display: 'flex', flexDirection: 'column', gap: 7 },
    children: [
      jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [
        jsx('strong', { style: { fontSize: 12.5 }, children: 'Price (per 1M tokens)' }),
        jsx('span', { style: { fontSize: 11, opacity: 0.6 },
          children: 'Blank = list price · ' + (def.note || 'No list price — blanks are not estimated')
            + (SCHEDULES[pid] ? ' · ' + SCHEDULES[pid].note : '') }),
      ] }),
      jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }, children:
        PRICE_FIELDS.map(([f, label]) => jsx('div', { style: cell, children: [
          jsx('span', { style: lbl, children: label + ' (' + cur + ')' }),
          jsx(Input, {
            type: 'number', min: 0, step: 'any', value: vals[f],
            placeholder: def[f] != null ? String(def[f]) : '—',
            style: inputStyle,
            onChange: (e) => set(f, e.target.value),
          }),
        ] }, f)),
      }),
      jsx('div', { style: { fontSize: 11.5, opacity: 0.7, lineHeight: 1.5 }, children:
        (est != null
          ? 'Today\'s estimate: ' + money2(est, eff.cur) + ' (in ' + fmtTokens(tok.in) + ' / out ' + fmtTokens(tok.out) + ' tok)'
          : 'Today\'s estimate: no token usage yet today')
          + (sch ? ' · Currently ' + sch.label + (sch.peak ? ' (list price)' : ' ×' + sch.sc.discMult) : '') }),
    ],
  })
}

/** Amount formatting (inline shell copy, same rules as the widget's money). */
function money2(v, currency) {
  if (v == null) return '—'
  const sym = currency === 'USD' ? '$' : '¥'
  return sym + (Math.round(v * 10000) / 10000).toLocaleString()
}

/** Provider card: header (name + note) + one row per source (subscription / pay-as-you-go split). */
function ProviderRow({ pid }) {
  const p = PROVIDERS[pid]
  return jsxs('div', { style: ROW_STYLE, children: [
    jsxs('div', { style: HEAD_STYLE, children: [
      jsx('strong', { style: { fontSize: 13.5 }, children: p.name }),
      jsx('span', { style: { fontSize: 11, opacity: 0.6 }, children: p.sources.length + ' sources' }),
    ] }),
    p.apiNote ? jsx('div', { style: { fontSize: 11.5, opacity: 0.65, lineHeight: 1.5 }, children: p.apiNote }) : null,
    ...p.sources.map((s, i) => jsx(SourceRow, { pid, idx: i }, s.id)),
    jsx(PriceRow, { pid }),
  ] })
}

function WidgetControls() {
  const cfg = readCfgLocal(gCtx)
  const [enabled, setEnabled] = useState(cfg.enabled)
  const [mainPid, setMainPid] = useState(cfg.mainPid)
  const [scale, setScale] = useState(cfg.scale)
  const [sfx, setSfx] = useState(cfg.sfx)
  const [volume, setVolume] = useState(cfg.sfxVolume)
  const [phrases, setPhrases] = useState(cfg.phrases)
  const [autoSwitch, setAutoSwitch] = useState(cfg.autoSwitch)
  const [alertOn, setAlertOn] = useState(cfg.alertEnabled)
  const [threshold, setThreshold] = useState(cfg.alertThreshold ? String(cfg.alertThreshold) : '')

  function toggle(v) {
    setEnabled(v)
    writeCfgLocal(gCtx, { enabled: v })
    remountWidget()
  }
  function pick(pid) {
    setMainPid(pid)
    writeCfgLocal(gCtx, { mainPid: pid })
    remountWidget()
  }
  // Size: applies live while dragging — setScale scales in place (visual center fixed, 1:1 coordinates don't drift)
  function onScale(v) {
    setScale(v)
    writeCfgLocal(gCtx, { scale: v })
    if (gWidget && gWidget.setScale) gWidget.setScale(v)
  }
  function onVolume(v) {
    setVolume(v)
    writeCfgLocal(gCtx, { sfxVolume: v })
    remountWidget()
  }

  const SECTION = { fontSize: 12, opacity: 0.7, marginTop: 4 }
  const RAIL = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }

  return jsxs('div', {
    style: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 10, padding: '12px 14px', marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 },
    children: [
      jsx(ToggleRow, { checked: enabled, label: 'Show bottom-right widget', onChange: toggle }),
      jsxs('div', { style: RAIL, children: [
        jsx('span', { style: { minWidth: 74 }, children: 'Widget size' }),
        jsx('input', {
          type: 'range', min: 0.6, max: 1.6, step: 0.05, value: scale,
          style: { flex: 1 },
          onChange: (e) => onScale(Number(e.target.value)),
        }),
        jsx('span', { style: { fontVariantNumeric: 'tabular-nums', width: 44, textAlign: 'right' }, children: Math.round(scale * 100) + '%' }),
      ] }),
      jsxs('div', { style: RAIL, children: [
        jsx(ToggleRow, { checked: sfx, label: 'Sound effects (press / task done / alert)', onChange: (v) => { setSfx(v); writeCfgLocal(gCtx, { sfx: v }); remountWidget() } }),
      ] }),
      jsxs('div', { style: { ...RAIL, opacity: sfx ? 1 : 0.45 }, children: [
        jsx('span', { style: { minWidth: 74 }, children: 'Volume' }),
        jsx('input', {
          type: 'range', min: 0, max: 1, step: 0.05, value: volume, disabled: !sfx,
          style: { flex: 1 },
          onChange: (e) => onVolume(Number(e.target.value)),
        }),
        jsx('span', { style: { fontVariantNumeric: 'tabular-nums', width: 44, textAlign: 'right' }, children: Math.round(volume * 100) + '%' }),
      ] }),
      jsx(ToggleRow, { checked: phrases, label: 'Random popup phrases', onChange: (v) => { setPhrases(v); writeCfgLocal(gCtx, { phrases: v }); remountWidget() } }),
      jsx(ToggleRow, { checked: alertOn, label: 'Balance alert (notify + sound below the threshold)', onChange: (v) => { setAlertOn(v); writeCfgLocal(gCtx, { alertEnabled: v }); remountWidget() } }),
      jsxs('div', { style: { ...RAIL, opacity: alertOn ? 1 : 0.45 }, children: [
        jsx('span', { style: { minWidth: 74 }, children: 'Alert threshold' }),
        jsx(Input, {
          type: 'number', min: 0, step: 0.5, value: threshold, disabled: !alertOn,
          placeholder: 'e.g. 5 (real-balance providers only)',
          style: { flex: 1, fontSize: 12.5 },
          onChange: (e) => {
            setThreshold(e.target.value)
            writeCfgLocal(gCtx, { alertThreshold: Number(e.target.value) || 0 })
            remountWidget()
          },
        }),
      ] }),
      jsx(ToggleRow, {
        checked: autoSwitch,
        label: 'Auto-switch character to follow the current model (keyword match, case-insensitive)',
        onChange: (v) => { setAutoSwitch(v); writeCfgLocal(gCtx, { autoSwitch: v }); remountWidget() },
      }),
      jsx('div', { style: SECTION, children: autoSwitch
        ? 'Primary provider (fallback character when no model keyword matches — tap to switch)'
        : 'Primary provider (sets the widget character and the data shown — tap to switch)' }),
      jsxs('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }, children:
        PROVIDER_ORDER.map((pid) => {
          const active = pid === mainPid
          return jsx('button', {
            onClick: () => pick(pid),
            style: {
              font: 'inherit', fontSize: 12, padding: '6px 4px', cursor: 'pointer', borderRadius: 8,
              border: active ? '1.5px solid #3b82f6' : '1px solid rgba(128,128,128,.35)',
              background: active ? 'rgba(59,130,246,.14)' : 'transparent',
              color: 'inherit',
            },
            children: PROVIDERS[pid].name.replace(/（.*）/, ''),
          }, pid)
        }),
      }),
    ],
  })
}

function SettingsPage() {
  const [reloadTick, setReloadTick] = useState(0)
  return jsxs('div', {
    style: { padding: '20px 24px 32px', maxWidth: 760 },
    children: [
      jsxs('div', { style: { marginBottom: 14 }, children: [
        jsx('h1', { style: { fontSize: 18, fontWeight: 650, margin: '0 0 4px' }, children: 'Balance Widget · Provider Settings' }),
        jsx('p', { style: { fontSize: 12.5, opacity: 0.65, margin: 0 },
          children: 'Data-source setup for nine providers + widget controls (tap the character to pop the glass card, drag to move). Keys stay in local plugin storage and are never uploaded.' }),
      ] }),
      jsx(WidgetControls, {}),
      jsx('div', {
        key: reloadTick,
        style: { display: 'flex', flexDirection: 'column', gap: 10 },
        children: PROVIDER_ORDER.map((pid) => jsx(ProviderRow, { pid }, pid)),
      }),
      jsx('p', { style: { fontSize: 11.5, opacity: 0.5, margin: '2px 0 8px', textAlign: 'center' },
        children: 'Balance Widget v' + VERSION + ' · single-file on-disk plugin (plugin.js) · keys stay local' }),
    ],
  })
}

export default {
  id: ID,
  name: 'Balance Widget',
  description: 'Balance/quota widget for nine providers: DeepSeek, MiniMax, Zhipu, Kimi, MiMo, ChatGPT, Claude, Gemini, Grok.',
  register(ctx) {
    host.notify({ kind: 'info', message: '💰 Balance Widget loaded · settings: sidebar "Balance Widget"' })
    gCtx = ctx

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/balance-widget', title: 'Balance Widget' },
      render: () => jsx(SettingsPage, {}),
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      order: 61,
      data: { codicon: 'symbol-odometer', label: 'Balance Widget', path: '/balance-widget' },
    })

    /* Widget body (Phase 2): docked bottom-right */
    try {
      const cfg = readCfgLocal(ctx)
      gWidget = mountWidget(ctx, {
        enabled: cfg.enabled, mainPid: cfg.mainPid, pos: cfg.pos,
        scale: cfg.scale, sfx: cfg.sfx, sfxVolume: cfg.sfxVolume,
        phrases: cfg.phrases, alertEnabled: cfg.alertEnabled, alertThreshold: cfg.alertThreshold,
        autoSwitch: cfg.autoSwitch,
      })
    } catch (err) {
      console.error('[nine-balance-widget] widget mount error:', err)
    }

    ctx.register({
      id: 'open-settings',
      area: PALETTE_AREA,
      data: {
        id: 'balance-widget.settings',
        label: 'Balance Widget: Open settings',
        keywords: ['balance', 'widget', 'quota', 'money', 'settings'],
        run: () => host.navigate('/balance-widget'),
      },
    })

    ctx.onDispose(() => {
      if (gWidget) { try { gWidget.unmount() } catch (e) { /* noop */ } gWidget = null }
      gCtx = null
    })
  },
}
