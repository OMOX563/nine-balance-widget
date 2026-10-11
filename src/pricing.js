/**
 * nine-balance-widget — token pricing (list prices + custom rates + today's estimate)
 * ============================================================================
 * Providers without a balance API (the probe tier) estimate spend as
 * "tokens × per-1M rate"; every provider can override four rates
 * (input / output / cache hit / cache write, per 1M tokens) and any field may
 * be left blank → a blank falls back to the list price.
 *
 * Data source: host.state.focusedUsage input/output (cumulative session tokens)
 * plus cache_hit_pct (session cache hit rate, 0-100). The host exposes no
 * "cache write" breakdown, so that rate stays configurable while its token
 * count is always 0 in estimates (see estimateCost).
 *
 * List prices come from 2026-10 community / official-doc searches, each note
 * cites its source; prices go stale when vendors reprice, and custom rates can
 * override them at any time.
 *
 * Time-of-day pricing (DeepSeek / GLM / MiMo): the configured rate is the peak
 * rate, and hitting an off-peak window multiplies it by a factor. Windows are
 * evaluated in Beijing time (UTC+8, independent of the local timezone); today's
 * tokens are routed into the base / d buckets by the window they were booked
 * in, so usage spanning windows settles at each window's own rate, the estimate
 * differs from the display by a single multiplication, and changing a rate
 * recomputes everything immediately.
 */

/** Price storage key / today's token observation key (same shape as key.<pid>, obs.<pid>). */
export function priceKey(pid) { return 'price.' + pid }
export function tokenKey(pid) { return 'tk.' + pid }

/** List price per provider (per 1M tokens; cur is that provider's display currency). */
export const DEFAULT_PRICES = {
  deepseek: { cur: 'CNY', in: 2, out: 8, hit: 0.04, create: null,
    note: 'DeepSeek V4.1-Flash: peak in 2 / out 8 / cache hit 0.04 CNY per M (off-peak auto ×0.5 = 1/4/0.02)' },
  minimax: { cur: 'CNY', in: 7.2, out: 36, hit: null, create: null,
    note: 'MiniMax M2.7 official $1/$5 (converted at ¥7.2 → ¥7.2/¥36 per M; M3 is $0.30/$1.20)' },
  glm: { cur: 'CNY', in: 0.8, out: 2.8, hit: 0.23, create: null,
    note: 'GLM-5.3-Flash: 0.0008 / 0.0028 / cache hit 0.00023 CNY per 1k tokens' },
  kimi: { cur: 'CNY', in: 20, out: 100, hit: 2, create: 20,
    note: 'Kimi K3 official: in 20 / out 100 / cache write 20 / hit 2 CNY per M' },
  mimo: { cur: 'CNY', in: 1, out: 2, hit: 0.02, create: null,
    note: 'MiMo-V2.5 list price: hit 0.02 / in 1 / out 2 CNY per M (V2.6: see the official site)' },
  chatgpt: { cur: 'USD', in: 4, out: 20, hit: 0.4, create: null,
    note: 'GPT-5.6 Sol: $4 / $20, cached input $0.40 per M (promo price, officially listed through 2026-11)' },
  claude: { cur: 'USD', in: 2, out: 10, hit: 0.2, create: 2.5,
    note: 'Claude Sonnet 5: $2 / $10, cache read $0.20, 5-min cache write $2.5 per M' },
  gemini: { cur: 'USD', in: 1.5, out: 9, hit: 0.15, create: null,
    note: 'Gemini 3.5 Flash: $1.5 / $9, cached input $0.15 per M' },
  grok: { cur: 'USD', in: 2, out: 6, hit: 0.5, create: null,
    note: 'Grok 4.6: $2 / $6, cached input $0.50 per M' },
}

const nOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : null)

/**
 * Effective rates: custom values override the default field by field; blank
 * (null/undefined/missing) → falls back to the default; missing on both sides
 * → null (that field is not priced). 0 is a valid value (= that item is free).
 * Returns { cur, in, out, hit, create }, numbers or null.
 */
export function effectivePrices(pid, custom) {
  const d = DEFAULT_PRICES[pid] || {}
  const c = custom || {}
  const pick = (k) => (c[k] != null ? nOrNull(c[k]) : nOrNull(d[k]))
  return { cur: d.cur || 'CNY', in: pick('in'), out: pick('out'), hit: pick('hit'), create: pick('create') }
}

