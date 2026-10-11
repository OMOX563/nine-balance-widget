/**
 * nine-balance-widget — fetch executor (multi-source)
 * ============================================================================
 * Template-driven three-state fetching: pay-as-you-go real balance /
 * subscription quota / probe. Pure functions plus an injected fetch, so it is
 * easy to smoke-test and to reuse in a browser or any runtime. A provider's
 * sources[] can hold several rows (subscription and pay-as-you-go kept apart)
 * and fetchAll walks them source by source, then aggregates.
 *
 * fetchBalance(src, key)     → { ok, remaining, total?, currency, ... }
 * fetchQuota(src, key)       → { ok, windows: [{key,label,percent,resetAt?}], ... }
 * probe(src, key)            → { ok, status, note? }
 * fetchSource(src, key)      → dispatches on src.kind, tagging the result with srcLabel/srcTier
 * fetchAll(provider, keyFor) → [{ src, result }] (sources without a key are marked unconfigured)
 */

/* ── Field path: supports a.b[0].c, returns undefined when missing ──────── */
export function jsonPath(obj, path) {
  if (!path) return undefined
  let cur = obj
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[part]
  }
  return cur
}

/** Number read: resolve the path → Number; non-finite values return null. Optional scale multiplier. */
function num(obj, path, scale) {
  const v = jsonPath(obj, path)
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return scale ? n * scale : n
}

/**
 * auth template → header object. '' returns {}.
 * extra is the headers table (per-source extra request headers, e.g. the Claude probe's two headers);
 * values support the {key} placeholder.
 * A raw value template (Zhipu style: auth === '{key}') is used as Authorization directly; otherwise the template is used as-is.
 */
export function buildHeaders(authTpl, key, extra) {
  const out = {}
  const tpl = String(authTpl || '')
  if (tpl) out.Authorization = tpl.replace('{key}', key || '')
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) out[k] = String(extra[k]).replace('{key}', key || '')
  }
  return out
}

/** url template: {key} placeholder substitution (URL-encoded). */
function buildUrl(tpl, key) {
  return String(tpl || '').replace('{key}', encodeURIComponent(key || ''))
}

function mergeHeaders(...parts) {
  return Object.assign({}, ...parts.filter(Boolean))
}

