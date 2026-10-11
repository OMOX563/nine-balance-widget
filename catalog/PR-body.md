# Catalog submission — `plugin-catalog/nine-balance-widget.yaml`

Adds one entry to the Hermes plugin catalog:

```yaml
name: nine-balance-widget
repo: https://github.com/OMOX563/nine-balance-widget
sha: "b8652884a4f9c6d07c7e637991c09be6a645a87e"
tier: community
```

## What the plugin does

Nine AI provider balances in one desktop widget — live balance/usage and quota
reads across 13 fetch sources, token-based spend estimates with off-peak price
windows (Beijing time), drop alerts, auto character switching on model change,
and an anime mascot per provider with rotating flavour lines: DeepSeek, MiniMax,
GLM, Kimi, MiMo, ChatGPT, Claude, Gemini, Grok.

- **Desktop-only.** `desktop/plugin.js` inside the plugin SDK surface; the
  agent-side `__init__.py` is a no-op stub. Registers no tools, hooks,
  middleware or env vars (`requires_env` absent — keys are typed by the user in
  the settings page, not read from the environment).
- **Read-only against provider APIs.** The widget only calls the official
  balance/quota/health endpoints of the providers whose keys the user entered.
- **Keys never leave the machine.** Stored in plugin-scoped storage
  (`ctx.storage`); no `.env` / `auth.json` / credential-store reads, no shell,
  no background processes, no telemetry.
- **No self-updating code.** Static `desktop/plugin.js`; updates reach users
  only through a SHA-bump PR here.
- **Fully English** UI, README and meme pool (63 lines, 7 per provider).

## Disclosure (rule 13)

- Network calls: provider official APIs only (balance / quota / health checks),
  authenticated with the user's own keys.
- Reads outside the plugin's own data: none.
- Shell commands / long-running background processes: none.
- Stored credentials: provider API keys, entered in the settings page, held in
  plugin-scoped storage on the local machine.
- Telemetry / usage reporting: none.
- **Lineage:** English edition of `hermes-balance-widget`
  ([OMOX563/hermes-balance-widget](https://github.com/OMOX563/hermes-balance-widget),
  submitted separately), which is itself ported from
  [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
  (MIT © MeteorNOX). Same architecture, fully English UI, independently written
  meme pool; upstream credited in both READMEs and LICENSEs.

## Submission checklist

- [x] Owner-submitted (`OMOX563` owns the repo)
- [x] Public repository
- [x] Released (`v1.0.0` + GitHub release; `version` matches the pinned code)
- [x] Capabilities declared: none — the plugin registers no tools, hooks, or
      middleware; `requires_env` absent (keys are user-entered, not env)
- [x] `hermes plugins validate` passes (clean clone at the pinned SHA):
      manifest ✓ loadable ✓ capability probe ✓ security scan *safe* ✓
      no core override ✓ desktop surface ✓
- [x] Smoke suite green at the pinned SHA
- [x] No self-updating code; no core overrides; SDK-surface only

## Verify locally

```bash
hermes plugins install OMOX563/nine-balance-widget --enable
hermes plugins validate ~/.hermes/plugins/nine-balance-widget
```

Repo layout: `plugin.yaml` + agent-side `__init__.py` stub +
`desktop/plugin.js` (byte-identical to the released root `plugin.js`, emitted
by `build.py`).
