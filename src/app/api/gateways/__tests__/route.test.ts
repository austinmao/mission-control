/**
 * Lane T2 — integration coverage for `/api/gateways` route.
 *
 * Verifies:
 *   - GET 401 when requireRole rejects (no auth)
 *   - GET 403 when role below 'viewer'
 *   - GET 200 + redacted gateway list (token replaced w/ '--------', token_set boolean)
 *   - GET 200 + seeds default gateway from env when table empty
 *   - POST 401/403 path-through (requires 'admin' role)
 *   - POST 400 when name/host/port missing
 *   - POST 409 on UNIQUE constraint
 *   - POST 201 + redacted gateway on happy path (auto-registers agents)
 *   - DELETE 400 when deleting primary
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireRoleSpy = vi.fn()

// Build a stateful in-memory mock DB to exercise the route's redaction +
// audit_log catch-block path realistically.
type Row = Record<string, unknown>
class MockDb {
  gateways: Row[] = []
  agentsInserts: Row[] = []
  auditInserts: Row[] = []
  nextId = 1
  uniqueViolationOnNext = false
  exec() { /* ensureTable is a no-op for tests */ }
  prepare(sql: string) {
    const self = this
    return {
      all() {
        if (/SELECT \* FROM gateways/i.test(sql)) {
          return [...self.gateways].sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
        }
        return []
      },
      get(id?: unknown) {
        if (/SELECT \* FROM gateways WHERE id = \?/i.test(sql)) {
          return self.gateways.find((g) => g.id === id)
        }
        return null
      },
      run(...args: unknown[]) {
        if (/INSERT INTO gateways/i.test(sql)) {
          if (self.uniqueViolationOnNext) {
            self.uniqueViolationOnNext = false
            const e: Error & { message: string } = new Error('UNIQUE constraint failed: gateways.name')
            throw e
          }
          const [name, host, port, token, is_primary_arg] = args
          // The seed-defaults route hardcodes `is_primary` literal `1` in
          // the SQL (not bound). Detect via VALUES clause to mirror prod.
          const is_primary_literal_match = /VALUES \(\?, \?, \?, \?, (\d)\)/i.exec(sql)
          const is_primary = is_primary_literal_match
            ? Number(is_primary_literal_match[1])
            : is_primary_arg
          const id = self.nextId++
          self.gateways.push({ id, name, host, port, token, is_primary, status: 'unknown', last_seen: null, latency: null, sessions_count: 0, agents_count: 0, created_at: 0, updated_at: 0 })
          return { changes: 1, lastInsertRowid: id }
        }
        if (/INSERT INTO agents/i.test(sql)) {
          self.agentsInserts.push({ args })
          return { changes: 1 }
        }
        if (/INSERT INTO audit_log/i.test(sql)) {
          self.auditInserts.push({ args })
          return { changes: 1 }
        }
        if (/UPDATE gateways SET is_primary = 0/i.test(sql)) {
          self.gateways.forEach((g) => (g.is_primary = 0))
          return { changes: self.gateways.length }
        }
        if (/DELETE FROM gateways WHERE id/i.test(sql)) {
          const before = self.gateways.length
          self.gateways = self.gateways.filter((g) => g.id !== args[0])
          return { changes: before - self.gateways.length }
        }
        return { changes: 0 }
      },
    }
  }
}

let mockDb = new MockDb()

vi.mock('@/lib/auth', () => ({
  requireRole: (...args: unknown[]) => requireRoleSpy(...args),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => mockDb,
}))

vi.mock('@/lib/gateway-runtime', () => ({
  getDetectedGatewayPort: () => 18789,
  getDetectedGatewayToken: () => 'detected-token',
}))

// Import after mocks
import { GET, POST, DELETE } from '../route'

function makeReq(method: 'GET' | 'POST' | 'DELETE', body?: unknown): import('next/server').NextRequest {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = new Headers({ 'Content-Type': 'application/json' })
  }
  return new Request('http://localhost/api/gateways', init) as unknown as import('next/server').NextRequest
}

