/**
 * Proxy auth path (MC_PROXY_AUTH_HEADER) in getUserFromRequest.
 *
 * When MC_PROXY_AUTH_HEADER is set AND the request originates from a
 * trusted IP (MC_PROXY_AUTH_TRUSTED_IPS), the value of the configured
 * header is treated as an authenticated username — no local session
 * required.
 *
 * CF Access is one use case: set MC_PROXY_AUTH_HEADER=cf-access-authenticated-user-email
 * and MC_PROXY_AUTH_TRUSTED_IPS to Cloudflare edge IPs. The old hardcoded
 * CF Access block was removed; this env-var path handles it generically.
 *
 * PROXY_AUTH_TRUSTED_IPS is a module-level Set built at load time, so each
 * test that needs different IP config uses vi.resetModules() + dynamic import.
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

const EXISTING_USER: UserRow = {
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
}

describe('MC_PROXY_AUTH_HEADER path — getUserFromRequest', () => {
  const originalEnv = process.env

  beforeEach(() => {
    logSecurityEventSpy.mockClear()
    getDatabaseSpy.mockClear()
    process.env = { ...originalEnv }
    delete process.env.CLERK_SECRET_KEY
    delete process.env.MC_CLERK_ORG_SLUG
    delete process.env.MC_PROXY_AUTH_HEADER
    delete process.env.MC_PROXY_AUTH_TRUSTED_IPS
    delete process.env.MC_PROXY_AUTH_DEFAULT_ROLE
    delete process.env.API_KEY
    vi.resetModules()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.resetModules()
  })

  it('resolves existing user when request comes from trusted IP with configured header', async () => {
    process.env.MC_PROXY_AUTH_HEADER = 'cf-access-authenticated-user-email'
    process.env.MC_PROXY_AUTH_TRUSTED_IPS = '127.0.0.1'
    getDatabaseSpy.mockReturnValue(makeFakeDb({ userRow: EXISTING_USER }))

    const { getUserFromRequest } = await import('@/lib/auth')
    // extractClientIpFromTrusted reads x-real-ip when xff IPs are all trusted.
    // Send x-real-ip pointing to the trusted proxy so the check passes.
    const req = makeRequest({
      'x-real-ip': '127.0.0.1',
      'cf-access-authenticated-user-email': 'austin@ceremoniacircle.org',
    })
    const user = getUserFromRequest(req)
    expect(user).not.toBeNull()
    expect(user!.username).toBe('austin@ceremoniacircle.org')
    expect(user!.role).toBe('admin')
  })

  it('returns null when request IP is not in trusted list', async () => {
    process.env.MC_PROXY_AUTH_HEADER = 'cf-access-authenticated-user-email'
    process.env.MC_PROXY_AUTH_TRUSTED_IPS = '10.0.0.1'
    getDatabaseSpy.mockReturnValue(makeFakeDb({ userRow: EXISTING_USER }))

    const { getUserFromRequest } = await import('@/lib/auth')
    const req = makeRequest({
      'x-real-ip': '1.2.3.4', // untrusted IP
      'cf-access-authenticated-user-email': 'austin@ceremoniacircle.org',
    })
    const user = getUserFromRequest(req)
    expect(user).toBeNull()
  })

  it('returns null and logs warning when MC_PROXY_AUTH_TRUSTED_IPS is empty (misconfiguration)', async () => {
    process.env.MC_PROXY_AUTH_HEADER = 'cf-access-authenticated-user-email'
    // MC_PROXY_AUTH_TRUSTED_IPS intentionally unset
    getDatabaseSpy.mockReturnValue(makeFakeDb({ userRow: EXISTING_USER }))

    const { getUserFromRequest } = await import('@/lib/auth')
    const req = makeRequest({
      'x-forwarded-for': '127.0.0.1',
      'cf-access-authenticated-user-email': 'austin@ceremoniacircle.org',
    })
    const user = getUserFromRequest(req)
    // Auth fails — misconfiguration path skips resolution
    expect(user).toBeNull()
  })

  it('returns null when configured header is absent from request', async () => {
    process.env.MC_PROXY_AUTH_HEADER = 'cf-access-authenticated-user-email'
    process.env.MC_PROXY_AUTH_TRUSTED_IPS = '127.0.0.1'
    getDatabaseSpy.mockReturnValue(makeFakeDb({ userRow: EXISTING_USER }))

    const { getUserFromRequest } = await import('@/lib/auth')
    const req = makeRequest({ 'x-real-ip': '127.0.0.1' }) // no auth header
    const user = getUserFromRequest(req)
    expect(user).toBeNull()
  })

  it('returns null when user does not exist and no auto-provision role', async () => {
    process.env.MC_PROXY_AUTH_HEADER = 'cf-access-authenticated-user-email'
    process.env.MC_PROXY_AUTH_TRUSTED_IPS = '127.0.0.1'
    getDatabaseSpy.mockReturnValue(makeFakeDb({ userRow: null }))

    const { getUserFromRequest } = await import('@/lib/auth')
    const req = makeRequest({
      'x-real-ip': '127.0.0.1',
      'cf-access-authenticated-user-email': 'unknown@example.com',
    })
    const user = getUserFromRequest(req)
    expect(user).toBeNull()
  })

  it('returns null (falls through) when MC_PROXY_AUTH_HEADER is unset', async () => {
    // No proxy auth configured — header has no effect
    getDatabaseSpy.mockReturnValue(makeFakeDb({ userRow: EXISTING_USER }))

    const { getUserFromRequest } = await import('@/lib/auth')
    const req = makeRequest({
      'x-real-ip': '127.0.0.1',
      'cf-access-authenticated-user-email': 'austin@ceremoniacircle.org',
    })
    const user = getUserFromRequest(req)
    expect(user).toBeNull()
  })

  it('works with a custom proxy header name (not CF Access)', async () => {
    process.env.MC_PROXY_AUTH_HEADER = 'x-auth-username'
    process.env.MC_PROXY_AUTH_TRUSTED_IPS = '10.10.0.1'
    getDatabaseSpy.mockReturnValue(makeFakeDb({ userRow: EXISTING_USER }))

    const { getUserFromRequest } = await import('@/lib/auth')
    const req = makeRequest({
      'x-real-ip': '10.10.0.1',
      'x-auth-username': 'austin@ceremoniacircle.org',
    })
    const user = getUserFromRequest(req)
    expect(user).not.toBeNull()
    expect(user!.username).toBe('austin@ceremoniacircle.org')
  })
})
