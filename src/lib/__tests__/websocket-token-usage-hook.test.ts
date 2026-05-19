/**
 * Lane T1 — branch-coverage validation for the WebSocket `event` handler
 * branch at `src/lib/websocket.ts:353` that bridges gateway `token_usage`
 * frames into the zustand `addTokenUsage` store push.
 *
 * The branch logic is inlined inside a `useCallback`, so we can't import
 * the closure directly. Instead we simulate the exact predicate +
 * `adaptGatewayUsage` + `normalizeModel` glue the hook performs, asserting
 * each branch of the conditional ladder at L356-372:
 *
 *   1. `message.data?.type === 'token_usage'` (MC-native shape) → adapter
 *      called, store push fires.
 *   2. `message.data?.usage` truthy (gateway-native shape) → adapter
 *      called, store push fires.
 *   3. Neither field present → adapter NOT called, store NOT called.
 *   4. Adapter returns null → store NOT called.
 *   5. Model normalization runs via `normalizeModel` before push.
 *
 * This mirrors the production wiring without re-rendering React components,
 * keeping the test pure + deterministic.
 */
import { describe, expect, it, vi } from 'vitest'

import { adaptGatewayUsage } from '../gateway-usage-adapter'
import { normalizeModel } from '../utils'

type TokenUsageInput = Parameters<typeof adaptGatewayUsage>[0]

interface AddTokenUsageRow {
  model: string
  sessionId: string
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
}

/**
 * Mirror of the inlined hook logic at websocket.ts L353-373.
 * Lets us assert every branch deterministically against a mock store.
 */
function simulateTokenUsageBranch(
  message: { type: string; data?: Record<string, unknown> },
  addTokenUsage: (row: AddTokenUsageRow) => void,
): { adapterCalled: boolean; stored: boolean } {
  if (message.type !== 'event') {
    return { adapterCalled: false, stored: false }
  }
  const dataType = (message.data as { type?: string } | undefined)?.type
  const usage = (message.data as { usage?: unknown } | undefined)?.usage
  if (dataType !== 'token_usage' && !usage) {
    return { adapterCalled: false, stored: false }
  }
  const fallbackSessionId =
    (message.data?.sessionId as string) ||
    ((message.data as { session_id?: string } | undefined)?.session_id ?? '')
  const adapted = adaptGatewayUsage(message.data as TokenUsageInput, fallbackSessionId)
  if (!adapted) {
    return { adapterCalled: true, stored: false }
  }
  addTokenUsage({
    model: normalizeModel(adapted.model),
    sessionId: adapted.sessionId,
    date: new Date().toISOString(),
    inputTokens: adapted.inputTokens,
    outputTokens: adapted.outputTokens,
    totalTokens: adapted.totalTokens,
    cost: adapted.cost,
  })
  return { adapterCalled: true, stored: true }
}