describe('Lane T2 — /api/gateways route surface', () => {
  beforeEach(() => {
    requireRoleSpy.mockReset()
    mockDb = new MockDb()
  })

  describe('GET', () => {
    it('returns 401 when requireRole rejects', async () => {
      requireRoleSpy.mockReturnValue({ error: 'Not authenticated', status: 401 })
      const res = await GET(makeReq('GET'))
      expect(res.status).toBe(401)
    })

    it('returns 403 when role insufficient (below viewer)', async () => {
      requireRoleSpy.mockReturnValue({ error: 'Forbidden', status: 403 })
      const res = await GET(makeReq('GET'))
      expect(res.status).toBe(403)
    })

    it('seeds default gateway from env when table empty and returns redacted list', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', workspace_id: 1, role: 'viewer' } })
      const res = await GET(makeReq('GET'))
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.gateways).toHaveLength(1)
      expect(json.gateways[0].name).toBe('primary')
      expect(json.gateways[0].token).toBe('--------') // redacted
      expect(json.gateways[0].token_set).toBe(true)
      expect(json.gateways[0].is_primary).toBe(1)
    })

    it('redacts tokens in existing gateway list', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', workspace_id: 1, role: 'viewer' } })
      mockDb.gateways.push({ id: 1, name: 'ceremonia', host: 'ceremonia.holalumina.com', port: 18789, token: 'secret-token-abc', is_primary: 1, status: 'healthy', last_seen: null, latency: null, sessions_count: 0, agents_count: 0, created_at: 0, updated_at: 0 })
      const res = await GET(makeReq('GET'))
      const json = await res.json()
      expect(json.gateways[0].token).toBe('--------')
      expect(json.gateways[0].token_set).toBe(true)
      expect(json.gateways[0].name).toBe('ceremonia')
    })

    it('marks token_set=false when gateway has empty token', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', workspace_id: 1, role: 'viewer' } })
      mockDb.gateways.push({ id: 1, name: 'empty', host: 'x', port: 1, token: '', is_primary: 1, status: 'unknown', last_seen: null, latency: null, sessions_count: 0, agents_count: 0, created_at: 0, updated_at: 0 })
      const res = await GET(makeReq('GET'))
      const json = await res.json()
      expect(json.gateways[0].token).toBe('')
      expect(json.gateways[0].token_set).toBe(false)
    })
  })

  describe('POST', () => {
    it('returns 401 when requireRole rejects', async () => {
      requireRoleSpy.mockReturnValue({ error: 'Not authenticated', status: 401 })
      const res = await POST(makeReq('POST', { name: 'x', host: 'y', port: 1 }))
      expect(res.status).toBe(401)
    })

    it('returns 403 when admin role required and request is below admin', async () => {
      requireRoleSpy.mockReturnValue({ error: 'Forbidden', status: 403 })
      const res = await POST(makeReq('POST', { name: 'x', host: 'y', port: 1 }))
      expect(res.status).toBe(403)
    })

    it('returns 400 when name missing', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', role: 'admin', workspace_id: 1 } })
      const res = await POST(makeReq('POST', { host: 'h', port: 1 }))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/name.*host.*port/)
    })

    it('returns 400 when port missing', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', role: 'admin', workspace_id: 1 } })
      const res = await POST(makeReq('POST', { name: 'x', host: 'h' }))
      expect(res.status).toBe(400)
    })

    it('returns 409 on UNIQUE constraint conflict', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', role: 'admin', workspace_id: 1 } })
      mockDb.uniqueViolationOnNext = true
      const res = await POST(makeReq('POST', { name: 'dup', host: 'h', port: 1 }))
      expect(res.status).toBe(409)
    })

    it('returns 201 + redacted gateway on success', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', role: 'admin', workspace_id: 1 } })
      const res = await POST(makeReq('POST', { name: 'new-gw', host: 'gw.example.com', port: 18789, token: 'secret', is_primary: false }))
      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.gateway.name).toBe('new-gw')
      expect(json.gateway.token).toBe('--------')
      expect(json.gateway.token_set).toBe(true)
      expect(json.agents_registered).toBe(0)
    })

    it('auto-registers agents when supplied in body', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', role: 'admin', workspace_id: 1 } })
      const res = await POST(makeReq('POST', {
        name: 'gw-with-agents',
        host: 'gw.example.com',
        port: 18789,
        agents: [
          { name: 'agent-a', role: 'worker' },
          { name: 'agent-b' }, // role defaults to 'agent'
          { name: '   ' }, // trimmed empty — skipped
        ],
      }))
      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.agents_registered).toBe(2)
    })
  })

  describe('DELETE', () => {
    it('returns 400 when deleting primary gateway', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', role: 'admin', workspace_id: 1 } })
      mockDb.gateways.push({ id: 9, name: 'primary-gw', host: 'h', port: 1, token: '', is_primary: 1, status: 'healthy', last_seen: null, latency: null, sessions_count: 0, agents_count: 0, created_at: 0, updated_at: 0 })
      const res = await DELETE(makeReq('DELETE', { id: 9 }))
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/primary/i)
    })

    it('returns 400 when id missing', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', role: 'admin', workspace_id: 1 } })
      const res = await DELETE(makeReq('DELETE', {}))
      expect(res.status).toBe(400)
    })

    it('returns 200 + deleted=true on successful non-primary delete', async () => {
      requireRoleSpy.mockReturnValue({ user: { id: 1, username: 'austin', role: 'admin', workspace_id: 1 } })
      mockDb.gateways.push({ id: 5, name: 'secondary', host: 'h', port: 1, token: '', is_primary: 0, status: 'healthy', last_seen: null, latency: null, sessions_count: 0, agents_count: 0, created_at: 0, updated_at: 0 })
      const res = await DELETE(makeReq('DELETE', { id: 5 }))
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.deleted).toBe(true)
    })
  })
})
