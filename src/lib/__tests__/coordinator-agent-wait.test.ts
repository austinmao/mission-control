/**
 * Regression test: coordinator wait-poll uses callOpenClawGateway('agent.wait')
 * not the defunct `openclaw gateway call agent.wait` CLI command.
 *
 * Bug: "I could not retrieve completion output yet: unknown gateway action: call"
 * Root cause: messages/route.ts used runOpenClaw(['gateway','call','agent.wait',...])
 * Fix: replaced with callOpenClawGateway('agent.wait', ...) matching dispatch/route.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// --- mocks -----------------------------------------------------------------

const requireRoleMock = vi.fn()
const callOpenClawGatewayMock = vi.fn()
const broadcastMock = vi.fn()
const getAllGatewaySessionsMock = vi.fn()
const resolveCoordinatorDeliveryTargetMock = vi.fn()
const scanForInjectionMock = vi.fn(() => ({ safe: true }))
const sanitizeForPromptMock = vi.fn((s: string) => s)

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway: callOpenClawGatewayMock }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: broadcastMock, on: vi.fn(), emit: vi.fn() } }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/sessions', () => ({ getAllGatewaySessions: getAllGatewaySessionsMock }))
vi.mock('@/lib/coordinator-routing', () => ({ resolveCoordinatorDeliveryTarget: resolveCoordinatorDeliveryTargetMock }))
vi.mock('@/lib/injection-guard', () => ({
  scanForInjection: scanForInjectionMock,
  sanitizeForPrompt: sanitizeForPromptMock,
}))
vi.mock('@/lib/command', () => ({
  runOpenClaw: vi.fn(() => { throw new Error('runOpenClaw must not be called — use callOpenClawGateway') }),
}))

const prepareMock = vi.fn()
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
  db_helpers: {
    get: vi.fn(),
    run: vi.fn(),
    logActivity: vi.fn(),
    createNotification: vi.fn(),
  },
}))

// --- helpers ---------------------------------------------------------------

function makeDb() {
  prepareMock.mockImplementation((sql: string) => ({
    get: vi.fn((..._args: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ').trim()
      if (norm.startsWith('SELECT id, tenant_id') || norm.startsWith('SELECT tenant_id')) return { id: 1, tenant_id: 1 }
      if (norm.startsWith('SELECT * FROM messages WHERE id')) return { id: 1, workspace_id: 1, content: 'ping reply pong' }
      return undefined
    }),
    run: vi.fn(() => ({ lastInsertRowid: 1 })),
    all: vi.fn(() => []),
  }))
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/chat/messages', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

// --- tests -----------------------------------------------------------------

describe('coordinator wait-poll — uses callOpenClawGateway not runOpenClaw', () => {
  const WORKSPACE_USER = {
    user: { id: 1, username: 'austin@ceremoniacircle.org', role: 'admin', workspace_id: 1, display_name: 'Austin' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    requireRoleMock.mockReturnValue(WORKSPACE_USER)
    getAllGatewaySessionsMock.mockReturnValue([])
    scanForInjectionMock.mockReturnValue({ safe: true })
    sanitizeForPromptMock.mockImplementation((s: string) => s)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls callOpenClawGateway("agent.wait") for coordinator wait-poll — never runOpenClaw', async () => {
    makeDb()

    resolveCoordinatorDeliveryTargetMock.mockReturnValue({
      sessionKey: null,
      deliveryName: 'Coordinator',
      openclawAgentId: 'coordinator',
    })

    callOpenClawGatewayMock.mockImplementation((method: string) => {
      if (method === 'agent') return Promise.resolve({ status: 'accepted', runId: 'run-test-abc' })
      if (method === 'agent.wait') return Promise.resolve({ status: 'completed', reply: 'pong' })
      return Promise.resolve({})
    })

    const { POST } = await import('@/app/api/chat/messages/route')

    const req = makeRequest({
      workspace_id: 1,
      conversation_id: 'coord:main',
      content: 'ping reply pong',
      from: 'austin@ceremoniacircle.org',
      to: 'Coordinator',
      forward: true,
    })

    const res = await POST(req)
    expect(res.status).toBeLessThan(500)

    const waitCall = callOpenClawGatewayMock.mock.calls.find((args) => args[0] === 'agent.wait')
    expect(waitCall).toBeDefined()
    expect(waitCall![1]).toMatchObject({ runId: 'run-test-abc', timeoutMs: 6000 })
  })

  it('degrades gracefully when agent.wait fails — returns 2xx not 5xx', async () => {
    makeDb()

    resolveCoordinatorDeliveryTargetMock.mockReturnValue({
      sessionKey: null,
      deliveryName: 'Coordinator',
      openclawAgentId: 'coordinator',
    })

    callOpenClawGatewayMock.mockImplementation((method: string) => {
      if (method === 'agent') return Promise.resolve({ status: 'accepted', runId: 'run-err-abc' })
      if (method === 'agent.wait') return Promise.reject(Object.assign(new Error('unknown gateway action: call'), { stderr: 'unknown gateway action: call' }))
      return Promise.resolve({})
    })

    const { POST } = await import('@/app/api/chat/messages/route')

    const req = makeRequest({
      workspace_id: 1,
      conversation_id: 'coord:main',
      content: 'ping reply pong',
      from: 'austin@ceremoniacircle.org',
      to: 'Coordinator',
      forward: true,
    })

    const res = await POST(req)
    expect(res.status).toBeLessThan(500)
  })
})
