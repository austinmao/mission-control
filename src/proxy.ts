import crypto from 'node:crypto'
import os from 'node:os'
import { NextResponse, NextRequest } from 'next/server'
import type { NextFetchEvent } from 'next/server'
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { buildMissionControlCsp, buildNonceRequestHeaders } from '@/lib/csp'
import { MC_SESSION_COOKIE_NAME, LEGACY_MC_SESSION_COOKIE_NAME } from '@/lib/session-cookie'

// Phase 3 BUILD D2-D6 — Clerk SSO edge integration.
// When CLERK_SECRET_KEY is set, the proxy first runs Clerk JWT
// verification, then injects trusted headers (x-clerk-user-email +
// x-clerk-org-slug) consumed downstream by getUserFromRequest. Pre-
// cutover tenants run with CLERK_SECRET_KEY unset and skip the Clerk
// path entirely. Defense in depth: when Clerk is disabled we still
// strip those headers in case a request smuggled them.
function isClerkEnabled(): boolean {
  return Boolean((process.env.CLERK_SECRET_KEY || '').trim())
}

const CLERK_HEADER_NAMES = [
  'x-clerk-user-email',
  'x-clerk-org-slug',
  'x-clerk-user-id',
] as const

const isClerkPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/auth/clerk/webhook',
  '/login',
  '/setup',
  '/api/setup',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/google(.*)',
  '/api/docs',
  '/docs',
])

/** Constant-time string comparison using Node.js crypto. */
function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined) return false
  const v = String(raw).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function normalizeHostname(raw: string): string {
  return raw.trim().replace(/^\[|\]$/g, '').split(':')[0].replace(/\.$/, '').toLowerCase()
}

function parseForwardedHost(forwarded: string | null): string[] {
  if (!forwarded) return []
  const hosts: string[] = []
  for (const part of forwarded.split(',')) {
    const match = /(?:^|;)\s*host="?([^";]+)"?/i.exec(part)
    if (match?.[1]) hosts.push(match[1])
  }
  return hosts
}

function getRequestHostCandidates(request: NextRequest): string[] {
  const rawCandidates = [
    ...(request.headers.get('x-forwarded-host') || '').split(','),
    ...(request.headers.get('x-original-host') || '').split(','),
    ...(request.headers.get('x-forwarded-server') || '').split(','),
    ...parseForwardedHost(request.headers.get('forwarded')),
    request.headers.get('host') || '',
    request.nextUrl.host || '',
    request.nextUrl.hostname || '',
  ]

  const candidates = rawCandidates
    .map(normalizeHostname)
    .filter(Boolean)

  return [...new Set(candidates)]
}

function getImplicitAllowedHosts(): string[] {
  const candidates = [
    'localhost',
    '127.0.0.1',
    '::1',
    normalizeHostname(os.hostname()),
  ].filter(Boolean)

  return [...new Set(candidates)]
}

function hostMatches(pattern: string, hostname: string): boolean {
  const p = normalizeHostname(pattern)
  const h = normalizeHostname(hostname)
  if (!p || !h) return false

  // "*.example.com" matches "a.example.com" (but not bare "example.com")
  if (p.startsWith('*.')) {
    const suffix = p.slice(2)
    return h.endsWith(`.${suffix}`)
  }

  // "100.*" matches "100.64.0.1"
  if (p.endsWith('.*')) {
    const prefix = p.slice(0, -1)
    return h.startsWith(prefix)
  }

  return h === p
}

/** Normalize a host:port string by stripping default ports (80 for http, 443 for https). */
function stripDefaultPort(host: string): string {
  const h = host.toLowerCase()
  if (h.endsWith(':443')) return h.slice(0, -4)
  if (h.endsWith(':80')) return h.slice(0, -3)
  return h
}

/**
 * Compare a request host candidate with the Origin host for CSRF validation.
 * Handles port mismatches caused by reverse proxies (e.g. Origin includes :8443
 * but the Host header may have been rewritten or stripped by the proxy).
 */
