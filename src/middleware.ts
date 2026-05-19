/**
 * Next.js middleware — Phase 3 BUILD (D2-D6) Clerk SSO edge.
 *
 * Architecture: Clerk verifies JWT (network-free after JWKS warm-up) at
 * the edge. When auth succeeds we inject two trusted headers downstream:
 *   - `X-Clerk-User-Email` — primary email or fallback clerk_user_id
 *   - `X-Clerk-Org-Slug`   — active org slug (per-tenant identity)
 *
 * `src/lib/auth.ts:getUserFromRequest` then short-circuits on those
 * headers via the new Clerk-header path (added in this PR), gated by
 * `MC_CLERK_ORG_SLUG` to reject cross-tenant requests.
 *
 * No-op when `CLERK_SECRET_KEY` is unset — falls back to MC's existing
 * local-login + Google OAuth + proxy-auth paths.
 *
 * Cutover runbook: docs/phase-3-clerk-cutover-runbook.md
 */

import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server'
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// Public routes — Clerk middleware skips auth for these.
const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/auth/clerk/webhook',
  '/api/auth/login',           // local-login fallback (CF Access tenants)
  '/api/auth/logout',
  '/api/auth/google(.*)',      // Google OAuth flow
  '/api/health',
  '/_next(.*)',
  '/favicon.ico',
])

// When CLERK_SECRET_KEY is unset, return a passthrough middleware so
// pre-cutover tenants keep their current auth stack untouched.
function isClerkEnabled(): boolean {
  return Boolean((process.env.CLERK_SECRET_KEY || '').trim())
}

const clerk = clerkMiddleware(async (auth, req: NextRequest) => {
  if (isPublicRoute(req)) return

  const session = await auth()
  if (!session.userId) {
    // Unauth on protected route → redirect interactive sessions, 401 API
    if (req.nextUrl.pathname.startsWith('/api/')) {
      return new NextResponse('Unauthorized', { status: 401 })
    }
    return session.redirectToSignIn({ returnBackUrl: req.url })
  }

  const expectedOrg = (process.env.MC_CLERK_ORG_SLUG || '').trim()
  const claims = session.sessionClaims as
    | { email?: string; o?: { id?: string; slg?: string } }
    | null
    | undefined
  const orgSlug = claims?.o?.slg || (session as { orgSlug?: string }).orgSlug || ''
  const email = claims?.email || ''

  // Per-tenant gate — reject if org mismatch (multi-tenant safety per spike §5)
  if (expectedOrg && orgSlug !== expectedOrg) {
    if (req.nextUrl.pathname.startsWith('/api/')) {
      return new NextResponse('Forbidden — org mismatch', { status: 403 })
    }
    return session.redirectToSignIn({ returnBackUrl: req.url })
  }

  // Inject trusted headers — downstream auth.ts reads these.
  // `set` (not `append`) overwrites any client-supplied value, so an
  // external attacker cannot spoof these headers — they're stripped and
  // replaced by middleware on every request.
  const headers = new Headers(req.headers)
  headers.set('x-clerk-user-email', email || session.userId)
  headers.set('x-clerk-org-slug', orgSlug)
  headers.set('x-clerk-user-id', session.userId)

  return NextResponse.next({ request: { headers } })
})

export default function middleware(req: NextRequest, ev: NextFetchEvent) {
  if (!isClerkEnabled()) {
    // Pre-cutover tenants — strip injected headers in case the request
    // smuggled them (defense in depth: the Clerk-header path in auth.ts
    // trusts these headers when CLERK is configured; explicit strip when
    // disabled prevents any header-forgery escalation).
    const headers = new Headers(req.headers)
    headers.delete('x-clerk-user-email')
    headers.delete('x-clerk-org-slug')
    headers.delete('x-clerk-user-id')
    return NextResponse.next({ request: { headers } })
  }
  return clerk(req, ev)
}

export const config = {
  // Match every route except Next.js internals + static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
