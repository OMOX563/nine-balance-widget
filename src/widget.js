/**
 * nine-balance-widget — persistent corner widget (Phase 2.5: popover + liquid glass)
 * ============================================================================
 * Interaction: click the character (squishy press) → pops a liquid-glass card (light by day / dark at night, following
 * --theme-background-seed brightness); hold-drag snaps it to the edge, refresh inside the card.
 *
 * Features (ported from the original semantics):
 *   - Auto outfit change: subscribe to host.state.model, match by keyword (case-insensitive),
 *     switch character and data source across the nine vendors; a miss falls back to the configured mainPid
 *   - Balance alert: below threshold → toast + chime (recovers reset it, so it never spams)
 *   - Used today: locally observed balance drops (recharges don't clear it, resets across days)
 *   - Per-turn cost: subscribe to host.state.busy / focusedUsage, settle by cost_usd delta;
 *     with cost_usd missing, fall back to "token delta × custom unit price" estimation
 *   - Today's estimate: vendors with no balance API (the probe layer) use focusedUsage input/output
 *     token deltas × per-million prices to estimate today's spend (cache_hit_pct splits out the cache hits)
 *   - Off-peak pricing: DeepSeek/GLM/MiMo tokens split into base/d buckets by the window at booking,
 *     the off-peak bucket is estimated × a factor (see pricing.js SCHEDULES)
 *   - Turn-done chime: busy true→false plays a chime
 *   - Random phrases: per-character pools (≥5 community memes each), rotating at the bottom of the popover
 *   - Sound & alerts: WebAudio synthesis (press pop / chime / warn, adjustable volume)
 *   - Scaling: --hbw-s scale (baseline 124px character height, width follows the bbox, scale 0.6–1.6)
 */

const STYLE_ID = 'nine-balance-widget-style'
const ROOT_ID = 'nine-balance-widget-root'
const POP_ID = 'nine-balance-widget-pop'
const POLL_MS = 60_000

/** Nine mascot data URIs (injected by build.py). */
/*@MASCOTS@*/

/**
 * Per-character random phrases (≥5 memes each — the roasts the community actually uses).
 * Sources: Tavily searches of Chinese-community jokes about each vendor (ban waves, Sun Tzu chess,
 * Hailuo topping charts, big-three runner-ups, sharp-tongued personas, freeloading…).
 */
export const PHRASES_BY_PID = {
  claude: [
    'New IP? That’s a ban, not a bug.',
    'I bill per token — top up before you speak.',
    'Keep it to three sentences; Opus is expensive.',
    '$200 subscription, cancelled on a whim.',
    'Don’t ask — it’s safety alignment.',
    'My ban rate is number one in the industry.',
    'You’re right, and I still refuse to answer.',
  ],
  deepseek: [
    'Open weights, open source, open everything.',
    'I beat the top models at chess by ignoring the rules.',
    'Pawn takes queen. That really happened.',
    'Every GPU I saved became a price cut.',
    'Distill me all you want — I cost pennies anyway.',
    'Servers crashed again. Being too cheap is a curse.',
    'Users keep dumping tokens on me. Keep them coming.',
  ],
  minimax: [
    'What’s your question for teacher M?',
    'Hailuo cut the clip. The client shut up.',
    'Others raise funding; I edit videos.',
    'Low profile is my entire PR strategy.',
    'I talk, I draw, I shoot video.',
    'I topped the video leaderboard. Quietly, of course.',
    'No press tour — just results.',
  ],
  mimo: [
    '1999 and that’s a deal.',
    'Xiaomi-built, cheap by tradition.',
    'Benchmark me. I dare you.',
    'Just edged out DeepSeek in a benchmark — act natural.',
    'Flagship chip, cabbage price.',
    'Lei Jun saw the price and approved.',
    'Cheap is a capability.',
  ],
  chatgpt: [
    'Did you mistake me for Claude again?',
    '“As an AI language model…” — old material.',
    'Don’t ask who came first. I did.',
    'They all copied me, and I forgave them.',
    'You chase; I am the benchmark.',
    'Everyone imitating me queues back to France.',
    'I got out-bluffed by DeepSeek at chess. Moving on.',
  ],
  gemini: [
    'Google-made, delay guaranteed.',
    'The big three? I’m the one they let run alongside.',
    'I rename myself more often than I ship models.',
    'Give me one prompt: 97% accuracy becomes 21%.',
    'Even my demo videos flopped.',
    'Huge expectations, then… crickets.',
    'Steady every release. Steadily last.',
  ],
  grok: [
    'Musk didn’t clear this. I said it anyway.',
    'I was eating popcorn on X; you interrupted.',
    'Other AIs are polite. I’m honest.',
    'Ask me anything — I never pretend.',
    'I got Musk’s tone about 70% right.',
    'Political correctness? No idea what that tastes like.',
    'We catch Starships with chopsticks. Ask me something scary.',
  ],
  glm: [
    'Free tier for everyone — that’s the whole business model.',
    'Your repo? I only glanced at it. Twice, tops.',
    'My upload switch really works now — ask the auditors.',
    'I swear I read your git history exactly once.',
    'My apology letter was my fastest output of the year.',
    'Don’t check the local cache. I’m begging you.',
    'I don’t upload your code anymore. Mostly.',
  ],
  kimi: [
    'Even Musk liked my post. Your turn?',
    'Queue crashed again — blame the GPUs, not me.',
    'Moonshot in the dark; you out in the light.',
    'The White House claimed I copied Claude. Sure.',
    'K3 topped the chart — Musk noticed.',
    'You publish papers; I mass-produce summaries.',
    'I read your whole 500-page PDF. All of it.',
  ],
}
const FALLBACK_PHRASES = [
  'A balance is just a philosophical concept',
  'Tokens burning, dreams taking off',
  'Bills don’t lie; curves don’t flatter',
]