function hostsMatchForCsrf(requestHost: string, originHost: string): boolean {
  const a = normalizeHostname(requestHost)
  const b = normalizeHostname(originHost)
  if (!a || !b) return false
  // Exact match first
  if (a === b) return true
  // Match after stripping default ports
  return stripDefaultPort(a) === stripDefaultPort(b)
}

function nextResponseWithNonce(request: NextRequest): { response: NextResponse; nonce: string } {
  const nonce = crypto.randomBytes(16).toString('base64')
  const googleEnabled = !!(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)
  const requestHeaders = buildNonceRequestHeaders({
    headers: request.headers,
    nonce,
    googleEnabled,
  })
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
  // Debug log retained (commented) for future CSP/nonce flow troubleshooting.
  // console.log(`[DEBUG csp] proxy generated nonce for ${request.nextUrl.pathname}: ${nonce.slice(0, 8)}...`)
  return { response, nonce }
}

function addSecurityHeaders(response: NextResponse, _request: NextRequest, nonce?: string): NextResponse {
  const requestId = crypto.randomUUID()
  response.headers.set('X-Request-Id', requestId)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  const googleEnabled = !!(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)
  const effectiveNonce = nonce || crypto.randomBytes(16).toString('base64')
  response.headers.set('Content-Security-Policy', buildMissionControlCsp({ nonce: effectiveNonce, googleEnabled }))

  return response
}

function extractApiKeyFromRequest(request: NextRequest): string {
  const direct = (request.headers.get('x-api-key') || '').trim()
  if (direct) return direct

  const authorization = (request.headers.get('authorization') || '').trim()
  if (!authorization) return ''

  const [scheme, ...rest] = authorization.split(/\s+/)
  if (!scheme || rest.length === 0) return ''
  const normalized = scheme.toLowerCase()
  if (normalized === 'bearer' || normalized === 'apikey' || normalized === 'token') {
    return rest.join(' ').trim()
  }
  return ''
}

function stripClerkHeadersFromRequest(request: NextRequest): NextRequest {
  // Defense in depth: when Clerk is disabled, strip any Clerk headers
  // a client may have smuggled in. With Clerk enabled, the wrapper
  // overwrites these headers from verified JWT claims (the writer wins
  // — clients can't poison the trusted-header path).
  let hasAnyClerkHeader = false
  for (const name of CLERK_HEADER_NAMES) {
    if (request.headers.has(name)) {
      hasAnyClerkHeader = true
      break
    }
  }
  if (!hasAnyClerkHeader) return request
  const sanitized = new Headers(request.headers)
  for (const name of CLERK_HEADER_NAMES) sanitized.delete(name)
  return new NextRequest(request, { headers: sanitized })
}

