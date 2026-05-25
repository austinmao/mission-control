import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

function makeRequest(url: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(url, { headers })
}

describe('getPublicReturnUrl (returnBackUrl for Clerk)', () => {
  it('uses x-forwarded-host + x-forwarded-proto when behind Caddy', async () => {
    const { __test_getPublicReturnUrl } = await import('../../proxy')
    const req = makeRequest('http://0.0.0.0:3000/dashboard?x=1', {
      'x-forwarded-host': 'mc-lumina.holalumina.com',
      'x-forwarded-proto': 'https',
      host: '0.0.0.0:3000',
    })
    expect(__test_getPublicReturnUrl(req)).toBe(
      'https://mc-lumina.holalumina.com/dashboard?x=1'
    )
  })

  it('falls back to Host header when forwarded headers absent', async () => {
    const { __test_getPublicReturnUrl } = await import('../../proxy')
    const req = makeRequest('http://0.0.0.0:3000/login', {
      host: 'mc-ceremonia.holalumina.com',
    })
    expect(__test_getPublicReturnUrl(req)).toBe(
      'https://mc-ceremonia.holalumina.com/login'
    )
  })

  it('picks first value when forwarded headers are comma-separated', async () => {
    const { __test_getPublicReturnUrl } = await import('../../proxy')
    const req = makeRequest('http://0.0.0.0:3000/agents', {
      'x-forwarded-host': 'mc-eric.holalumina.com, internal.example',
      'x-forwarded-proto': 'https, http',
    })
    expect(__test_getPublicReturnUrl(req)).toBe(
      'https://mc-eric.holalumina.com/agents'
    )
  })

  it('preserves query string', async () => {
    const { __test_getPublicReturnUrl } = await import('../../proxy')
    const req = makeRequest(
      'http://0.0.0.0:3000/api/sessions/abc?action=list&limit=10',
      {
        'x-forwarded-host': 'mc-lumina.holalumina.com',
        'x-forwarded-proto': 'https',
      }
    )
    expect(__test_getPublicReturnUrl(req)).toBe(
      'https://mc-lumina.holalumina.com/api/sessions/abc?action=list&limit=10'
    )
  })

  it('defaults to https when no proto header present', async () => {
    const { __test_getPublicReturnUrl } = await import('../../proxy')
    const req = makeRequest('http://0.0.0.0:3000/', {
      'x-forwarded-host': 'mc-lumina.holalumina.com',
    })
    expect(__test_getPublicReturnUrl(req)).toBe(
      'https://mc-lumina.holalumina.com/'
    )
  })
})

describe('isClerkPublicRoute matcher — /api/status must NOT be in publicRoutes', () => {
  it('does not list /api/status in createRouteMatcher (isPublicHealthStatusProbe handles it)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const proxySrc = fs.readFileSync(
      path.resolve(__dirname, '../../proxy.ts'),
      'utf8'
    )
    const matcherBlock = proxySrc.match(
      /isClerkPublicRoute = createRouteMatcher\(\[([\s\S]*?)\]\)/
    )?.[1]
    expect(matcherBlock).toBeTruthy()
    // /api/status must NOT be in the Clerk public-route matcher.
    // The health + capabilities probes are handled by isPublicHealthStatusProbe
    // before Clerk auth runs; adding it to the matcher skips x-clerk-user-id
    // injection, causing 401 for authenticated browser requests.
    expect(matcherBlock).not.toContain("'/api/status'")
  })
})

describe('/api/status route — capabilities must be pre-auth', () => {
  it('handles ?action=capabilities before requireRole in route source', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const routeSrc = fs.readFileSync(
      path.resolve(__dirname, '../../app/api/status/route.ts'),
      'utf8'
    )
    // capabilities pre-auth block must appear before requireRole call
    const capIdx = routeSrc.indexOf("preAction === 'capabilities'")
    const authIdx = routeSrc.indexOf('requireRole(')
    expect(capIdx).toBeGreaterThan(-1)
    expect(authIdx).toBeGreaterThan(-1)
    expect(capIdx).toBeLessThan(authIdx)
  })
})
