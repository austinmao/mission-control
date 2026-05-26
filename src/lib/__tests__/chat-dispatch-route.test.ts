import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const callOpenClawGateway = vi.fn()
const broadcastMock = vi.fn()
const getAllGatewaySessions = vi.fn()
const readSessionJsonl = vi.fn()
const parseJsonlTranscript = vi.fn()
const prepare = vi.fn()
const insertRun = vi.fn(() => ({ lastInsertRowid: 99 }))

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: broadcastMock } }))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/sessions', () => ({ getAllGatewaySessions }))
vi.mock('@/lib/transcript-parser', () => ({ readSessionJsonl, parseJsonlTranscript }))
vi.mock('@/lib/config', () => ({
  config: { openclawStateDir: '/state' },
}))

const AGENT_ROW = { id: 5, name: 'main-agent', config: JSON.stringify({ openclawId: 'main-agent' }) }
const REPLY_ROW = { id: 99, conversation_id: 'c1', from_agent: 'main-agent', content: 'Hello!', workspace_id: 1 }
const OPERATOR_USER = { user: { id: 1, username: 'admin', role: 'operator', workspace_id: 1, display_name: 'Admin' } }

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare })),
}))

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/chat/dispatch', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/chat/dispatch', () => {
  beforeEach(() => {
    vi.resetModules()
    requireRole.mockReturnValue(OPERATOR_USER)
    callOpenClawGateway.mockReset()
    broadcastMock.mockReset()
    getAllGatewaySessions.mockReturnValue([])
    readSessionJsonl.mockReturnValue(null)
    parseJsonlTranscript.mockReturnValue([])
    insertRun.mockReturnValue({ lastInsertRowid: 99 })

    prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM agents')) return { get: vi.fn(() => AGENT_ROW) }
      if (sql.includes('INSERT INTO messages')) return { run: insertRun }
      if (sql.includes('SELECT * FROM messages')) return { get: vi.fn(() => REPLY_ROW) }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when auth fails', async () => {
    requireRole.mockReturnValue({ error: 'Unauthorized', status: 401 })
    const { POST } = await import('@/app/api/chat/dispatch/route')
    const res = await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when agent is missing', async () => {
    const { POST } = await import('@/app/api/chat/dispatch/route')
    const res = await POST(makeRequest({ message: 'hi' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when message is missing', async () => {
    const { POST } = await import('@/app/api/chat/dispatch/route')
    const res = await POST(makeRequest({ agent: 'main-agent' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when agent not found in DB', async () => {
    prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM agents')) return { get: vi.fn(() => null) }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
    const { POST } = await import('@/app/api/chat/dispatch/route')
    const res = await POST(makeRequest({ agent: 'ghost', message: 'hi' }))
    expect(res.status).toBe(404)
  })

  it('returns 202 when gateway returns no runId', async () => {
    callOpenClawGateway.mockResolvedValue({})
    const { POST } = await import('@/app/api/chat/dispatch/route')
    const res = await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.reason).toBe('no_run_id')
  })

  it('returns 202 when agent.wait times out', async () => {
    callOpenClawGateway
      .mockResolvedValueOnce({ runId: 'run-1' })
      .mockRejectedValueOnce(new Error('timeout'))
    const { POST } = await import('@/app/api/chat/dispatch/route')
    const res = await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.reason).toBe('wait_timeout')
    expect(body.runId).toBe('run-1')
  })

  it('returns 200 with reply row on happy path', async () => {
    callOpenClawGateway
      .mockResolvedValueOnce({ runId: 'run-42' })
      .mockResolvedValueOnce({ text: 'Hello from agent!' })
    const { POST } = await import('@/app/api/chat/dispatch/route')
    const res = await POST(makeRequest({ agent: 'main-agent', message: 'ping', conversation_id: 'c1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.runId).toBe('run-42')
    expect(broadcastMock).toHaveBeenCalledWith('chat.message', REPLY_ROW)
  })

  it('falls back to transcript recovery when wait payload has no text', async () => {
    callOpenClawGateway
      .mockResolvedValueOnce({ runId: 'run-99' })
      .mockResolvedValueOnce({})
    getAllGatewaySessions.mockReturnValue([
      { agent: 'main-agent', sessionId: 'sess-1', updatedAt: Date.now() },
    ])
    readSessionJsonl.mockReturnValue('raw-data')
    parseJsonlTranscript.mockReturnValue([
      { role: 'user', parts: [{ type: 'text', text: 'ping' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'pong from transcript' }] },
    ])
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'ping', conversation_id: 'c2' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(), 'pong from transcript',
      expect.anything(), expect.anything(),
    )
  })

  it('stores fallback placeholder when no text recoverable', async () => {
    callOpenClawGateway
      .mockResolvedValueOnce({ runId: 'run-0' })
      .mockResolvedValueOnce({})
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'ping' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(),
      'Deferred agent run completed without textual output.',
      expect.anything(), expect.anything(),
    )
  })

  it('returns 500 on unexpected error', async () => {
    prepare.mockImplementation(() => { throw new Error('DB exploded') })
    const { POST } = await import('@/app/api/chat/dispatch/route')
    const res = await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(res.status).toBe(500)
  })
})

describe('extractReplyText — via POST integration', () => {
  beforeEach(() => {
    vi.resetModules()
    requireRole.mockReturnValue(OPERATOR_USER)
    callOpenClawGateway.mockReset()
    getAllGatewaySessions.mockReturnValue([])
    insertRun.mockReturnValue({ lastInsertRowid: 99 })
    prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM agents')) return { get: vi.fn(() => AGENT_ROW) }
      if (sql.includes('INSERT INTO messages')) return { run: insertRun }
      if (sql.includes('SELECT * FROM messages')) return { get: vi.fn(() => REPLY_ROW) }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
  })

  afterEach(() => { vi.clearAllMocks() })

  it('extracts text from flat "text" key', async () => {
    callOpenClawGateway.mockResolvedValueOnce({ runId: 'r1' }).mockResolvedValueOnce({ text: 'flat text reply' })
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(), 'flat text reply', expect.anything(), expect.anything(),
    )
  })

  it('extracts text from flat "message" key', async () => {
    callOpenClawGateway.mockResolvedValueOnce({ runId: 'r2' }).mockResolvedValueOnce({ message: 'msg key reply' })
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(), 'msg key reply', expect.anything(), expect.anything(),
    )
  })

  it('extracts text from output array item.text', async () => {
    callOpenClawGateway
      .mockResolvedValueOnce({ runId: 'r3' })
      .mockResolvedValueOnce({ output: [{ text: 'output item text' }] })
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(), 'output item text', expect.anything(), expect.anything(),
    )
  })

  it('extracts text from nested content block in output array message item', async () => {
    callOpenClawGateway
      .mockResolvedValueOnce({ runId: 'r4' })
      .mockResolvedValueOnce({
        output: [{ type: 'message', content: [{ type: 'text', text: 'nested block text' }] }],
      })
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(), 'nested block text', expect.anything(), expect.anything(),
    )
  })
})