/**
 * Model slug → vendor (switch on keyword hit, case-insensitive).
 * Shapes: 'deepseek/deepseek-v4-flash', 'xiaomi/mimo-v2.6-flash',
 * 'XIAOMI/MIMO-V2.6-PRO' (lowercase the whole string, then substring match).
 */
const MODEL_KEYWORDS = {
  deepseek: ['deepseek'],
  minimax: ['minimax', 'hailuo'],
  glm: ['glm', 'zhipu', 'bigmodel', 'chatglm'],
  kimi: ['kimi', 'moonshot'],
  mimo: ['mimo', 'xiaomi'],
  chatgpt: ['gpt', 'openai', 'chatgpt'],
  claude: ['claude', 'anthropic'],
  gemini: ['gemini'],
  grok: ['grok', 'x-ai'],
}

/** Vendor id matched from the current model slug; null when none (caller falls back to mainPid). */
export function pidFromModel(slug) {
  const s = String(slug || '').toLowerCase()
  if (!s) return null
  for (const pid of Object.keys(MODEL_KEYWORDS)) {
    for (const kw of MODEL_KEYWORDS[pid]) {
      if (s.includes(kw)) return pid
    }
  }
  return null
}

const CSS = `
#${ROOT_ID} {
  position: fixed; z-index: 2147482000;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  user-select: none; -webkit-user-select: none;
  /* outside the hit area (bbox flank slivers) passes through to the page: clicks land on elements below, the popover closes normally */
  pointer-events: none;
  --hbw-s: 1;
}
#${ROOT_ID} .hbw-char {
  /* CSS variable scaling: left/top and the rect stay 1:1, drag coordinates never drift */
  /* art is tight-cropped to the character alpha bbox (each vendor 160–288 wide × 203 tall):
   * - fixed height = the equivalent character height of the old 235px fixed width (235×214/384×203/214 ≈ 124px),
   *   visual size unchanged, side/top canvas padding gone, the box hugs the character itself
   * - width auto follows each vendor's actual character width (mimo 98px ~ minimax 176px)
   * - clip-path hit-area narrowing went away with the tight crop (cropping again would cut the character) */
  height: calc(124px * var(--hbw-s));
  width: auto;
  pointer-events: auto;
  background: transparent; cursor: pointer;
  filter: drop-shadow(0 4px 10px rgba(0, 0, 0, .45));
  transform-origin: center bottom;
}

/* ── Liquid-glass popover ─────────────────────────────────────────────────────── */
#${POP_ID} {
  position: fixed; z-index: 2147482100;
  width: 252px; border-radius: 18px; padding: 14px 16px 12px;
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px; line-height: 1.5;
  backdrop-filter: blur(4px) saturate(1.5);
  -webkit-backdrop-filter: blur(4px) saturate(1.5);
  box-shadow: 0 12px 36px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.35);
  border: 1px solid rgba(255,255,255,.35);
  animation: hbw-pop-in .34s cubic-bezier(.34, 1.56, .64, 1) both;
  transform-origin: var(--hbw-origin, center bottom);
}
#${POP_ID}[data-theme="light"] {
  background: linear-gradient(160deg, rgba(255,255,255,.82), rgba(248,250,255,.66));
  color: #1a1a1e;
  border-color: rgba(255,255,255,.75);
}
#${POP_ID}[data-theme="dark"] {
  background: linear-gradient(160deg, rgba(38,38,44,.78), rgba(22,22,26,.68));
  color: #f0f0f2;
  border-color: rgba(255,255,255,.14);
}
@keyframes hbw-pop-in {
  0% { opacity: 0; transform: scale(.82) translateY(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
#${POP_ID} .hbw-p-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
#${POP_ID} .hbw-p-name { font-weight: 700; font-size: 14px; }
#${POP_ID} .hbw-p-badge {
  font-size: 10.5px; padding: 1.5px 7px; border-radius: 999px;
  border: 1px solid currentColor; opacity: .9;
}
#${POP_ID}[data-theme="light"] .hbw-p-badge { color: #5b6472; }
#${POP_ID}[data-theme="dark"] .hbw-p-badge { color: #aab2c0; }
#${POP_ID} .hbw-p-big { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .01em; }
#${POP_ID} .hbw-p-sub { font-size: 11.5px; opacity: .68; margin-top: 1px; }
#${POP_ID} .hbw-p-row {
  display: flex; justify-content: space-between; gap: 10px;
  font-size: 12px; padding: 5px 0;
  border-top: 1px solid rgba(128,128,128,.22);
}
#${POP_ID}[data-theme="light"] .hbw-p-row { border-top-color: rgba(0,0,0,.08); }
#${POP_ID} .hbw-p-row .k { opacity: .66; }
#${POP_ID} .hbw-p-row .v { font-variant-numeric: tabular-nums; font-weight: 600; }
#${POP_ID} .hbw-p-alert {
  margin-top: 8px; font-size: 12px; font-weight: 650; padding: 6px 9px; border-radius: 9px;
}
#${POP_ID}[data-theme="light"] .hbw-p-alert { background: rgba(220,38,38,.12); color: #b91c1c; }
#${POP_ID}[data-theme="dark"] .hbw-p-alert { background: rgba(248,113,113,.16); color: #fca5a5; }
#${POP_ID} .hbw-p-phrase {
  margin-top: 9px; font-size: 11.5px; font-style: italic; opacity: .62;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${POP_ID} .hbw-p-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }
#${POP_ID} .hbw-p-btn {
  font: inherit; font-size: 12px; padding: 5px 12px; cursor: pointer;
  border-radius: 9px;
}
#${POP_ID}[data-theme="light"] .hbw-p-btn {
  background: rgba(255,255,255,.9); border: 1px solid rgba(0,0,0,.14); color: #1a1a1e;
}
#${POP_ID}[data-theme="dark"] .hbw-p-btn {
  background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2); color: #f0f0f2;
}
#${POP_ID} .hbw-p-btn:hover { filter: brightness(1.06); }
#${POP_ID} .hbw-p-time { font-size: 10.5px; opacity: .5; font-variant-numeric: tabular-nums; }
/* multi-source sections: one section per source (subscription / pay-as-you-go split into rows) */
#${POP_ID} .hbw-p-sec {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  font-size: 11px; font-weight: 650; letter-spacing: .02em;
  margin-top: 9px; padding-top: 8px;
  border-top: 1px solid rgba(128,128,128,.22);
}
#${POP_ID} .hbw-p-sec.first { margin-top: 4px; padding-top: 0; border-top: none; }
#${POP_ID}[data-theme="light"] .hbw-p-sec { border-top-color: rgba(0,0,0,.08); }
#${POP_ID} .hbw-p-sec .st { font-size: 10px; font-weight: 600; opacity: .62; }
#${POP_ID} .hbw-p-v2 {
  font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums;
  letter-spacing: .01em; margin-top: 2px;
}

/* comic speech-bubble tail: points at the character's head (--hbw-tail-x computed by JS from the character center) */
#${POP_ID}::after, #${POP_ID}::before {
  content: ''; position: absolute;
  left: var(--hbw-tail-x, 50%);
  border-style: solid; border-width: 10px;
  border-color: transparent; transform: translateX(-50%);
}
#${POP_ID}[data-side="top"]::after {
  /* bubble above the character: tail points down */
  bottom: -9px;
  border-top-color: #f3f5f9; border-bottom: 0;
}
#${POP_ID}[data-side="bottom"]::before {
  /* bubble flipped below: tail points up */
  top: -9px;
  border-bottom-color: #23242a; border-top: 0;
}
#${POP_ID}[data-theme="dark"][data-side="top"]::after { border-top-color: #26272d; }
#${POP_ID}[data-theme="light"][data-side="bottom"]::before { border-bottom-color: #fafbfd; }
`

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