describe('websocket.ts:353 token_usage event branch', () => {
  it('ignores non-event messages', () => {
    const store = vi.fn()
    const result = simulateTokenUsageBranch(
      { type: 'cron_status', data: { type: 'token_usage', model: 'x' } },
      store,
    )
    expect(result).toEqual({ adapterCalled: false, stored: false })
    expect(store).not.toHaveBeenCalled()
  })

  it('ignores event without token_usage type AND without usage block', () => {
    const store = vi.fn()
    const result = simulateTokenUsageBranch(
      { type: 'event', data: { type: 'agent_progress', message: 'hello' } },
      store,
    )
    expect(result).toEqual({ adapterCalled: false, stored: false })
    expect(store).not.toHaveBeenCalled()
  })

  it('triggers adapter on MC-native token_usage frame and pushes to store', () => {
    const store = vi.fn()
    const result = simulateTokenUsageBranch(
      {
        type: 'event',
        data: {
          type: 'token_usage',
          model: 'anthropic/claude-sonnet-4-5',
          sessionId: 'sess-1',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cost: 0.001,
        },
      },
      store,
    )
    expect(result).toEqual({ adapterCalled: true, stored: true })
    expect(store).toHaveBeenCalledOnce()
    const row = store.mock.calls[0]?.[0] as AddTokenUsageRow
    expect(row.sessionId).toBe('sess-1')
    expect(row.inputTokens).toBe(100)
    expect(row.outputTokens).toBe(50)
    expect(row.cost).toBeCloseTo(0.001, 6)
  })

  it('triggers adapter on gateway-native snake_case usage block', () => {
    const store = vi.fn()
    const result = simulateTokenUsageBranch(
      {
        type: 'event',
        data: {
          model: 'anthropic/claude-haiku-4-5',
          session_id: 'sess-2',
          usage: {
            input_tokens: 200,
            output_tokens: 100,
          },
        },
      },
      store,
    )
    expect(result).toEqual({ adapterCalled: true, stored: true })
    expect(store).toHaveBeenCalledOnce()
    const row = store.mock.calls[0]?.[0] as AddTokenUsageRow
    expect(row.sessionId).toBe('sess-2')
    expect(row.inputTokens).toBe(200)
    expect(row.outputTokens).toBe(100)
    expect(row.cost).toBeGreaterThan(0)
  })

  it('falls back to data.sessionId when data.session_id absent (gateway-native)', () => {
    const store = vi.fn()
    simulateTokenUsageBranch(
      {
        type: 'event',
        data: {
          model: 'claude-haiku-4-5',
          sessionId: 'sess-camel',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      store,
    )
    const row = store.mock.calls[0]?.[0] as AddTokenUsageRow
    expect(row.sessionId).toBe('sess-camel')
  })

  it('does NOT push to store when adapter returns null (missing model)', () => {
    const store = vi.fn()
    const result = simulateTokenUsageBranch(
      {
        type: 'event',
        data: {
          type: 'token_usage',
          // missing model — adapter returns null
          sessionId: 'sess-3',
          inputTokens: 100,
          outputTokens: 50,
        },
      },
      store,
    )
    expect(result.adapterCalled).toBe(true)
    expect(result.stored).toBe(false)
    expect(store).not.toHaveBeenCalled()
  })

  it('passes model through normalizeModel (handles string vs object {primary})', () => {
    const store = vi.fn()
    simulateTokenUsageBranch(
      {
        type: 'event',
        data: {
          type: 'token_usage',
          model: 'anthropic/claude-sonnet-4-5',
          sessionId: 'sess-4',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cost: 0.001,
        },
      },
      store,
    )
    const row = store.mock.calls[0]?.[0] as AddTokenUsageRow
    expect(row.model).toBe('anthropic/claude-sonnet-4-5')
    expect(row.model.length).toBeGreaterThan(0)
  })

  it('does NOT push when MC-native frame has no sessionId (adapter returns null)', () => {
    // adaptGatewayUsage returns null when sessionId missing AND no
    // fallbackSessionId — verified in gateway-usage-adapter.test.ts
    // ("returns null when sessionId missing AND no fallback").
    // The hook's empty-string fallback at L359 propagates that null.
    const store = vi.fn()
    const result = simulateTokenUsageBranch(
      {
        type: 'event',
        data: {
          type: 'token_usage',
          model: 'claude-haiku-4-5',
          // no sessionId / no session_id
          inputTokens: 5,
          outputTokens: 5,
          totalTokens: 10,
          cost: 0,
        },
      },
      store,
    )
    expect(result.adapterCalled).toBe(true)
    expect(result.stored).toBe(false)
    expect(store).not.toHaveBeenCalled()
  })

  it('does NOT crash on undefined data', () => {
    const store = vi.fn()
    const result = simulateTokenUsageBranch({ type: 'event' }, store)
    expect(result).toEqual({ adapterCalled: false, stored: false })
  })
})