describe('recoverChatReplyFromTranscript — via POST integration', () => {
  beforeEach(() => {
    vi.resetModules()
    requireRole.mockReturnValue(OPERATOR_USER)
    callOpenClawGateway.mockReset()
    getAllGatewaySessions.mockReturnValue([])
    readSessionJsonl.mockReturnValue(null)
    parseJsonlTranscript.mockReturnValue([])
    insertRun.mockReturnValue({ lastInsertRowid: 99 })
    prepare.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM agents')) return { get: vi.fn(() => AGENT_ROW) }
      if (sql.includes('INSERT INTO messages')) return { run: insertRun }
      if (sql.includes('SELECT * FROM messages')) return { get: vi.fn(() => REPLY_ROW) }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
  })

  afterEach(() => { vi.clearAllMocks() })

  it('uses placeholder when no sessions match the agent', async () => {
    getAllGatewaySessions.mockReturnValue([
      { agent: 'other-agent', sessionId: 'sess-x', updatedAt: Date.now() },
    ])
    callOpenClawGateway.mockResolvedValueOnce({ runId: 'r7' }).mockResolvedValueOnce({})
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'hi' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(),
      'Deferred agent run completed without textual output.',
      expect.anything(), expect.anything(),
    )
  })

  it('uses placeholder when jsonl file is missing', async () => {
    getAllGatewaySessions.mockReturnValue([{ agent: 'main-agent', sessionId: 'sess-1', updatedAt: Date.now() }])
    readSessionJsonl.mockReturnValue(null)
    callOpenClawGateway.mockResolvedValueOnce({ runId: 'r8' }).mockResolvedValueOnce({})
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'needle-phrase' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(),
      'Deferred agent run completed without textual output.',
      expect.anything(), expect.anything(),
    )
  })

  it('returns first assistant reply after needle user message', async () => {
    getAllGatewaySessions.mockReturnValue([{ agent: 'main-agent', sessionId: 'sess-2', updatedAt: Date.now() }])
    readSessionJsonl.mockReturnValue('data')
    parseJsonlTranscript.mockReturnValue([
      { role: 'assistant', parts: [{ type: 'text', text: 'unrelated earlier reply' }] },
      { role: 'user', parts: [{ type: 'text', text: 'needle phrase here for matching' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'correct reply after needle' }] },
    ])
    callOpenClawGateway.mockResolvedValueOnce({ runId: 'r9' }).mockResolvedValueOnce({})
    const { POST } = await import('@/app/api/chat/dispatch/route')
    await POST(makeRequest({ agent: 'main-agent', message: 'needle phrase here for matching' }))
    expect(insertRun).toHaveBeenCalledWith(
      expect.anything(), 'main-agent', expect.anything(), 'correct reply after needle',
      expect.anything(), expect.anything(),
    )
  })
})
