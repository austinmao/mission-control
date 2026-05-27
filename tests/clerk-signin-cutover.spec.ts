/**
 * Lane T3 — CF Access auth gate proof.
 *
 * Verifies all 3 `mc-{tenant}.holalumina.com` redirect unauthenticated
 * requests to Cloudflare Access login (*.cloudflareaccess.com). This
 * proves CF Access is the auth surface after the Clerk-removal migration
 * (CLERK_SECRET_KEY removed from all mc-* envs, 2026-05-27).
 *
 * Previously this test verified Clerk redirects to accounts.holalumina.com.
 * CF Access handles auth at the edge before requests reach the container.
 *
 * Cost: $0 (no auth, no LLM, just HTTP probe).
 */
import { expect, test } from '@playwright/test'

import { TENANT_SUBDOMAINS } from './helpers/clerk-prod-auth'

test.describe('CF Access auth gate (all 3 MCs)', () => {
  for (const [slug, host] of Object.entries(TENANT_SUBDOMAINS)) {
    test(`mc-${slug} (${host}) redirects unauth to cloudflareaccess.com`, async ({ request }) => {
      const res = await request.get(`https://${host}/`, { maxRedirects: 0 })
      // CF Access emits 302 to its own login endpoint before the request reaches MC
      expect([302, 307]).toContain(res.status())
      const loc = res.headers()['location']
      expect(loc).toBeTruthy()
      expect(loc).toMatch(/cloudflareaccess\.com/)
    })
  }

  test('all 3 MCs redirect to cloudflareaccess.com (CF Access gate active)', async ({ request }) => {
    const locs = await Promise.all(
      Object.values(TENANT_SUBDOMAINS).map(async (host) => {
        const res = await request.get(`https://${host}/`, { maxRedirects: 0 })
        const loc = res.headers()['location'] || ''
        return loc
      }),
    )
    for (const loc of locs) {
      expect(loc).toMatch(/cloudflareaccess\.com/)
    }
  })
})
