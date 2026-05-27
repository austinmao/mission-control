/**
 * CF Access auth path in getUserFromRequest.
 *
 * When CLERK_SECRET_KEY is unset, cf-access-authenticated-user-email
 * is the trusted signal: auto-provision or resolve an MC user from
 * the authenticated email exactly as the Clerk path does.
 *
 * When CLERK_SECRET_KEY is set (Clerk enabled), the CF Access path
 * is skipped — Clerk handles auth instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const logSecurityEventSpy = vi.fn()
const getDatabaseSpy = vi.fn()

vi.mock('@/lib/security-events', () => ({
  logSecurityEvent: (...args: unknown[]) => logSecurityEventSpy(...args),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => getDatabaseSpy(),
}))

vi.mock('@/lib/password', () => ({
  hashPassword: vi.fn((p: string) => `hashed:${p}`),
  verifyPassword: vi.fn(() => false),
  verifyPasswordWithRehashCheck: vi.fn(() => ({ valid: false, needsRehash: false })),
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn(), on: vi.fn(), emit: vi.fn() },
}))

import { getUserFromRequest } from '@/lib/auth'

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/test', { headers: new Headers(headers) })
}

type UserRow = {
  id: number
  username: string
  display_name: string
  role: 'admin' | 'operator' | 'viewer'
  workspace_id: number
  tenant_id?: number
  provider?: 'local' | 'google'
  email?: string | null
  avatar_url?: string | null
  is_approved?: number
  created_at?: number
  updated_at?: number
  last_login_at?: number | null
}

function makeFakeDb(opts: { userRow?: UserRow | null; workspaceRow?: { id: number; tenant_id: number } | null } = {}) {
  const userRow = opts.userRow ?? null
  const workspaceRow = opts.workspaceRow ?? { id: 1, tenant_id: 1 }
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((..._args: unknown[]) => {
        const norm = sql.replace(/\s+/g, ' ').trim()
        if (norm.startsWith('SELECT u.id, u.username')) return userRow ?? undefined
        if (norm.startsWith('SELECT id, tenant_id') || norm.startsWith('SELECT tenant_id')) return workspaceRow ?? undefined
        if (norm.includes("FROM settings WHERE key = 'security.api_key'")) return undefined
        return undefined
      }),
      run: vi.fn(),
      all: vi.fn(() => []),
    })),
  }
}

describe('CF Access auth path — getUserFromRequest', () => {
  const originalEnv = process.env

  beforeEach(() => {
    logSecurityEventSpy.mockClear()
    getDatabaseSpy.mockClear()
    process.env = { ...originalEnv }
    delete process.env.CLERK_SECRET_KEY
    delete process.env.MC_CLERK_ORG_SLUG
    delete process.env.MC_PROXY_AUTH_HEADER
    delete process.env.API_KEY
    delete process.env.MC_PROXY_AUTH_DEFAULT_ROLE
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('resolves existing user from cf-access-authenticated-user-email when Clerk is disabled', () => {
    getDatabaseSpy.mockReturnValue(
      makeFakeDb({
        userRow: {
          id: 42,
          username: 'austin@ceremoniacircle.org',
          display_name: 'Austin',
          role: 'admin',
          workspace_id: 1,
          tenant_id: 1,
          provider: 'local',
          email: 'austin@ceremoniacircle.org',
          avatar_url: null,
          is_approved: 1,
          created_at: 0,
          updated_at: 0,
          last_login_at: null,
        },
      }),
    )
    const req = makeRequest({ 'cf-access-authenticated-user-email': 'austin@ceremoniacircle.org' })
    const user = getUserFromRequest(req)
    expect(user).not.toBeNull()
    expect(user!.username).toBe('austin@ceremoniacircle.org')
    expect(user!.role).toBe('admin')
  })

  it('returns null when CF Access header present but user does not exist and no auto-provision role', () => {
    getDatabaseSpy.mockReturnValue(makeFakeDb({ userRow: null }))
    const req = makeRequest({ 'cf-access-authenticated-user-email': 'unknown@example.com' })
    const user = getUserFromRequest(req)
    expect(user).toBeNull()
  })

  it('returns null (falls through) when no CF Access header and no other auth', () => {
    getDatabaseSpy.mockReturnValue(makeFakeDb())
    const req = makeRequest({})
    const user = getUserFromRequest(req)
    expect(user).toBeNull()
  })

  it('ignores CF Access header when CLERK_SECRET_KEY is set (Clerk takes precedence)', () => {
    process.env.CLERK_SECRET_KEY = 'sk_test_xxx'
    getDatabaseSpy.mockReturnValue(
      makeFakeDb({
        userRow: {
          id: 42,
          username: 'austin@ceremoniacircle.org',
          display_name: 'Austin',
          role: 'admin',
          workspace_id: 1,
          tenant_id: 1,
          provider: 'local',
          email: 'austin@ceremoniacircle.org',
          avatar_url: null,
          is_approved: 1,
          created_at: 0,
          updated_at: 0,
          last_login_at: null,
        },
      }),
    )
    // CF Access header present but Clerk is enabled — Clerk path requires x-clerk-user-email
    // which is absent, so Clerk falls through AND CF Access block is skipped.
    const req = makeRequest({ 'cf-access-authenticated-user-email': 'austin@ceremoniacircle.org' })
    const user = getUserFromRequest(req)
    expect(user).toBeNull()
  })

  it('returns null when CF Access email is empty string', () => {
    getDatabaseSpy.mockReturnValue(makeFakeDb())
    const req = makeRequest({ 'cf-access-authenticated-user-email': '   ' })
    const user = getUserFromRequest(req)
    expect(user).toBeNull()
  })
})