/**
 * Today's estimated spend (provider currency, per-1M rates):
 *   missed input × in + hit input × hit (a missing hit rate is charged at in,
 *   never underestimating) + output × out
 * Input is split at accumulation time by cache_hit_pct (see the widget's
 * trackUsage); cache write has no host data source so its tokens are always
 * missing → that item contributes 0 (the rate slot stays, ready for when the
 * host ships the breakdown). in/out missing → null (cannot estimate).
 */
export function estimateCost(tok, pr) {
  if (!tok || !pr) return null
  if (typeof pr.in !== 'number' || typeof pr.out !== 'number') return null
  const inTotal = Number(tok.in) || 0
  const inHit = Math.min(Number(tok.inHit) || 0, inTotal)
  const inPlain = inTotal - inHit
  const hitP = typeof pr.hit === 'number' ? pr.hit : pr.in
  const cost = (inPlain * pr.in + inHit * hitP + (Number(tok.out) || 0) * pr.out) / 1e6
  return cost
}

/** Token count formatting: 1234 → 1.2k, 1500000 → 1.5M. */
export function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return String(Math.round(v))
}

/**
 * Time-of-day pricing windows (three providers; rules checked against the
 * 2026-10 official announcements / community reports):
 * - deepseek: 2026-08-17 peak/off-peak pricing — weekdays 9:00-12:00 and
 *   14:00-18:00 are peak, everything else (including the 12-14 lunch break and
 *   the whole weekend) is off-peak, off-peak = peak ×0.5
 * - glm: Coding Plan credits — weekdays 14:00-18:00 peak at list price, all
 *   other hours 50% offset
 * - mimo: Token Plan night discount — 0:00-8:00 Beijing time costs 0.8x
 * discMult = multiplier applied to the configured rate inside off-peak
 * windows; isPeak(p) takes Beijing-time decimal hours.
 */
export const SCHEDULES = {
  deepseek: {
    discMult: 0.5, peakLabel: 'Prime time', discLabel: 'Grandmaster slot',
    note: 'Time windows (Beijing): weekdays 9-12/14-18 = Prime time, Grandmaster slot ×0.5 off-peak, weekends all day Grandmaster',
    isPeak: (p) => p.dow >= 1 && p.dow <= 5 &&
      ((p.h >= 9 && p.h < 12) || (p.h >= 14 && p.h < 18)),
  },
  glm: {
    discMult: 0.5, peakLabel: 'Full hours', discLabel: 'Freeloader slot',
    note: 'Time windows (Beijing): weekdays 14-18 = Full hours, Freeloader slot ×0.5 off-peak (Coding Plan credits offset 50%)',
    isPeak: (p) => p.dow >= 1 && p.dow <= 5 && p.h >= 14 && p.h < 18,
  },
  mimo: {
    discMult: 0.8, peakLabel: 'Bug hours', discLabel: 'Night-owl slot',
    note: 'Time windows (Beijing): Night-owl slot 0:00-8:00 ×0.8 (daytime stays Bug hours at list price)',
    isPeak: (p) => !(p.h >= 0 && p.h < 8),
  },
}

/** now → Beijing time { dow(0=Sunday), h(decimal hour) }; add 8h then read the UTC fields — local timezone ignored. */
function bj(now) {
  const t = new Date((now || new Date()).getTime() + 8 * 3600 * 1000)
  return { dow: t.getUTCDay(), h: t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600 }
}

/**
 * Current time-of-day state: no schedule for this provider → null, otherwise
 * { peak, mult, label, sc }.
 * mult: 1 at peak, discMult off-peak; label: window name (peak / off-peak / night…).
 */
export function scheduleState(pid, now) {
  const sc = SCHEDULES[pid]
  if (!sc) return null
  const peak = sc.isPeak(bj(now))
  return { peak, mult: peak ? 1 : sc.discMult, label: peak ? sc.peakLabel : sc.discLabel, sc }
}

/** Current time-of-day multiplier (no schedule → 1). */
export function scheduleMult(pid, now) {
  const s = scheduleState(pid, now)
  return s ? s.mult : 1
}

/**
 * Today's estimate (schedule aware): the base bucket is charged at list price
 * plus the d bucket (tokens booked inside an off-peak window) × discMult.
 * No d bucket, or no schedule for this provider → same value as estimateCost.
 * in/out rates missing → null (estimateCost semantics).
 */
export function dayEstimate(pid, tok, custom) {
  if (!tok) return null
  const pr = effectivePrices(pid, custom)
  const base = estimateCost(tok, pr)
  if (base == null) return null
  const sc = SCHEDULES[pid]
  const d = tok.d
  if (!sc || !d || (Number(d.in) <= 0 && Number(d.out) <= 0)) return base
  const dc = estimateCost(d, pr)
  return dc == null ? base : base + dc * sc.discMult
}
