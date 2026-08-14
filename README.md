# opencode-model-fallback

**`@ghilteras/opencode-model-fallback`** — automatic model fallback plugin for [OpenCode](https://github.com/sst/opencode) 1.18+. When a model API call fails, the plugin transparently switches to the next model in a configured fallback chain and replays the request — no manual intervention required.

## What it does

- **Fallback chain** — per-agent or global ordered list of fallback models; on failure the plugin switches to the next model and replays the request
- **Non-transient only** — falls back only on *non-transient* errors (rate limit, quota, model-not-found, server error). Transient errors retry natively on the same provider — no cross-provider swap on a blip
- **402 / insufficient-balance non-retryable** — a 402 is a hard error, never a fallback trigger and never retried on another provider
- **Per-session stickiness** — once a session picks a model, it sticks to it (no mid-session thrashing)
- **prose-never-error** — model responses that are prose (not JSON tool output) never count as errors
- **TTFT timeout** — aborts models that produce no tokens within a configurable window; models actively streaming are never interrupted
- **Cooldown & auto-recovery** — failed models enter cooldown; the plugin automatically switches back to the primary once it recovers
- **Custom retryable patterns** — extend the built-in error matching with your own regex patterns

## Installation

```bash
bun add @ghilteras/opencode-model-fallback
```

Then add the plugin to your `opencode.json` plugin array:

```json
{
  "plugin": ["@ghilteras/opencode-model-fallback"]
}
```

> **Default-export-only rule** (opencode #42451): plugins must export a default export. This package exports ONLY `{ OpenCodeFallbackPlugin as default }` — do not expect named exports.

## Configuration

Fallback configuration lives in `.opencode/opencode-model-fallback.jsonc`:

```jsonc
{
  "fallback_models": [],
  "retry_on_errors": true,
  "small_model_chain": ["commandcode/xiaomi/mimo-v2.5", "opencode-go/mimo-v2.5"]
}
```

- `fallback_models` — global fallback chain (array of `provider/model` strings) for agents without their own chain; empty = no cross-provider fallback by default
- `retry_on_errors` — enable retry on non-transient errors (default true)
- `small_model_chain` — chain used for title/summary/compaction tasks (small-model work)

## Tests

```bash
bun install
bun test        # 18 tests, deterministic error-classifier suite
bun run build   # compile to dist/
```

## Attribution

**Maintained successor to [@razroo/opencode-model-fallback](https://github.com/razroo/opencode-model-fallback)** (MIT, dormant since 2026-04-16). This fork adds: opencode 1.18+ compatibility (default-only export), fallback-only-on-non-transient-errors, per-session stickiness, 402/insufficient-balance as non-retryable, prose-never-error handling, and the vendored small-model fallback hook. License: MIT (upstream attribution preserved).

## License

MIT
