/**
 * MC Phase 1 — Cross-tenant 403 E2E (T7)
 *
 * Source: T7 (eng-review JSONL) + D10 — silent failure mode if CF Access misconfigured.
 *
 * Verifies per-tenant MC isolation:
 *   1. Authenticated user for tenant A CANNOT reach mc-B.holalumina.com (CF Access denies)
 *   2. Authenticated user for tenant A CAN reach mc-A.holalumina.com
 *   3. Unauthenticated request to any mc-* hostname is challenged by CF Access
 *
 * Phase 1 exit gate. Failure = HARD STOP on deploy.
 *
 * Pre-reqs:
 *   - 3 MC containers deployed + /api/status returns 200
 *   - 3 CF Access apps configured with per-tenant email allowlists
 *   - Per-tenant CF Access service tokens issued + env vars set
 */

import { test, expect, request } from '@playwright/test';

const TENANTS = [
  {
    slug: 'ceremonia',
    url: process.env.MC_CEREMONIA_URL ?? 'https://mc-ceremonia.holalumina.com',
    tokenId: process.env.CF_ACCESS_CEREMONIA_TOKEN_ID,
    tokenSecret: process.env.CF_ACCESS_CEREMONIA_TOKEN_SECRET,
  },
  {
    slug: 'eric',
    url: process.env.MC_ERIC_URL ?? 'https://mc-eric.holalumina.com',
    tokenId: process.env.CF_ACCESS_ERIC_TOKEN_ID,
    tokenSecret: process.env.CF_ACCESS_ERIC_TOKEN_SECRET,
  },
  {
    slug: 'lumina',
    url: process.env.MC_LUMINA_URL ?? 'https://mc-lumina.holalumina.com',
    tokenId: process.env.CF_ACCESS_LUMINA_TOKEN_ID,
    tokenSecret: process.env.CF_ACCESS_LUMINA_TOKEN_SECRET,
  },
];

function authHeaders(tenant: typeof TENANTS[number]): Record<string, string> {
  if (!tenant.tokenId || !tenant.tokenSecret) {
    throw new Error(
      `CF Access service token missing for ${tenant.slug}. ` +
        `Set CF_ACCESS_${tenant.slug.toUpperCase()}_TOKEN_ID + _TOKEN_SECRET.`,
    );
  }
  return {
    'CF-Access-Client-Id': tenant.tokenId,
    'CF-Access-Client-Secret': tenant.tokenSecret,
  };
}

test.describe('Phase 1 cross-tenant isolation (T7)', () => {
  test('unauthenticated request to mc-ceremonia is challenged', async () => {
    const ctx = await request.newContext({ extraHTTPHeaders: {} });
    const res = await ctx.get(`${TENANTS[0].url}/api/status`, { failOnStatusCode: false });
    // CF Access challenges: 302 → access.cloudflareaccess.com OR 401/403 if no Identity provider
    expect([302, 401, 403]).toContain(res.status());
  });

  for (const own of TENANTS) {
    test(`tenant ${own.slug} CAN reach own MC`, async () => {
      const ctx = await request.newContext({ extraHTTPHeaders: authHeaders(own) });
      const res = await ctx.get(`${own.url}/api/status`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.healthy).toBe(true);
    });

    for (const other of TENANTS) {
      if (other.slug === own.slug) continue;
      test(`tenant ${own.slug} CANNOT reach mc-${other.slug} (cross-tenant deny)`, async () => {
        // OWN tenant's CF Access service token against OTHER tenant's URL
        const ctx = await request.newContext({ extraHTTPHeaders: authHeaders(own) });
        const res = await ctx.get(`${other.url}/api/status`, { failOnStatusCode: false });
        // Expected: CF Access denies because own.tokenId is not in other tenant's policy
        expect([401, 403]).toContain(res.status());
        // Defensive: ensure no MC content leaks via error page
        const body = await res.text();
        expect(body).not.toMatch(/agents|tasks|sessions/i);
      });
    }
  }

  // Bonus: data-layer isolation via /api/whoami (if MC fork exposes it)
  for (const tenant of TENANTS) {
    test(`tenant ${tenant.slug} /api/whoami returns own tenant_id`, async () => {
      const ctx = await request.newContext({ extraHTTPHeaders: authHeaders(tenant) });
      const res = await ctx.get(`${tenant.url}/api/whoami`, { failOnStatusCode: false });
      if (res.status() === 404) {
        test.skip(true, '/api/whoami not implemented yet — skipping data-layer isolation check');
        return;
      }
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.tenant_slug).toBe(tenant.slug);
    });
  }
});

/**
 * Exit gate semantics:
 *   - 1 unauth + 3 own-reach + 6 cross-tenant-deny + 3 whoami = 13 tests
 *   - Skipped /api/whoami acceptable (not yet implemented in MC fork)
 *   - Any cross-tenant FAIL = STOP DEPLOY, rollback per docs/runbooks/mc-rollback-rehearsal.md
 */
