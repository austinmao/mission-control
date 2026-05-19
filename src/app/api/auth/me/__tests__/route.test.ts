/**
 * Lane T2 — integration coverage for `/api/auth/me` route.
 *
 * The route layer trusts auth context from `@/lib/auth.requireRole` +
 * `@/lib/auth.getUserFromRequest`. Clerk JWT verification + org-claim
 * gating happens upstream in middleware (`src/proxy.ts:clerkMiddleware`)
 * which injects `x-clerk-*` headers. The mismatch-→403 audit path is
 * covered by `src/lib/__tests__/clerk-header-auth.test.ts` (6 tests).
 *
 * This file exercises the route surface itself:
 *   - GET 401 when no auth context (missing Bearer / no Clerk headers / dev-mode)
 *   - GET 401 when requireRole succeeds but getUserFromRequest returns null
 *     (edge: cookie validated but user row deleted)
 *   - GET 200 + sanitized user payload on success
 *   - GET 403 when role insufficient (requireRole rejects below viewer)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireRoleSpy = vi.fn()
const getUserFromRequestSpy = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole: (...args: unknown[]) => requireRoleSpy(...args),
  getUserFromRequest: (...args: unknown[]) => getUserFromRequestSpy(...args),
  updateUser: vi.fn(),
  destroyAllUserSessions: vi.fn(),
  createSession: vi.fn(() => ({ token: 't', expiresAt: 0 })),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => ({ prepare: () => ({ get: () => null }) }),
  logAuditEvent: vi.fn(),
}))

vi.mock('@/lib/password', () => ({ verifyPassword: vi.fn(() => false) }))

vi.mock('@/lib/session-cookie', () => ({
  getMcSessionCookieName: () => 'mc_session',
  getMcSessionCookieOptions: () => ({}),
  isRequestSecure: () => true,
}))

vi.mock('@/lib/rate-limit', () => ({ passwordChangeLimiter: vi.fn(() => null) }))

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

// Import after mocks
import { GET } from '../route'

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/auth/me', { method: 'GET', headers: new Headers(headers) })
}

describe('Lane T2 — /api/auth/me GET route surface', () => {
  beforeEach(() => {
    requireRoleSpy.mockReset()
    getUserFromRequestSpy.mockReset()
  })

  it('returns 401 when requireRole rejects (no auth context)', async () => {
    requireRoleSpy.mockReturnValue({ error: 'Not authenticated', status: 401 })
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Not authenticated')
  })

  it('returns 403 when requireRole returns role-insufficient error', async () => {
    requireRoleSpy.mockReturnValue({ error: 'Forbidden — role insufficient', status: 403 })
    const res = await GET(makeReq())
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.error).toBe('Forbidden — role insufficient')
  })

  it('returns 401 when role passes but user resolver returns null (deleted user)', async () => {
    requireRoleSpy.mockReturnValue({ user: null })
    getUserFromRequestSpy.mockReturnValue(null)
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
    const json = await res.json()
    expect(json.error).toBe('Not authenticated')
  })

  it('returns 200 + sanitized payload on valid Clerk-authenticated user', async () => {
    requireRoleSpy.mockReturnValue({
      user: {
        id: 42,
        username: 'austin',
        role: 'admin',
        workspace_id: 1,
        tenant_id: 1,
      },
    })
    getUserFromRequestSpy.mockReturnValue({
      id: 42,
      username: 'austin',
      display_name: 'Austin Mao',
      role: 'admin',
      provider: 'clerk',
      email: 'austin@ceremoniacircle.org',
      avatar_url: null,
      workspace_id: 1,
      tenant_id: 1,
    })

    const res = await GET(makeReq({ Authorization: 'Bearer test_jwt' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.user.id).toBe(42)
    expect(json.user.username).toBe('austin')
    expect(json.user.email).toBe('austin@ceremoniacircle.org')
    expect(json.user.provider).toBe('clerk')
    expect(json.user.role).toBe('admin')
    expect(json.user.workspace_id).toBe(1)
    expect(json.user.tenant_id).toBe(1)
    // sensitive fields never present
    expect((json.user as Record<string, unknown>).password_hash).toBeUndefined()
  })

  it('defaults workspace_id + tenant_id to 1 when user record omits them', async () => {
    requireRoleSpy.mockReturnValue({ user: { id: 7 } })
    getUserFromRequestSpy.mockReturnValue({
      id: 7,
      username: 'edge',
      role: 'viewer',
      // workspace_id + tenant_id intentionally absent
    })
    const res = await GET(makeReq())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.user.workspace_id).toBe(1)
    expect(json.user.tenant_id).toBe(1)
  })
})
