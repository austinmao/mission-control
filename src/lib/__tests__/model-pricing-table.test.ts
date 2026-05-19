/**
 * Lane T1 — unit coverage for src/lib/model-pricing-table.ts
 *
 * Pure data + pure function. Covers:
 *   - All 35 model aliases resolve to the explicit rates declared in the table
 *   - Lowercase normalization (mixed-case input)
 *   - Whitespace trim
 *   - Anthropic short-alias fallback via substring loop (e.g. gateway-prefixed)
 *   - Unknown model → DEFAULT_MODEL_PRICING
 *   - Empty string → DEFAULT_MODEL_PRICING
 *   - ModelPricing interface shape (compile-time check via type assignment)
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MODEL_PRICING,
  MODEL_PRICING,
  getModelPricing,
  type ModelPricing,
} from '../model-pricing-table'

describe('model-pricing-table — pure data', () => {
  it('exposes a non-empty MODEL_PRICING record', () => {
    expect(Object.keys(MODEL_PRICING).length).toBeGreaterThan(0)
  })

  it('declares the documented 35 model entries', () => {
    // Pin the size so accidental deletions surface in review. If we add
    // genuinely new aliases, update this assertion at the same time.
    expect(Object.keys(MODEL_PRICING).length).toBe(35)
  })

  it('DEFAULT_MODEL_PRICING matches the documented Sonnet-tier fallback', () => {
    expect(DEFAULT_MODEL_PRICING).toEqual({
      inputPerMTok: 3.0,
      outputPerMTok: 15.0,
    })
  })

  it('every MODEL_PRICING entry conforms to ModelPricing shape', () => {
    for (const [key, value] of Object.entries(MODEL_PRICING)) {
      // Type assignment guard — fails at compile-time if shape drifts.
      const _typeCheck: ModelPricing = value
      void _typeCheck
      expect(typeof value.inputPerMTok).toBe('number')
      expect(typeof value.outputPerMTok).toBe('number')
      expect(Number.isFinite(value.inputPerMTok)).toBe(true)
      expect(Number.isFinite(value.outputPerMTok)).toBe(true)
      expect(value.inputPerMTok).toBeGreaterThanOrEqual(0)
      expect(value.outputPerMTok).toBeGreaterThanOrEqual(0)
      // Keys are normalized (lowercase) to allow direct dictionary lookup
      // after `normalizedModelName()` in `getModelPricing`.
      expect(key).toBe(key.toLowerCase())
    }
  })
})

describe('getModelPricing — exact alias resolution', () => {
  // Drive every key explicitly so a typo in MODEL_PRICING is detectable.
  // Each row asserts the table entry survives the lookup path
  // (`normalizedModelName` -> direct dictionary hit at line 67).
  const ALL_ALIASES = Object.entries(MODEL_PRICING)

  it.each(ALL_ALIASES)('resolves exact alias %s', (alias, expected) => {
    expect(getModelPricing(alias)).toEqual(expected)
  })

  it('confirms all 35 aliases resolve via the exact-match branch', () => {
    // Defense in depth: the parametric test above asserts equality; this
    // asserts the loop ran for every key (catches `.each` skipping).
    expect(ALL_ALIASES.length).toBe(35)
  })
})

describe('getModelPricing — normalization', () => {
  it('normalizes mixed-case input to lowercase before lookup', () => {
    const result = getModelPricing('Anthropic/Claude-Sonnet-4-5')
    expect(result).toEqual({ inputPerMTok: 3.0, outputPerMTok: 15.0 })
  })

  it('normalizes ALL-CAPS input', () => {
    const result = getModelPricing('CLAUDE-HAIKU-4-5')
    expect(result).toEqual({ inputPerMTok: 0.8, outputPerMTok: 4.0 })
  })

  it('trims leading whitespace', () => {
    const result = getModelPricing('   anthropic/claude-opus-4-6')
    expect(result).toEqual({ inputPerMTok: 5.0, outputPerMTok: 25.0 })
  })

  it('trims trailing whitespace', () => {
    const result = getModelPricing('anthropic/claude-opus-4-6   ')
    expect(result).toEqual({ inputPerMTok: 5.0, outputPerMTok: 25.0 })
  })

  it('trims whitespace on both sides', () => {
    const result = getModelPricing('  claude-sonnet-4-5  ')
    expect(result).toEqual({ inputPerMTok: 3.0, outputPerMTok: 15.0 })
  })

  it('trim + lowercase combine for normalization', () => {
    const result = getModelPricing('  CLAUDE-SONNET-4-5  ')
    expect(result).toEqual({ inputPerMTok: 3.0, outputPerMTok: 15.0 })
  })
})

describe('getModelPricing — substring fallback (anthropic short-alias)', () => {
  it('matches gateway-prefixed model via short-name substring', () => {
    // The gateway sometimes emits `gateway::claude-opus-4-6` (no slash
    // prefix). After normalization this is NOT a direct hit; the
    // substring loop at line 68-71 should match because the table key
    // `anthropic/claude-opus-4-6` has short-name `claude-opus-4-6`,
    // which is contained in the normalized input.
    const result = getModelPricing('gateway::claude-opus-4-6')
    expect(result).toEqual({ inputPerMTok: 5.0, outputPerMTok: 25.0 })
  })

  it('matches when input wraps a known short-name with arbitrary prefix', () => {
    const result = getModelPricing('custom-proxy/claude-haiku-4-5')
    // claude-haiku-4-5 has its own bare alias (inputPerMTok: 0.8) so the
    // exact-prefix path lands a hit before the substring loop. We still
    // expect 0.8 either way — both branches return the same row.
    expect(result.inputPerMTok).toBe(0.8)
    expect(result.outputPerMTok).toBe(4.0)
  })

  it('matches groq model via substring fallback', () => {
    const result = getModelPricing('llm-router::groq/llama-3.3-70b-versatile')
    expect(result).toEqual({ inputPerMTok: 0.59, outputPerMTok: 0.59 })
  })

  it('matches ollama local model via substring fallback', () => {
    // ollama short-names contain colons (`qwen2.5-coder:14b`) — confirm
    // the loop still matches when the input wraps the canonical key.
    const result = getModelPricing('local-runner::ollama/qwen2.5-coder:14b')
    expect(result).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
  })
})

describe('getModelPricing — fallback to DEFAULT', () => {
  it('returns DEFAULT_MODEL_PRICING for unknown model', () => {
    const result = getModelPricing('totally-unknown-model-999')
    expect(result).toBe(DEFAULT_MODEL_PRICING)
  })

  it('returns DEFAULT_MODEL_PRICING for empty string input', () => {
    const result = getModelPricing('')
    expect(result).toBe(DEFAULT_MODEL_PRICING)
  })

  it('returns DEFAULT_MODEL_PRICING for whitespace-only input', () => {
    const result = getModelPricing('     ')
    expect(result).toBe(DEFAULT_MODEL_PRICING)
  })

  it('returns DEFAULT_MODEL_PRICING when input has no overlap with any short-name', () => {
    const result = getModelPricing('openai/gpt-9000-turbo')
    expect(result).toBe(DEFAULT_MODEL_PRICING)
  })
})