export function proxy(request: NextRequest) {
  // Network access control.
  // In production: default-deny unless explicitly allowed.
  // In dev/test: allow all hosts unless overridden.
  const requestHosts = getRequestHostCandidates(request)
  const allowAnyHost = envFlag('MC_ALLOW_ANY_HOST') || process.env.NODE_ENV !== 'production'
  const allowedPatterns = String(process.env.MC_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const implicitAllowedHosts = getImplicitAllowedHosts()

  const enforceAllowlist = !allowAnyHost && allowedPatterns.length > 0
  const isAllowedHost = !enforceAllowlist
    || requestHosts.some((hostName) =>
      implicitAllowedHosts.some((candidate) => hostMatches(candidate, hostName))
      || allowedPatterns.some((pattern) => hostMatches(pattern, hostName))
    )

  if (!isAllowedHost) {
    return addSecurityHeaders(new NextResponse('Forbidden', { status: 403 }), request)
  }

  const { pathname } = request.nextUrl

  // CSRF Origin validation for mutating requests
  const method = request.method.toUpperCase()
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const origin = request.headers.get('origin')
    if (origin) {
      let originHost: string
      try { originHost = new URL(origin).host } catch { originHost = '' }
      if (originHost && !requestHosts.some((h) => hostsMatchForCsrf(h, originHost))) {
        return addSecurityHeaders(NextResponse.json({ error: 'CSRF origin mismatch' }, { status: 403 }), request)
      }
    }
  }

  // Allow login, setup, auth API, docs, and container health probe without session
  const isPublicHealthProbe = pathname === '/api/status' && request.nextUrl.searchParams.get('action') === 'health'
  if (pathname === '/login' || pathname === '/setup' || pathname.startsWith('/api/auth/') || pathname === '/api/setup' || pathname === '/api/docs' || pathname === '/docs' || isPublicHealthProbe) {
    const { response, nonce } = nextResponseWithNonce(request)
    return addSecurityHeaders(response, request, nonce)
  }

  // Check for session cookie
  const sessionToken = request.cookies.get(MC_SESSION_COOKIE_NAME)?.value || request.cookies.get(LEGACY_MC_SESSION_COOKIE_NAME)?.value

  // API routes: accept session cookie OR API key
  if (pathname.startsWith('/api/')) {
    const configuredApiKey = (process.env.API_KEY || '').trim()
    const apiKey = extractApiKeyFromRequest(request)
    const hasValidApiKey = Boolean(configuredApiKey && apiKey && safeCompare(apiKey, configuredApiKey))

    // Agent-scoped keys are validated in route auth (DB-backed) and should be
    // allowed to pass through proxy auth gate.
    const looksLikeAgentApiKey = /^mca_[a-f0-9]{48}$/i.test(apiKey)

    if (sessionToken || hasValidApiKey || looksLikeAgentApiKey) {
      const { response, nonce } = nextResponseWithNonce(request)
      return addSecurityHeaders(response, request, nonce)
    }

    return addSecurityHeaders(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), request)
  }

  // Page routes: redirect to login if no session
  if (sessionToken) {
    const { response, nonce } = nextResponseWithNonce(request)
    return addSecurityHeaders(response, request, nonce)
  }

  // Redirect to login
  const loginUrl = request.nextUrl.clone()
  loginUrl.pathname = '/login'
  return addSecurityHeaders(NextResponse.redirect(loginUrl), request)
}

// Phase 3 BUILD D2-D6 — Clerk-aware default export.
// Next.js 16 invokes the default export from proxy.ts; we delegate to
// the existing `proxy` function unless Clerk is enabled, in which case
// we first run clerkMiddleware → verify JWT → org gate → inject trusted
// headers, then call `proxy` with the augmented request.
const clerkWrappedProxy = clerkMiddleware(async (auth, request: NextRequest) => {
  if (isClerkPublicRoute(request)) {
    return proxy(request)
  }
  const session = await auth()
  if (!session.userId) {
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return new NextResponse('Unauthorized', { status: 401 })
    }
    return session.redirectToSignIn({ returnBackUrl: request.url })
  }
  const claims = session.sessionClaims as
    | { email?: string; o?: { id?: string; slg?: string } }
    | null
    | undefined
  const orgSlug =
    claims?.o?.slg || (session as { orgSlug?: string }).orgSlug || ''
  const email = claims?.email || ''

  const expectedOrg = (process.env.MC_CLERK_ORG_SLUG || '').trim()
  if (expectedOrg && orgSlug !== expectedOrg) {
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return new NextResponse('Forbidden — org mismatch', { status: 403 })
    }
    return session.redirectToSignIn({ returnBackUrl: request.url })
  }

  // Build a new NextRequest carrying the trusted Clerk headers.
  const headers = new Headers(request.headers)
  headers.set('x-clerk-user-email', email || session.userId)
  headers.set('x-clerk-org-slug', orgSlug)
  headers.set('x-clerk-user-id', session.userId)
  const requestWithClerk = new NextRequest(request, { headers })
  return proxy(requestWithClerk)
})

export default function proxyEntry(request: NextRequest, event: NextFetchEvent) {
  if (!isClerkEnabled()) {
    return proxy(stripClerkHeadersFromRequest(request))
  }
  return clerkWrappedProxy(request, event)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|brand/).*)']
}