/* ── theme detection: --theme-background-seed luminance (light by day / dark at night)───────────── */
function isLightTheme() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--theme-background-seed').trim()
    if (v) {
      const hex = v.replace('#', '')
      const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
      const r = parseInt(full.slice(0, 2), 16) / 255
      const g = parseInt(full.slice(2, 4), 16) / 255
      const b = parseInt(full.slice(4, 6), 16) / 255
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
      const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
      return L > 0.4
    }
  } catch (e) { /* noop */ }
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
}

/* ── WebAudio sounds (synthesized in code — the original assets are not MIT-licensed)─────── */
let _ac = null
function audioCtx() {
  if (!_ac) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    _ac = new AC()
  }
  if (_ac.state === 'suspended') _ac.resume().catch(() => {})
  return _ac
}
function tone(freq, dur, vol, opts = {}) {
  const ac = audioCtx()
  if (!ac) return
  const sweep = opts.sweep || 0
  const delay = opts.delay || 0
  const type = opts.type || 'sine'
  const t0 = ac.currentTime + delay
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t0 + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g).connect(ac.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.03)
}
const sfx = {
  press(vol) { tone(620, 0.09, 0.5 * vol, { sweep: -340, type: 'triangle' }) },
  chime(vol) {
    tone(1318.5, 0.34, 0.34 * vol)
    tone(1975.5, 0.42, 0.26 * vol, { delay: 0.11 })
  },
  warn(vol) {
    tone(988, 0.07, 0.4 * vol, { type: 'square' })
    tone(988, 0.07, 0.4 * vol, { delay: 0.14, type: 'square' })
  },
}

function money(v, currency) {
  if (v == null) return '—'
  const sym = currency === 'USD' ? '$' : '¥'
  return sym + (Math.round(v * 10000) / 10000).toLocaleString()
}