/* ── Pay-as-you-go real balance ─────────────────────────────────────────── */
export async function fetchBalance(src, key, fetchImpl = fetch) {
  const b = src && src.balance
  if (!b || !b.url || (src.kind && src.kind !== 'balance')) {
    return { ok: false, unsupported: true, note: src && src.apiNote }
  }
  try {
    const res = await fetchImpl(buildUrl(b.url, key), {
      headers: mergeHeaders(buildHeaders(b.auth, key, b.headers), { Accept: 'application/json' }),
    })
    if (!res.ok) return { ok: false, status: res.status }
    const body = await res.json()
    const bizMsg = body && body.success === false ? (body.msg || body.message) : null
    if (bizMsg) return { ok: false, note: bizMsg }
    const remaining = num(body, b.json && b.json.remaining, b.json && b.json.remainingScale)
    const total = num(body, b.json && b.json.total, b.json && b.json.totalScale)
    const used = num(body, b.json && b.json.used, b.json && b.json.usedScale)
    if (remaining === null && total === null) return { ok: false, status: res.status, parse: true }
    return { ok: true, remaining, total: total, used: used, currency: src.currency }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/* ── Subscription quota ─────────────────────────────────────────────────── */
export async function fetchQuota(src, key, fetchImpl = fetch) {
  const q = src && src.quota
  if (!q || !q.url || (src.kind && src.kind !== 'quota')) return { ok: false, unsupported: true }
  try {
    const res = await fetchImpl(buildUrl(q.url, key), {
      headers: mergeHeaders(buildHeaders(q.auth, key, q.headers), { Accept: 'application/json' }),
    })
    if (!res.ok) return { ok: false, status: res.status }
    const body = await res.json()
    // Business-level error (HTTP 200 + success:false, e.g. Zhipu's "no coding plan for this user") → surface the msg
    const bizMsg = body && body.success === false ? (body.msg || body.message) : null
    if (bizMsg) return { ok: false, note: bizMsg }

    // Shape (1): multi-window windows[] (Zhipu's data.limits pick / OpenCode's three windows)
    if (q.json && Array.isArray(q.json.windows)) {
      const windows = []
      for (const w of q.json.windows) {
        let source = body
        if (w.pick && w.pick.list) {
          const list = jsonPath(body, w.pick.list)
          if (!Array.isArray(list)) continue
          source = list.find((it) => {
            const typeOk = !w.pick.types || w.pick.types.includes(it && it.type)
            const unitOk = w.pick.unit === undefined || (it && it.unit) === w.pick.unit
            return typeOk && unitOk
          })
          if (!source) continue
        }
        const percent = num(source, w.percent, w.scale)
        if (percent === null) continue
        windows.push({ key: w.key, label: w.label, percent, resetAt: jsonPath(source, w.resetAt) })
      }
      return windows.length ? { ok: true, windows } : { ok: false, parse: true }
    }

    // Shape (2): simple fields (remainPct / weeklyRemainPct / remain+total)
    const windows = []
    const pct = num(body, q.json && q.json.remainPct)
    const weeklyPct = num(body, q.json && q.json.weeklyRemainPct)
    const resetAtMs = jsonPath(body, q.json && q.json.resetAtMs)
    const resetAt = jsonPath(body, q.json && q.json.resetAt)
    if (pct !== null) windows.push({ key: 'rolling', label: '5h', percent: pct, resetAt: resetAtMs || resetAt })
    if (weeklyPct !== null) windows.push({ key: 'weekly', label: 'Week', percent: weeklyPct, resetAt: null })
    if (!windows.length) {
      const remain = num(body, q.json && q.json.remain)
      const total = num(body, q.json && q.json.total)
      if (remain !== null) {
        windows.push({
          key: 'quota', label: 'Quota',
          percent: total ? (remain / total) * 100 : null,
          remain, total, resetAt,
        })
      }
    }
    return windows.length ? { ok: true, windows, currency: src.currency } : { ok: false, parse: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/* ── Probe (providers with no balance API: key check only) ──────────────── */
export async function probe(src, key, fetchImpl = fetch) {
  const url = src && src.probeUrl
  if (!url) return { ok: false, unsupported: true, note: src && src.apiNote }
  try {
    // auth prefers the source-level src.auth ('' means no Authorization header, using the ?key= form)
    const authTpl = src.auth !== undefined ? src.auth : (src.balance && src.balance.auth)
    const res = await fetchImpl(buildUrl(url, key), {
      headers: mergeHeaders(buildHeaders(authTpl, key, src.headers)),
    })
    // For gemini's ?key= form a 200 means alive; 401/403 means the key is invalid; 404 often means insufficient key permissions too
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/** Dispatch a single source by kind (callers block a missing key first). */
export async function fetchSource(src, key, fetchImpl = fetch) {
  if (src.kind === 'balance') return fetchBalance(src, key, fetchImpl)
  if (src.kind === 'quota') return fetchQuota(src, key, fetchImpl)
  return { ...(await probe(src, key, fetchImpl)), probeOnly: true }
}

/**
 * Fetch source by source: keyFor(src, idx) returns that source's key (empty string = not configured).
 * Returns [{ src, result }] in the same order as provider.sources.
 */
export async function fetchAll(provider, keyFor, fetchImpl = fetch) {
  const sources = (provider && provider.sources) || []
  const out = []
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]
    const key = String(keyFor(src, i) || '')
    if (!key) {
      out.push({ src, result: { ok: false, unconfigured: true, note: src.apiNote || 'No API key set' } })
      continue
    }
    try {
      out.push({ src, result: await fetchSource(src, key, fetchImpl) })
    } catch (err) {
      out.push({ src, result: { ok: false, error: String((err && err.message) || err) } })
    }
  }
  return out
}
