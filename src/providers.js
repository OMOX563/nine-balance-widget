/**
 * nine-balance-widget — fetch templates for nine providers (multi-source)
 * ============================================================================
 * Structure and field semantics ported from dsh-whale-widget's API_TEMPLATES
 * (MIT © MeteorNOX), trimmed to this plugin's nine-provider roster; the mimo
 * template was written from live tests (the original had no such provider).
 *
 * Each provider's sources[] can host several fetch sources, with subscription
 * and pay-as-you-go split into their own rows:
 *   kind: 'balance' — pay-as-you-go real balance: balance.url + the json.remaining field path
 *   kind: 'quota'   — subscription quota: quota.url + window shapes (simple fields / windows array)
 *   kind: 'probe'   — liveness probe: probeUrl checks the key (the honest fallback when a vendor has no balance API)
 *
 * The source index doubles as the storage convention: idx=0 uses key.<pid> (zero migration for old configs), the rest key.<pid>.<sid>.
 *
 * Field path syntax (executor lives in balance.js): supports a.b[0].c plus an optional scale multiplier.
 * Three auth templates: 'Bearer {key}' / '{key}' (raw value, Zhipu style) / '' (no Authorization header).
 * headers = extra request headers (e.g. the Claude probe's x-api-key + anthropic-version); values support the {key} placeholder.
 */

/** Storage keys: the first source reuses key.<pid> (zero migration), the rest carry a source id suffix. */
export function srcKey(pid, idx, sid) {
  return idx === 0 ? 'key.' + pid : 'key.' + pid + '.' + sid
}
/** Today's-used observation keys: same convention (obs prefix) so already-accumulated history is kept. */
export function obsKey(pid, idx, sid) {
  return idx === 0 ? 'obs.' + pid : 'obs.' + pid + '.' + sid
}