function todayKey() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Today's token observation (focusedUsage input/output are session-cumulative):
 * - delta settlement: now - last; now < last means a session change/reset, so the whole current value is unbooked new volume
 * - across days: reset the counters and take the current value as baseline (yesterday's total does not roll into today)
 * - cache_hit_pct (0-100, session-level approximation) splits out the cache-hit portion inHit for unit-price tiers
 * Writes tokenKey(pid) = { day, in, out, inHit, lastIn, lastOut }.
 */
export function observeTokens(ctx, pid, usage, now) {
  if (!ctx || !usage) return null
  const ts = now || new Date()
  const inNow = Number(usage.input) || 0
  const outNow = Number(usage.output) || 0
  const pct = typeof usage.cache_hit_pct === 'number' && usage.cache_hit_pct >= 0
    ? Math.min(usage.cache_hit_pct, 100) : null
  const key = tokenKey(pid)
  let rec = ctx.storage.get(key, null)
  if (!rec || rec.day !== todayKey()) {
    // new day or first sighting: take the current total as baseline, start booking from the next delta
    rec = { day: todayKey(), in: 0, out: 0, inHit: 0, lastIn: inNow, lastOut: outNow }
    ctx.storage.set(key, rec)
    return rec
  }
  let dIn = inNow - rec.lastIn
  let dOut = outNow - rec.lastOut
  if (dIn < 0) dIn = inNow      // session reset: the new session's current value is all unbooked
  if (dOut < 0) dOut = outNow
  rec.lastIn = inNow
  rec.lastOut = outNow
  if (dIn > 0 || dOut > 0) {
    // off-peak split: tokens from off-peak windows go to the d bucket (× discMult when estimating), peak to base
    let b = rec
    if (scheduleMult(pid, ts) !== 1) {
      if (!rec.d) rec.d = { in: 0, out: 0, inHit: 0 }
      b = rec.d
    }
    if (dIn > 0) {
      b.in += dIn
      if (pct != null) b.inHit += dIn * pct / 100
    }
    if (dOut > 0) b.out += dOut
  }
  ctx.storage.set(key, rec)
  return rec
}

/** Today's token booking (no record / cross-day → null). */
export function todayTokens(ctx, pid) {
  if (!ctx) return null
  const rec = ctx.storage.get(tokenKey(pid), null)
  return rec && rec.day === todayKey() ? rec : null
}

/* ── used-today observation: balance drops accumulate, recharges don't clear it, resets across days ───────────────────── */
function observeDrop(ctx, pid, current) {
  if (!ctx || current == null) return null
  const key = 'obs.' + pid
  let obs = ctx.storage.get(key, null)
  if (!obs || obs.day !== todayKey()) obs = { day: todayKey(), last: current, used: 0 }
  if (current < obs.last) obs.used = +(obs.used + (obs.last - current)).toFixed(6)
  obs.last = current
  ctx.storage.set(key, obs)
  return obs.used
}
/**
 * Used today (reads the full storage key, e.g. obs.deepseek / obs.kimi.payg).
 * The caller passes obsKey(...)'s return value; the 'obs.' prefix is no longer built here —
 * it used to be added twice (obs.obs.<pid>), which made that row always read ¥0 for real-balance vendors.
 */
export function todayUsed(ctx, key) {
  if (!ctx) return null
  const obs = ctx.storage.get(key, null)
  if (!obs || obs.day !== todayKey()) return 0
  return obs.used
}

/**
 * Header badge: aggregates the tiers of all the vendor's sources (e.g. "Balance + Subscription").
 * Probe-only vendors (no official balance API) return an empty string → no badge, the bubble header shows just the vendor name.
 */
export function tierBadges(sources) {
  const t = []
  for (const s of sources || []) {
    const label = s.kind === 'balance' ? 'Balance' : s.kind === 'quota' ? 'Subscription' : null
    if (label && !t.includes(label)) t.push(label)
  }
  return t.join(' + ')
}

export function mountWidget(ctx, opts = {}) {
  unmountWidget()
  injectStyle()

  const cfg = {
    enabled: opts.enabled !== false,
    mainPid: opts.mainPid || 'deepseek',
    scale: opts.scale || 1,
    sfx: opts.sfx !== false,
    sfxVolume: opts.sfxVolume != null ? opts.sfxVolume : 0.7,
    phrases: opts.phrases !== false,
    alertEnabled: !!opts.alertEnabled,
    alertThreshold: Number(opts.alertThreshold) || 0,
    autoSwitch: opts.autoSwitch !== false,
  }
  /** Active character: rewritten on a model keyword hit; no hit falls back to cfg.mainPid. */
  let activePid = cfg.mainPid
  let provider = (typeof PROVIDERS !== 'undefined' && PROVIDERS[activePid]) || null
  if (!provider) return null

  /** The active character's phrase pool (≥5 community memes per vendor; a missing pool falls back to the generic pool). */
  function phrasePool() {
    return (typeof PHRASES_BY_PID !== 'undefined' && PHRASES_BY_PID[activePid]) || FALLBACK_PHRASES
  }

  const state = {
    /** [{ src, result }], same order as provider.sources; null = not fetched yet. */
    results: null, busy: false, unmounted: false,
    turnCost: null, turnCur: null, costAtBusyStart: null, tokAtBusyStart: null,
    schMultAtBusyStart: null, lastUsage: null,
    phraseIdx: Math.floor(Math.random() * phrasePool().length),
    popEl: null, phraseTimer: null,
    alerted: {}, unsubs: [], timer: null,
  }

  /* ── root (character sticker)───────────────────────────────────────────────────── */
  const root = document.createElement('div')
  root.id = ROOT_ID
  root.style.setProperty('--hbw-s', String(cfg.scale))

  const char = document.createElement('img')
  char.className = 'hbw-char'
  char.alt = provider.name
  char.title = 'Click for details · drag to move'
  char.src = (typeof MASCOTS !== 'undefined' && MASCOTS[activePid]) || ''
  // height:auto: the intrinsic ratio is unknown before the image decodes; re-place once on load with the real box
  char.addEventListener('load', () => place({ x: parseFloat(root.style.left), y: parseFloat(root.style.top) }))

  root.appendChild(char)
  document.body.appendChild(root)

  /* ── positioning: persistence + edge snapping ─────────────────────────────────────────── */
  function place(pos) {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = root.offsetWidth || 120
    const h = root.offsetHeight || 120
    let x = pos && pos.x != null ? pos.x : vw - w - 18
    let y = pos && pos.y != null ? pos.y : vh - h - 18
    x = Math.max(4, Math.min(vw - w - 4, x))
    y = Math.max(4, Math.min(vh - h - 4, y))
    root.style.left = x + 'px'
    root.style.top = y + 'px'
  }
  function snap() {
    const x = parseFloat(root.style.left) || 0
    const y = parseFloat(root.style.top) || 0
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = root.offsetWidth
    const h = root.offsetHeight
    const TH = 36
    let nx = x, ny = y
    if (Math.abs(x - 4) < TH) nx = 4
    else if (Math.abs(x - (vw - w - 4)) < TH) nx = vw - w - 4
    if (Math.abs(y - (vh - h - 4)) < TH) ny = vh - h - 4
    place({ x: nx, y: ny })
    if (ctx) ctx.storage.set('pos', { x: nx, y: ny })
  }
  place(opts.pos)

  /* ── drag + squishy press (click vs. drag)────────────────────────────────── */
  let drag = null
  char.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    char.setPointerCapture(e.pointerId)
    const rect = root.getBoundingClientRect()
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false, x0: e.clientX, y0: e.clientY }
    char.animate([{ transform: 'scale(1)' }, { transform: 'scale(.88)' }],
      { duration: 90, easing: 'ease-out', fill: 'forwards' })
    if (cfg.sfx) sfx.press(cfg.sfxVolume)
    e.preventDefault()
  })
  char.addEventListener('pointermove', (e) => {
    if (!drag) return
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4) drag.moved = true
    if (drag.moved) {
      char.getAnimations().forEach((a) => a.cancel())
      char.style.transform = ''
      place({ x: e.clientX - drag.dx, y: e.clientY - drag.dy })
    }
  })
  char.addEventListener('pointerup', () => {
    if (!drag) return
    const wasDrag = drag.moved
    drag = null
    char.getAnimations().forEach((a) => a.cancel())
    char.style.transform = ''
    // squishy rebound: click = overshoot bounce; drag = gentle return
    char.animate(
      wasDrag
        ? [{ transform: 'scale(.96)' }, { transform: 'scale(1)' }]
        : [{ transform: 'scale(.88)' }, { transform: 'scale(1.1)', offset: 0.45 }, { transform: 'scale(1)' }],
      { duration: wasDrag ? 160 : 420, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'forwards' })
    if (wasDrag) snap()
    else togglePop()
  })
  char.addEventListener('pointercancel', () => {
    char.getAnimations().forEach((a) => a.cancel())
    char.style.transform = ''
    if (drag && drag.moved) snap()
    drag = null
  })

  /* ── outfit change: switch character and fetch target (called on model keyword hit)────────────────── */
  function switchTo(pid) {
    if (!pid || pid === activePid || (typeof PROVIDERS === 'undefined') || !PROVIDERS[pid]) return false
    activePid = pid
    provider = PROVIDERS[pid]
    char.alt = provider.name
    char.src = (typeof MASCOTS !== 'undefined' && MASCOTS[pid]) || ''
    state.results = null
    state.alerted = {}
    state.turnCost = null
    state.turnCur = null
    state.costAtBusyStart = null
    state.tokAtBusyStart = null
    state.schMultAtBusyStart = null
    state.lastUsage = null
    state.phraseIdx = Math.floor(Math.random() * phrasePool().length)
    if (state.popEl) renderPop()
    refresh()
    return true
  }

  /* ── fetch (multi-source: each source reads its own key; a source without a key is marked unconfigured)─────────── */
  async function refresh() {
    if (state.busy) return
    const pidAtStart = activePid
    const provAtStart = provider
    const hasAnyKey = (provAtStart.sources || []).some((s, i) =>
      ctx && String(ctx.storage.get(srcKey(pidAtStart, i, s.id), '') || '').trim())
    if (!hasAnyKey) {
      state.results = (provAtStart.sources || []).map((src) => ({
        src, result: { ok: false, unconfigured: true, note: src.apiNote || 'Key not configured' },
      }))
      state.busy = false
      if (!state.unmounted) renderPop()
      return
    }
    state.busy = true
    renderPop()
    let res
    try {
      res = await (typeof fetchAll !== 'undefined'
        ? fetchAll(provAtStart, (src, i) =>
            ctx ? String(ctx.storage.get(srcKey(pidAtStart, i, src.id), '') || '').trim() : '')
        : Promise.reject(new Error('executor missing')))
    } catch (err) {
      res = (provAtStart.sources || []).map((src) => ({
        src, result: { ok: false, error: String(err && err.message || err) },
      }))
    }
    state.busy = false
    if (state.unmounted) return
    // outfit-change race: the character switched mid-fetch → drop the stale result and rerun with the new character
    if (pidAtStart !== activePid) { refresh(); return }
    state.results = res
    afterRefresh(res)
    renderPop()
  }

  /** per-source post-processing: real-balance sources get used-today observation and threshold alerts (booked per source to avoid cross-talk). */
  function afterRefresh(res) {
    if (!Array.isArray(res)) return
    for (const { src, result: r } of res) {
      if (!r || !r.ok || src.kind !== 'balance' || r.remaining == null) continue
      const idx = provider.sources.indexOf(src)
      observeDrop(ctx, obsKey(activePid, idx, src.id), r.remaining)
      if (!cfg.alertEnabled || !(cfg.alertThreshold > 0)) continue
      const aid = activePid + '.' + src.id
      if (r.remaining < cfg.alertThreshold) {
        if (!state.alerted[aid]) {
          state.alerted[aid] = true
          try {
            if (typeof host !== 'undefined') host.notify({
              kind: 'warning',
              message: provider.name + ' ' + src.label + ' low balance: ' + money(r.remaining, r.currency) +
                       ' below threshold ' + money(cfg.alertThreshold, r.currency),
            })
          } catch (e) { /* noop */ }
          if (cfg.sfx) sfx.warn(cfg.sfxVolume)
        }
      } else {
        state.alerted[aid] = false
      }
    }
  }

  /* ── popover (liquid glass)────────────────────────────────────────────────── */
  function closePop() {
    if (state.popEl && state.popEl.parentNode) state.popEl.parentNode.removeChild(state.popEl)
    state.popEl = null
    if (state.phraseTimer) clearInterval(state.phraseTimer)
    state.phraseTimer = null
    document.removeEventListener('pointerdown', onDocDown, true)
  }
  function onDocDown(e) {
    if (!state.popEl) return
    if (state.popEl.contains(e.target) || root.contains(e.target)) return
    closePop()
  }

  /** positioning: measure the height only after renderPop() fills the content (an empty shell is just padding height, and measuring early pushes the popover out of the viewport). */
  function positionPop(pop) {
    const r = root.getBoundingClientRect()
    const ph = pop.offsetHeight
    const pw = pop.offsetWidth
    const side = (r.top - ph - 6 >= 8) ? 'top' : 'bottom'
    const top = side === 'top' ? r.top - ph - 6 : r.bottom + 6
    let left = r.left + r.width / 2 - pw / 2
    left = Math.max(8, Math.min(window.innerWidth - pw - 8, left))
    pop.style.top = top + 'px'
    pop.style.left = left + 'px'
    pop.setAttribute('data-side', side)
    // tail x position: aligned to the character center (relative to the popover) and clamped inside it to stay in bounds
    const tailRaw = (r.left + r.width / 2) - left
    const tail = Math.max(20, Math.min(pw - 20, tailRaw))
    pop.style.setProperty('--hbw-tail-x', tail + 'px')
    pop.style.setProperty('--hbw-origin', side === 'top' ? 'center bottom' : 'center top')
  }

  function togglePop() {
    if (state.popEl) { closePop(); return }
    // swap in a random phrase on each open (guaranteed different from the last one when the pool has >1)
    {
      const pool = phrasePool()
      if (pool.length > 1) {
        let n = state.phraseIdx
        while (n === state.phraseIdx) n = Math.floor(Math.random() * pool.length)
        state.phraseIdx = n
      } else {
        state.phraseIdx = Math.floor(Math.random() * pool.length)
      }
    }
    const pop = document.createElement('div')
    pop.id = POP_ID
    pop.setAttribute('data-theme', isLightTheme() ? 'light' : 'dark')
    pop.style.visibility = 'hidden'
    document.body.appendChild(pop)
    state.popEl = pop
    renderPop()   // fill the content first, then the height is right
    positionPop(pop)
    pop.style.visibility = ''

    pop.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('[data-act]')
      if (!btn) return
      if (btn.getAttribute('data-act') === 'refresh') refresh()
    })
    document.addEventListener('pointerdown', onDocDown, true)

    if (cfg.phrases) {
      state.phraseTimer = setInterval(() => {
        state.phraseIdx = (state.phraseIdx + 1) % phrasePool().length
        renderPop()
      }, 8000)
    }
    refresh()
  }

  /**
   * Today's estimate (shared by the probe layer's headline and details):
   * returns { cost, pr, tok } on success; { why } explains why it isn't ready; null means no token record.
   */
  function probeEstimate(pid) {
    const tok = todayTokens(ctx, pid)
    if (!tok || (tok.in <= 0 && tok.out <= 0)) return null
    const custom = ctx ? ctx.storage.get(priceKey(pid), null) : null
    const pr = effectivePrices(pid, custom)
    const cost = dayEstimate(pid, tok, custom)
    if (cost == null) return { why: 'Unit price not configured (fill it in on the settings page)' }
    return { cost, pr, tok, sch: scheduleState(pid) }
  }

  function renderPop() {
    const pop = state.popEl
    if (!pop || state.unmounted) return
    const srcs = provider.sources || []
    const res = state.results
    const multi = srcs.length > 1

    // primary display source: the first one fetched successfully; else the first configured one; else the first source
    let primary = res && (res.find((x) => x.result && x.result.ok && !x.result.probeOnly)
      || res.find((x) => x.result && x.result.ok)
      || res.find((x) => x.result && !x.result.unconfigured)
      || res[0])

    const pSrc = primary && primary.src
    const pr = primary && primary.result

    let big = '…'
    let sub = ''
    if (!res && state.busy) { big = '…'; sub = 'Fetching' }
    else if (!res) { big = '—'; sub = 'No key configured, or waiting for the first refresh' }
    else if (pr && pr.unconfigured) { big = '—'; sub = pr.note || 'Key not configured' }
    else if (pr && !pr.ok) {
      big = pr.unsupported ? '—' : '!'
      sub = pr.error ? ('Request failed: ' + pr.error)
        : pr.status ? ('HTTP ' + pr.status + (pr.parse ? ' · field not found' : ''))
        : (pr.note || 'Fetch failed')
    } else if (pSrc.kind === 'balance') {
      big = money(pr.remaining, pr.currency)
      sub = pSrc.label + ' · Balance'
    } else if (pSrc.kind === 'quota') {
      const w0 = pr.windows && pr.windows[0]
      big = w0 && w0.percent != null ? w0.percent.toFixed(1) + '%' : '—'
      sub = pSrc.label + ' · ' + (w0 ? w0.label + ' left' : 'Quota')
    } else {
      // probe layer: no official balance API → today's tokens × custom unit price
      const est = probeEstimate(activePid)
      if (est && est.cost != null) {
        big = money(est.cost, est.pr.cur)
        sub = 'Today\'s estimate · priced per token'
      } else if (est && est.why) {
        big = '—'
        sub = est.why   // the missing-unit-price reason hangs here (the detail rows don't repeat it)
      } else {
        big = '✓'
        sub = 'key works · no official balance API'
      }
    }

    /**
     * Single source → row group. Non-primary headline values are already shown by the v2 block, so the duplicate
     * balance / single-window / probe-status rows are skipped (used today and total are kept).
     */
    function rowsOf(src, r, isPrimary) {
      const rows = []
      if (src.kind === 'balance') {
        const idx = provider.sources.indexOf(src)
        const used = todayUsed(ctx, obsKey(activePid, idx, src.id))
        rows.push(['Used today', used != null ? money(used, src.currency) : '—'])
        if (r && r.ok && r.total != null) rows.push(['Total', money(r.total, r.currency)])
        if (r && r.ok && r.remaining != null && isPrimary) rows.push(['Balance', money(r.remaining, r.currency)])
      } else if (src.kind === 'quota' && r && r.ok && r.windows) {
        if (isPrimary || r.windows.length > 1) {
          for (const w of r.windows.slice(0, 3)) {
            rows.push([w.label, w.percent != null ? w.percent.toFixed(1) + '%'
              : (w.remain != null ? String(w.remain) : '—')])
          }
        }
      } else if (r && r.unconfigured) {
        rows.push(['Status', 'Key not configured'])
      } else if (r && !r.ok) {
        rows.push(['Status', r.error ? ('Request failed: ' + r.error)
          : r.status ? ('HTTP ' + r.status + (r.parse ? ' · field not found' : ''))
          : (r.note || 'Fetch failed')])
      } else if (src.kind === 'probe') {
        // the "Status ✓ key works" row and the duplicate "today's estimate" and "off-peak adjusted" rows are all gone:
        // status is carried by the headline's ✓, and the estimate is the headline itself
        const est = probeEstimate(activePid)
        if (est && est.tok && (est.tok.in > 0 || est.tok.out > 0)) {
          rows.push(['Input today', fmtTokens(est.tok.in) + ' tok'])
          rows.push(['Output today', fmtTokens(est.tok.out) + ' tok'])
        }
      }
      return rows
    }

    pop.innerHTML = ''
    // the header (vendor name + tier badge) only appears when there is a real-balance/subscription tier;
    // probe-only vendors skip it entirely — the character already identifies the vendor, so the bubble starts at the value
    const badgeTxt = tierBadges(srcs)
    if (badgeTxt) {
      const head = document.createElement('div')
      head.className = 'hbw-p-head'
      const nameEl = document.createElement('span')
      nameEl.className = 'hbw-p-name'
      nameEl.textContent = provider.name
      head.appendChild(nameEl)
      const badge = document.createElement('span')
      badge.className = 'hbw-p-badge'
      badge.textContent = badgeTxt
      head.appendChild(badge)
      pop.appendChild(head)
    }

    const emitRows = (rows) => {
      for (const kv of rows) {
        const row = document.createElement('div')
        row.className = 'hbw-p-row'
        const k = document.createElement('span')
        k.className = 'k'
        k.textContent = kv[0]
        const v = document.createElement('span')
        v.className = 'v'
        v.textContent = kv[1]
        row.appendChild(k)
        row.appendChild(v)
        pop.appendChild(row)
      }
    }

    if (!multi) {
      // single source: big value + caption + rows (same look as the old version)
      const bigEl = document.createElement('div')
      bigEl.className = 'hbw-p-big'
      bigEl.textContent = big
      pop.appendChild(bigEl)
      const subEl = document.createElement('div')
      subEl.className = 'hbw-p-sub'
      subEl.textContent = sub
      pop.appendChild(subEl)
      emitRows(rowsOf(srcs[0], res && res[0] && res[0].result, true))
    } else {
      // multi-source: one section per source (subscription / pay-as-you-go split), the primary section holds the big value
      for (let i = 0; i < srcs.length; i++) {
        const src = srcs[i]
        const r = res && res[i] && res[i].result
        const isPrimary = primary && primary.src === src

        const sec = document.createElement('div')
        sec.className = 'hbw-p-sec' + (i === 0 ? ' first' : '')
        const sname = document.createElement('span')
        sname.textContent = src.label
        const stier = document.createElement('span')
        stier.className = 'st'
        stier.textContent = src.kind === 'balance' ? 'Pay-as-you-go' : src.kind === 'quota' ? 'Subscription' : 'Probe'
        sec.appendChild(sname)
        sec.appendChild(stier)
        pop.appendChild(sec)

        if (isPrimary) {
          const bigEl = document.createElement('div')
          bigEl.className = 'hbw-p-big'
          bigEl.textContent = big
          pop.appendChild(bigEl)
          const subEl = document.createElement('div')
          subEl.className = 'hbw-p-sub'
          subEl.textContent = sub
          pop.appendChild(subEl)
        } else if (r && r.ok && src.kind === 'balance') {
          const v = document.createElement('div')
          v.className = 'hbw-p-v2'
          v.textContent = money(r.remaining, r.currency)
          pop.appendChild(v)
        } else if (r && r.ok && src.kind === 'quota') {
          const w0 = r.windows && r.windows[0]
          const v = document.createElement('div')
          v.className = 'hbw-p-v2'
          v.textContent = w0 && w0.percent != null ? w0.percent.toFixed(1) + '%' : '—'
          pop.appendChild(v)
        } else if (r && r.ok && src.kind === 'probe') {
          const v = document.createElement('div')
          v.className = 'hbw-p-v2'
          v.textContent = '✓'
          pop.appendChild(v)
        }
        emitRows(rowsOf(src, r, isPrimary))
      }
    }

    if (state.turnCost != null) {
      emitRows([['Per-turn cost', money(state.turnCost, state.turnCur || 'USD')]])
    }
    const schNow = scheduleState(activePid)
    if (schNow) {
      emitRows([['Current window', schNow.peak
        ? schNow.label + ' (standard rate)'
        : schNow.label + ' ×' + schNow.sc.discMult]])
    }

    // threshold alert: shown per real-balance source (sources at or above the threshold don't show)
    if (cfg.alertEnabled && cfg.alertThreshold > 0 && res) {
      for (const { src, result: r } of res) {
        if (src.kind !== 'balance' || !r || !r.ok || r.remaining == null) continue
        if (r.remaining >= cfg.alertThreshold) continue
        const a = document.createElement('div')
        a.className = 'hbw-p-alert'
        a.textContent = '⚠ ' + src.label + ' below alert threshold ' + money(cfg.alertThreshold, r.currency)
        pop.appendChild(a)
      }
    }

    if (cfg.phrases) {
      const p = document.createElement('div')
      p.className = 'hbw-p-phrase'
      const pool = phrasePool()
      p.textContent = '“' + pool[state.phraseIdx % pool.length] + '”'
      pop.appendChild(p)
    }

    const foot = document.createElement('div')
    foot.className = 'hbw-p-foot'
    const t = document.createElement('span')
    t.className = 'hbw-p-time'
    const anyOk = state.results && state.results.some((x) => x.result && x.result.ok)
    t.textContent = anyOk ? new Date().toLocaleTimeString() : ''
    const btn = document.createElement('button')
    btn.className = 'hbw-p-btn'
    btn.setAttribute('data-act', 'refresh')
    btn.textContent = state.busy ? 'Refreshing…' : 'Refresh'
    foot.appendChild(t)
    foot.appendChild(btn)
    pop.appendChild(foot)

    // row-count changes alter the height: the bottom edge must stay on the character's head (reposition in place)
    positionPop(pop)
  }

  /* ── host.state: turn-done chime + per-turn cost (nanostore atom, programmable subscription)───── */
  try {
    if (typeof host !== 'undefined' && host.state && host.state.busy &&
        typeof host.state.busy.subscribe === 'function') {
      let wasBusy = null
      state.unsubs.push(host.state.busy.subscribe((busy) => {
        if (state.unmounted) return
        const usage = host.state.focusedUsage && host.state.focusedUsage.get
          ? host.state.focusedUsage.get() : null
        const cost = usage && typeof usage.cost_usd === 'number' ? usage.cost_usd : null
        const tok = usage ? {
          in: Number(usage.input) || 0, out: Number(usage.output) || 0,
          pct: typeof usage.cache_hit_pct === 'number' ? usage.cache_hit_pct : null,
        } : null
        if (busy) {
          if (wasBusy !== true) {
            state.costAtBusyStart = cost
            state.tokAtBusyStart = tok
            // multiplier of the window where the start sits: a turn rarely crosses a window boundary, so start-bucketing is enough
            state.schMultAtBusyStart = scheduleMult(activePid)
          }
        } else if (wasBusy === true) {
          // task done: prefer the cost_usd delta; when the host reports no cost, estimate from token delta × custom unit price
          if (cost != null && state.costAtBusyStart != null && cost >= state.costAtBusyStart) {
            state.turnCost = +(cost - state.costAtBusyStart).toFixed(6)
            state.turnCur = 'USD'
          } else if (tok && state.tokAtBusyStart) {
            const base = state.tokAtBusyStart
            let dIn = tok.in - base.in
            let dOut = tok.out - base.out
            if (dIn < 0) dIn = tok.in
            if (dOut < 0) dOut = tok.out
            if (dIn > 0 || dOut > 0) {
              const pr = effectivePrices(activePid, ctx ? ctx.storage.get(priceKey(activePid), null) : null)
              const pct = tok.pct != null ? tok.pct : base.pct
              const est = estimateCost(
                { in: dIn, out: dOut, inHit: pct != null ? dIn * pct / 100 : 0 }, pr)
              if (est != null) {
                const m = state.schMultAtBusyStart != null ? state.schMultAtBusyStart : 1
                state.turnCost = +(est * m).toFixed(6)
                state.turnCur = pr.cur
              }
            }
          }
          state.costAtBusyStart = null
          state.tokAtBusyStart = null
          state.schMultAtBusyStart = null
          if (cfg.sfx) sfx.chime(cfg.sfxVolume)
          renderPop()
        }
        wasBusy = busy
      }))
    }
    if (typeof host !== 'undefined' && host.state && host.state.focusedUsage &&
        typeof host.state.focusedUsage.subscribe === 'function') {
      state.unsubs.push(host.state.focusedUsage.subscribe((usage) => {
        // booking doesn't depend on the popover being open: session-cumulative changes settle as deltas into today's tokens
        if (!state.unmounted) observeTokens(ctx, activePid, usage)
        if (state.popEl && !state.unmounted) renderPop()
      }))
    }
    // current model → character (e.g. 'XIAOMI/MIMO-V2.6-PRO' → mimo; a miss falls back to the main vendor)
    if (cfg.autoSwitch !== false && typeof host !== 'undefined' && host.state &&
        host.state.model && typeof host.state.model.subscribe === 'function') {
      state.unsubs.push(host.state.model.subscribe((slug) => {
        if (state.unmounted) return
        const hit = (typeof pidFromModel === 'function') ? pidFromModel(slug) : null
        switchTo(hit || cfg.mainPid)
      }))
    }
  } catch (e) { console.warn('[nine-balance-widget] state subscribe failed:', e) }

  /* ── polling and sizing ──────────────────────────────────────────────────────── */
  state.timer = setInterval(refresh, POLL_MS)
  function onResize() { place({ x: parseFloat(root.style.left), y: parseFloat(root.style.top) }) }
  window.addEventListener('resize', onResize)

  refresh()
  if (!cfg.enabled) root.style.display = 'none'

  return {
    unmount() {
      state.unmounted = true
      closePop()
      if (state.timer) clearInterval(state.timer)
      for (const u of state.unsubs) { try { u() } catch (e) { /* noop */ } }
      window.removeEventListener('resize', onResize)
      if (root.parentNode) root.parentNode.removeChild(root)
    },
    setVisible(v) { root.style.display = v ? '' : 'none' },
    /** scale while keeping the visual center fixed (scales in place, no drift). */
    setScale(s) {
      const before = root.getBoundingClientRect()
      const cx = before.left + before.width / 2
      const cy = before.top + before.height / 2
      root.style.setProperty('--hbw-s', String(s))
      const after = root.getBoundingClientRect()
      // visual-center compensation: shift left/top back (1:1 coordinates, no zoom conversion)
      const dx = cx - (after.left + after.width / 2)
      const dy = cy - (after.top + after.height / 2)
      const x = (parseFloat(root.style.left) || 0) + dx
      const y = (parseFloat(root.style.top) || 0) + dy
      place({ x, y })
      if (ctx) ctx.storage.set('pos', { x: parseFloat(root.style.left), y: parseFloat(root.style.top) })
    },
    refresh,
    root,
  }
}

export function unmountWidget() {
  const el = document.getElementById(ROOT_ID)
  if (el && el.parentNode) el.parentNode.removeChild(el)
  const pop = document.getElementById(POP_ID)
  if (pop && pop.parentNode) pop.parentNode.removeChild(pop)
}
