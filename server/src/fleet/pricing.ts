// The one place that turns tokens into dollars (SPEC 6.5, issue #117). The built-in table is the Anthropic
// pricing sheet; the Admin can override any row. Every figure is an ESTIMATE, never a bill.

import type { ModelPriceSet, ModelUsage } from './protocol.js';
export type { ModelUsage };

export const PRICES_AS_OF = '2026-10-13';
/** Upper bound for one price, USD per million tokens: catches a typo, not a real price. */
export const MAX_PRICE = 1000;
/** A request whose prompt (input + cache reads + cache writes) is over this pays a model's `long` tier. */
export const LONG_PROMPT_TOKENS = 100_000;

export type PriceSet = ModelPriceSet;

export interface ModelPrice {
  std: PriceSet;
  /** Higher prices for a prompt over `LONG_PROMPT_TOKENS`; only some models (Haiku 5.5) have one. */
  long?: PriceSet;
}

/** What the Admin changed, by model key. Either tier may be overridden alone. */
export type PriceOverrides = Record<string, Partial<ModelPrice>>;

const set = (input: number, output: number, cacheRead: number, cacheWrite: number, cacheWrite1h: number): PriceSet => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  cacheWrite1h,
});

/** Built-in rows, keyed by a stable model key. Source: platform.claude.com/docs/en/about-claude/pricing. */
export const BUILTIN_PRICES: Record<string, ModelPrice> = {
  'fable-5-1': { std: set(10, 50, 0.25, 12.5, 20) },
  'fable-5': { std: set(10, 50, 1, 12.5, 20) },
  'opus-5-5': { std: set(4, 20, 0.2, 5, 8) },
  'opus-5': { std: set(5, 25, 0.5, 6.25, 10) },
  'opus-4-1': { std: set(15, 75, 1.5, 18.75, 30) },
  'sonnet-5-5': { std: set(2, 10, 0.1, 2.5, 4) },
  'sonnet-5': { std: set(2, 10, 0.2, 2.5, 4) },
  'sonnet-4': { std: set(3, 15, 0.3, 3.75, 6) },
  'haiku-5-5': { std: set(0.1, 0.5, 0.01, 0.125, 0.2), long: set(0.5, 2.5, 0.05, 0.625, 1) },
  'haiku-4-5': { std: set(1, 5, 0.1, 1.25, 2) },
  'haiku-3-5': { std: set(0.8, 4, 0.08, 1, 1.6) },
};

/** Names for the Admin table, in display order. */
export const BUILTIN_LABELS: Record<string, string> = {
  'fable-5-1': 'Fable 5.1, Mythos 5.1',
  'fable-5': 'Fable 5, Mythos 5',
  'opus-5-5': 'Opus 5.5',
  'opus-5': 'Opus 5, 4.8, 4.7, 4.6, 4.5',
  'opus-4-1': 'Opus 4.1, 4',
  'sonnet-5-5': 'Sonnet 5.5',
  'sonnet-5': 'Sonnet 5',
  'sonnet-4': 'Sonnet 4.6, 4.5, 4',
  'haiku-5-5': 'Haiku 5.5',
  'haiku-4-5': 'Haiku 4.5',
  'haiku-3-5': 'Haiku 3.5',
};

/** Most specific first; an alias such as `opus` falls through to the family's current model. */
const MATCH: [RegExp, string][] = [
  [/(fable|mythos)-5-1/, 'fable-5-1'],
  [/(fable|mythos)-5/, 'fable-5'],
  [/fable|mythos/, 'fable-5-1'],
  [/opus-5-5/, 'opus-5-5'],
  [/opus-5/, 'opus-5'],
  [/opus-4-1(?!\d)/, 'opus-4-1'],
  [/opus-4-[5-8]/, 'opus-5'],
  [/opus-4/, 'opus-4-1'],
  [/opus/, 'opus-5-5'],
  [/sonnet-5-5/, 'sonnet-5-5'],
  [/sonnet-5/, 'sonnet-5'],
  [/sonnet-4/, 'sonnet-4'],
  [/sonnet/, 'sonnet-5-5'],
  [/haiku-5-5/, 'haiku-5-5'],
  [/haiku-4/, 'haiku-4-5'],
  [/haiku-3/, 'haiku-3-5'],
  [/haiku/, 'haiku-5-5'],
];

/** Only a Claude model gets a built-in price: a bare alias or an id containing `claude` (as `family()` in derive.ts). */
function isClaude(m: string): boolean {
  return /^(opus|sonnet|haiku|fable|mythos|opusplan)(\[[^\]]*\])?$/.test(m) || m.includes('claude');
}

/**
 * The key a model id is priced under: an Admin-added exact id first, then a built-in row, else `null`
 * (a non-Claude model nobody has priced).
 */
export function resolveModel(model: string | null | undefined, overrides: PriceOverrides): string | null {
  const m = (model ?? '').toLowerCase();
  if (!m) return null;
  if (Object.hasOwn(overrides, m)) return m;
  // Native CLI prices are opt-in: a Copilot Claude model does not imply Anthropic USD billing.
  if (/^(codex|copilot|opencode)\//.test(m)) return null;
  if (!isClaude(m)) return null;
  for (const [re, key] of MATCH) if (re.test(m)) return key;
  return null;
}

/** `null` when `v` is a complete, valid price set, else a message naming the problem. */
export function validatePriceSet(v: unknown): string | null {
  if (!v || typeof v !== 'object') return 'a price set is required';
  for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const) {
    const n = (v as Record<string, unknown>)[f];
    if (typeof n !== 'number' || !Number.isFinite(n)) return `${f} must be a number`;
    if (n < 0) return `${f} must be zero or more`;
    if (n > MAX_PRICE) return `${f} must be at most ${MAX_PRICE} USD per million tokens`;
  }
  return null;
}

export class Pricing {
  constructor(private overrides: PriceOverrides) {}

  /** The price row for a key, with the Admin's changes laid over the built-in one; `null` if neither exists. */
  rowOf(key: string): ModelPrice | null {
    const base = Object.hasOwn(BUILTIN_PRICES, key) ? BUILTIN_PRICES[key] : undefined;
    const o = Object.hasOwn(this.overrides, key) ? this.overrides[key] : undefined;
    const std = o?.std ?? base?.std;
    if (!std) return null;
    const long = o?.long ?? base?.long;
    return long ? { std, long } : { std };
  }

  /**
   * Estimated USD for a list of per-model usage: Σ tokens × price / 1e6. A tier the model lacks prices at
   * `std`. A model with no price adds nothing, so the rest of a mixed session still follows the Admin's prices;
   * `null` only when every model that used tokens is unpriced. A model with zero tokens is ignored.
   */
  costOf(usage: ModelUsage[]): number | null {
    let usd = 0;
    let priced = false;
    let unpriced = false;
    for (const u of usage) {
      const t = u.tokens;
      if (!(t.input || t.output || t.cacheRead || t.cacheWrite || t.cacheWrite1h)) continue;
      const key = resolveModel(u.model, this.overrides);
      const row = key ? this.rowOf(key) : null;
      if (!row) {
        unpriced = true;
        continue;
      }
      priced = true;
      const p = u.tier === 'long' && row.long ? row.long : row.std;
      usd += (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite + t.cacheWrite1h * p.cacheWrite1h) / 1e6;
    }
    return unpriced && !priced ? null : usd;
  }
}