export const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    sources: [
      {
        id: 'payg', label: 'Pay-as-you-go', kind: 'balance', currency: 'CNY',
        keyRef: 'DEEPSEEK_API_KEY',
        balance: {
          url: 'https://api.deepseek.com/user/balance',
          auth: 'Bearer {key}',
          json: { remaining: 'balance_infos[0].total_balance' },
        },
      },
    ],
    apiNote: 'DeepSeek has no subscription (Coding Plan) endpoint — /user/subscription and friends returned 404 when tested; pay-as-you-go balance only',
  },

  minimax: {
    name: 'MiniMax',
    sources: [
      {
        id: 'sub_cn', label: 'Subscription · CN', kind: 'quota', currency: 'CNY',
        keyRef: 'MINIMAX_API_KEY',
        // CN endpoint; tested with a real key on 2026-10-08, returns both the 5h/week windows.
        quota: {
          url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
          auth: 'Bearer {key}',
          json: {
            remainPct: 'model_remains[0].current_interval_remaining_percent',
            weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
            resetAtMs: 'model_remains[0].end_time',
          },
        },
        apiNote: 'Valid for Coding Plan subscription accounts only (resource-pack accounts get "no coding plan exists")',
      },
      {
        id: 'sub_intl', label: 'Subscription · Intl', kind: 'quota', currency: 'USD',
        keyRef: 'MINIMAX_INTL_API_KEY',
        quota: {
          url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
          auth: 'Bearer {key}',
          json: {
            remainPct: 'model_remains[0].current_interval_remaining_percent',
            weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
            resetAtMs: 'model_remains[0].end_time',
          },
        },
        apiNote: 'The international site (api.minimax.io) runs its own account system; keys are not interchangeable with the CN site',
      },
    ],
    apiNote: 'Pay-as-you-go balance is Admin Key only (/v1/account/balance; a plain API key gets 403 token_type_mismatch) → not wired up',
  },

  glm: {
    name: 'Zhipu GLM',
    sources: [
      {
        id: 'sub_cn', label: 'Subscription · CN', kind: 'quota', currency: 'CNY',
        keyRef: 'ZHIPU_API_KEY',
        // Zhipu's endpoint authenticates without Bearer (raw key); data.limits[] is a flat entry array and
        // the 5h window is not guaranteed to sit at [0] — pick by type(+unit): unit=3 → 5h, unit=6 → week.
        quota: {
          url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
          auth: '{key}',
          json: {
            windows: [
              {
                key: 'rolling', label: '5h',
                pick: { list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 3 },
                percent: 'percentage', resetAt: 'nextResetTime',
              },
              {
                key: 'weekly', label: 'Week',
                pick: { list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 6 },
                percent: 'percentage', resetAt: 'nextResetTime',
              },
            ],
          },
        },
        apiNote: 'Subscriptions (TOKENS_LIMIT) and top-up accounts (CREDIT_LIMIT) share this endpoint, detected by type; there is no public API for the pay-as-you-go balance amount (all candidate paths 404 when tested)',
      },
      {
        id: 'sub_intl', label: 'Subscription · Intl', kind: 'quota', currency: 'USD',
        keyRef: 'ZHIPU_INTL_API_KEY',
        quota: {
          url: 'https://api.z.ai/api/monitor/usage/quota/limit',
          auth: '{key}',
          json: {
            windows: [
              {
                key: 'rolling', label: '5h',
                pick: { list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 3 },
                percent: 'percentage', resetAt: 'nextResetTime',
              },
              {
                key: 'weekly', label: 'Week',
                pick: { list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 6 },
                percent: 'percentage', resetAt: 'nextResetTime',
              },
            ],
          },
        },
        apiNote: 'The international site z.ai runs its own account system; keys are not interchangeable with the CN site',
      },
    ],
    apiNote: 'No public endpoint for pay-as-you-go (top-up) balance; all four candidate paths returned 404 on 2026-10-10',
  },

  kimi: {
    name: 'Kimi / Moonshot',
    sources: [
      {
        id: 'payg_cn', label: 'Pay-as-you-go · CN', kind: 'balance', currency: 'CNY',
        keyRef: 'MOONSHOT_API_KEY',
        // Mainland site: balance in CNY (top-ups + vouchers combined); the original v724 template returned 200 with the field matched.
        balance: {
          url: 'https://api.moonshot.cn/v1/users/me/balance',
          auth: 'Bearer {key}',
          json: { remaining: 'data.available_balance' },
        },
      },
      {
        id: 'coding', label: 'Subscription · Kimi Coding', kind: 'quota', currency: 'CNY',
        keyRef: 'KIMI_CODING_KEY',
        // Original template (v724): usage.remaining/limit is the remaining/limit pair, resetTime is the reset instant.
        quota: {
          url: 'https://api.kimi.com/coding/v1/usages',
          auth: 'Bearer {key}',
          json: { remain: 'usage.remaining', total: 'usage.limit', resetAt: 'usage.resetTime' },
        },
        apiNote: 'Kimi Coding uses its own key (from the kimi.com/code console); not interchangeable with the Moonshot API key',
      },
      {
        id: 'payg_intl', label: 'Pay-as-you-go · Intl', kind: 'balance', currency: 'USD',
        keyRef: 'MOONSHOT_INTL_API_KEY',
        balance: {
          url: 'https://api.moonshot.ai/v1/users/me/balance',
          auth: 'Bearer {key}',
          json: { remaining: 'data.available_balance' },
        },
        apiNote: 'The international site (api.moonshot.ai) runs its own account system; balance is quoted in USD',
      },
    ],
  },

  mimo: {
    name: 'Xiaomi MiMo（token-plan）',
    sources: [
      {
        id: 'probe', label: 'Probe', kind: 'probe', currency: 'CNY',
        keyRef: 'MIMO_TOKENPLAN_KEY',
        probeUrl: 'https://token-plan-cn.xiaomimimo.com/v1/models',
        auth: 'Bearer {key}',
        // Written from scratch: on 2026-10-08 every common balance path on the token-plan endpoint 404'd and the response headers carried no quota fields;
        // on 2026-10-10 eight more paths (dashboard/billing, user/account balance…) were retested and still all 404.
        apiNote: 'The token-plan endpoint has no balance/billing API (12 paths across two rounds, all 404) → balance shows "—", today\'s usage is estimated per session',
      },
    ],
    apiNote: 'The token-plan endpoint has no balance/billing API (12 paths across two rounds, all 404)',
  },

  chatgpt: {
    name: 'OpenAI / ChatGPT',
    sources: [
      {
        id: 'probe', label: 'Probe', kind: 'probe', currency: 'USD',
        keyRef: 'OPENAI_API_KEY',
        probeUrl: 'https://api.openai.com/v1/models',
        auth: 'Bearer {key}',
        apiNote: 'The official billing balance endpoint is gone; there is no public "check balance with an API key" API → balance shows "—", today\'s usage is estimated per session',
      },
    ],
    matchIds: ['gpt', 'o1-', 'o3-', 'o4-', 'chatgpt'],
    apiNote: 'Pay-as-you-go spend requires an Admin Key (an OpenAI admin key from the console) for GET /v1/organization/costs → not wired up; a regular key can only be probed',
  },

  claude: {
    name: 'Anthropic Claude',
    sources: [
      {
        id: 'probe', label: 'Probe', kind: 'probe', currency: 'USD',
        keyRef: 'ANTHROPIC_API_KEY',
        probeUrl: 'https://api.anthropic.com/v1/models',
        // The probe needs both x-api-key and anthropic-version headers (added 2026-10-10; there was no probe before).
        headers: { 'x-api-key': '{key}', 'anthropic-version': '2023-06-01' },
        apiNote: 'HTTP 200 means the key works; balance/spend needs an Admin Key (cost_report) → not wired up',
      },
    ],
    matchIds: ['claude'],
    apiNote: 'No official balance API; usage goes through the Admin API (an Anthropic admin key from the console) or the console UI',
  },

  gemini: {
    name: 'Google Gemini',
    sources: [
      {
        id: 'probe', label: 'Probe', kind: 'probe', currency: 'USD',
        keyRef: 'GEMINI_API_KEY',
        probeUrl: 'https://generativelanguage.googleapis.com/v1beta/models?key={key}',
        auth: '',
        apiNote: 'No official balance API (quota lives in the AI Studio / Cloud console) → balance shows "—", today\'s usage is estimated per session; the probe uses the ?key= form',
      },
    ],
    matchIds: ['gemini'],
    apiNote: 'No official balance API (quota lives in the AI Studio / Cloud console)',
  },

  grok: {
    name: 'xAI Grok',
    sources: [
      {
        id: 'probe', label: 'Probe', kind: 'probe', currency: 'USD',
        keyRef: 'XAI_API_KEY',
        probeUrl: 'https://api.x.ai/v1/models',
        auth: 'Bearer {key}',
        apiNote: 'No public balance API (quota lives in console.x.ai) → balance shows "—", today\'s usage is estimated per session',
      },
    ],
    matchIds: ['grok'],
    apiNote: 'No public balance API (quota lives in console.x.ai)',
  },
}

/** Stable order of the nine providers (settings page and widget display order). */
export const PROVIDER_ORDER = [
  'deepseek', 'minimax', 'glm', 'kimi', 'mimo', 'chatgpt', 'claude', 'gemini', 'grok',
]

/** Source tier (for the UI badge): balance = real balance / quota = subscription quota / probe = probe. */
export function sourceTier(s) {
  if (s && s.kind === 'balance') return 'balance'
  if (s && s.kind === 'quota') return 'quota'
  return 'probe'
}
