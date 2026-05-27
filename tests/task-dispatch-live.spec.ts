/**
 * Live task-dispatch browser E2E tests — MC-specific routes.
 *
 * Drives the Mission Control browser UI at the MC-specific panel routes:
 *   /tasks    — create task, watch status reach "completed" in browser
 *   /chat     — send message to main agent, watch reply arrive
 *   /agents   — spawn sub-agent, verify registration in agent list
 *   /activity — verify task dispatch event appears in activity feed
 *
 * Requires a real OpenClaw gateway (status online/healthy/ready).
 * Each test skips itself when the gateway is unreachable so the suite
 * stays green in local CI without a live gateway.
 *
 * Agent responses are async (30–120 s). Each test polls the API while
 * the browser stays open on the relevant MC route, then reloads to
 * verify the page renders correctly after agent activity.
 */

import { type APIRequestContext, type Page, expect, test } from '@playwright/test'
import { API_KEY_HEADER, createTestTask, deleteTestTask } from './helpers'

// ── timeouts ──────────────────────────────────────────────────────────────────
const AGENT_RESPONSE_MS = 120_000
const POLL_INTERVAL_MS = 3_000
const PLACEHOLDER = 'Deferred agent run completed without textual output.'

// ── local MC auth ─────────────────────────────────────────────────────────────
const MC_USER = process.env.AUTH_USER || 'testadmin'
const MC_PASS = process.env.AUTH_PASS || 'testpass1234!'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Login via /login page then navigate to path. */
async function loginAndNavigate(page: Page, path: string): Promise<void> {
  await page.goto('/login')
  await page.waitForURL(/\/login/, { timeout: 10_000 })

  // Fill username — try common selector shapes
  const usernameInput = page.locator(
    'input[name="username"], input[autocomplete="username"], input[type="text"]:first-of-type'
  ).first()
  await usernameInput.fill(MC_USER)

  const passwordInput = page.locator('input[name="password"], input[type="password"]').first()
  await passwordInput.fill(MC_PASS)

  await page.locator('button[type="submit"]').first().click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 15_000 })

  if (path !== '/') await page.goto(path)
}

/** Poll `fn` every POLL_INTERVAL_MS until truthy or deadline. */
async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  deadlineMs: number
): Promise<T | null> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    const result = await fn()
    if (result) return result as T
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  return null
}

/** Return the first online/healthy/ready gateway or null. */
async function getOnlineGateway(
  request: APIRequestContext
): Promise<{ id: number; name: string } | null> {
  // GET first — auto-seeds the gateway record from env vars if table is empty
  const seed = await request.get('/api/gateways', { headers: API_KEY_HEADER })
  if (!seed.ok()) return null

  // Now probe health — transitions seeded gateway from 'unknown' → 'online'
  await request.post('/api/gateways/health', { headers: API_KEY_HEADER }).catch(() => {})

  // Re-fetch to get the updated status
  const res = await request.get('/api/gateways', { headers: API_KEY_HEADER })
  if (!res.ok()) return null
  const body = await res.json()
  const gateways: Array<{ id: number; name: string; status: string }> =
    body.gateways ?? body ?? []
  return gateways.find(g => ['online', 'healthy', 'ready'].includes(g.status)) ?? null
}

/** Return the primary/main agent name registered in this MC instance. */
async function getMainAgentName(request: APIRequestContext): Promise<string | null> {
  const res = await request.get('/api/agents', { headers: API_KEY_HEADER })
  if (!res.ok()) return null
  const body = await res.json()
  const agents: Array<{ name: string; role?: string }> = body.agents ?? []
  const main =
    agents.find(a => a.name?.toLowerCase().includes('main')) ??
    agents.find(a => a.role === 'orchestrator') ??
    agents[0]
  return main?.name ?? null
}

/** Run first-time setup if no admin exists yet (fresh e2e DB). */
async function ensureAdminUser(request: APIRequestContext): Promise<void> {
  const check = await request.get('/api/setup').catch(() => null)
  if (!check?.ok()) return
  const { needsSetup } = await check.json()
  if (!needsSetup) return
  await request.post('/api/setup', {
    data: { username: MC_USER, password: MC_PASS, displayName: 'E2E Admin' },
  }).catch(() => {})
}

// ── suite ─────────────────────────────────────────────────────────────────────

test.describe('Live task-dispatch — MC browser (requires gateway)', () => {
  let gatewayAvailable = false
  let mainAgentName: string | null = null

  test.beforeAll(async ({ request }) => {
    await ensureAdminUser(request)
    const gw = await getOnlineGateway(request)
    gatewayAvailable = gw !== null
    if (gatewayAvailable) mainAgentName = await getMainAgentName(request)
  })

  // ── 1. /tasks — create task, watch status transition in browser ────────────

  test('MC /tasks page: task assigned to main agent completes with real resolution', async ({
    page,
    request,
  }) => {
    test.setTimeout(AGENT_RESPONSE_MS + 25_000)

    if (!gatewayAvailable) test.skip(true, 'No online gateway')
    if (!mainAgentName) test.skip(true, 'No main agent found')

    const { id: taskId } = await createTestTask(request, {
      title: `e2e-browser-ping-${Date.now()}`,
      description: 'Reply with one word: pong',
      assigned_to: mainAgentName,
      status: 'assigned',
      priority: 'high',
    })

    try {
      // Open MC /tasks in browser
      await loginAndNavigate(page, '/tasks')
      await expect(page).toHaveURL(/\/tasks/, { timeout: 10_000 })
      await expect(page.locator('main').first()).toBeVisible({ timeout: 8_000 })

      // Poll API until task reaches a completed status
      const completed = await pollUntil(async () => {
        const res = await request.get(`/api/tasks/${taskId}`, { headers: API_KEY_HEADER })
        if (!res.ok()) return null
        const body = await res.json()
        const task = body.task ?? body
        return ['completed', 'done', 'review'].includes(task.status) ? task : null
      }, AGENT_RESPONSE_MS)

      expect(
        completed,
        `Task #${taskId} did not reach completed status within ${AGENT_RESPONSE_MS / 1000}s`
      ).not.toBeNull()

      const resolution: string = completed!.resolution ?? ''
      expect(
        resolution,
        'Task resolution is the placeholder — deliver:true fix not active'
      ).not.toBe(PLACEHOLDER)
      expect(resolution.trim().length, 'Task resolution is empty').toBeGreaterThan(0)

      // Reload /tasks — page must still render after agent activity
      await page.reload()
      await expect(page.locator('main').first()).toBeVisible({ timeout: 8_000 })
    } finally {
      await deleteTestTask(request, taskId).catch(() => {})
    }
  })

  // ── 2. /chat — send message to main agent, watch reply arrive ─────────────

  test('MC /chat page: chat message to main agent produces a non-empty response', async ({
    page,
    request,
  }) => {
    test.setTimeout(AGENT_RESPONSE_MS + 15_000)

    if (!gatewayAvailable) test.skip(true, 'No online gateway')
    if (!mainAgentName) test.skip(true, 'No main agent found')

    const stamp = Date.now()
    const since = Math.floor(stamp / 1000) - 5
    const conversationId = `e2e-browser-chat-${stamp}`
    const prompt = 'Reply with the single word: pong'

    // Open MC /chat in browser
    await loginAndNavigate(page, '/chat')
    await expect(page).toHaveURL(/\/chat/, { timeout: 10_000 })
    await expect(page.locator('main').first()).toBeVisible({ timeout: 8_000 })

    // Send message via the same API endpoint the browser UI calls
    const sendRes = await request.post('/api/chat/messages', {
      headers: API_KEY_HEADER,
      data: {
        from: 'e2e-test',
        to: mainAgentName,
        content: prompt,
        message_type: 'text',
        conversation_id: conversationId,
      },
    })
    expect(sendRes.status(), `chat send failed: ${await sendRes.text()}`).toBe(201)

    // Some MC installs require an explicit dispatch kick; tolerate 404
    await request
      .post('/api/chat/dispatch', {
        headers: API_KEY_HEADER,
        data: { agent: mainAgentName, conversation_id: conversationId, message: prompt },
      })
      .catch(() => {})

    // Poll comms endpoint until agent replies in this conversation
    const reply = await pollUntil(async () => {
      const res = await request.get(
        `/api/agents/comms?agent=${encodeURIComponent(mainAgentName!)}&since=${since}&limit=50`,
        { headers: API_KEY_HEADER }
      )
      if (!res.ok()) return null
      const body = await res.json()
      const msgs: Array<{ from: string; content: string; conversation_id?: string }> =
        body.messages ?? []
      return (
        msgs.find(
          m =>
            m.conversation_id === conversationId &&
            m.from?.toLowerCase().includes(mainAgentName!.toLowerCase()) &&
            (m.content?.trim().length ?? 0) > 0
        ) ?? null
      )
    }, AGENT_RESPONSE_MS)

    expect(reply, `Agent did not reply within ${AGENT_RESPONSE_MS / 1000}s`).not.toBeNull()
    expect(reply!.content).not.toBe(PLACEHOLDER)
    expect(reply!.content.trim().length).toBeGreaterThan(0)

    // Reload /chat — page must still render after agent activity
    await page.reload()
    await expect(page.locator('main').first()).toBeVisible({ timeout: 8_000 })
  })

  // ── 3. /agents — spawn sub-agent, verify registration in browser ──────────

  test('MC /agents page: spawned sub-agent registers in agent list', async ({ page, request }) => {
    test.setTimeout(AGENT_RESPONSE_MS + 15_000)

    if (!gatewayAvailable) test.skip(true, 'No online gateway')

    // Snapshot agent count before spawn
    const beforeRes = await request.get('/api/agents', { headers: API_KEY_HEADER })
    const beforeBody = await beforeRes.json()
    const countBefore: number = (beforeBody.agents ?? []).length

    // Open MC /agents in browser
    await loginAndNavigate(page, '/agents')
    await expect(page).toHaveURL(/\/agents/, { timeout: 10_000 })
    await expect(page.locator('main').first()).toBeVisible({ timeout: 8_000 })

    // Spawn via API
    const spawnRes = await request.post('/api/spawn', {
      headers: API_KEY_HEADER,
      data: {
        task: 'Reply with one word: ready',
        label: `e2e-browser-subagent-${Date.now()}`,
        timeoutSeconds: 60,
      },
    })
    expect([200, 202]).toContain(spawnRes.status())

    // Poll until agent list grows
    const found = await pollUntil(async () => {
      const res = await request.get('/api/agents', { headers: API_KEY_HEADER })
      if (!res.ok()) return null
      const body = await res.json()
      const current: Array<{ name: string }> = body.agents ?? []
      return current.length > countBefore ? current : null
    }, AGENT_RESPONSE_MS)

    expect(
      found,
      `Sub-agent did not register within ${AGENT_RESPONSE_MS / 1000}s`
    ).not.toBeNull()

    // Reload /agents — page must still render after spawn
    await page.reload()
    await expect(page.locator('main').first()).toBeVisible({ timeout: 8_000 })
  })

  // ── 4. /activity — task completes with real resolution, feed shows success ──

  test('MC /activity page: task reaches completed status and feed shows no failed resolution', async ({
    page,
    request,
  }) => {
    test.setTimeout(AGENT_RESPONSE_MS + 25_000)

    if (!gatewayAvailable) test.skip(true, 'No online gateway')
    if (!mainAgentName) test.skip(true, 'No main agent found')

    const since = Math.floor(Date.now() / 1000) - 5

    const { id: taskId } = await createTestTask(request, {
      title: `e2e-browser-activity-${Date.now()}`,
      description: 'Reply with one word: pong',
      assigned_to: mainAgentName,
      status: 'assigned',
      priority: 'high',
    })

    try {
      // Open MC /activity in browser while task runs
      await loginAndNavigate(page, '/activity')
      await expect(page).toHaveURL(/\/activity/, { timeout: 10_000 })
      await expect(page.locator('main').first()).toBeVisible({ timeout: 8_000 })

      // Poll API until task reaches a completed (not failed) status
      const completedTask = await pollUntil(async () => {
        const res = await request.get(`/api/tasks/${taskId}`, { headers: API_KEY_HEADER })
        if (!res.ok()) return null
        const body = await res.json()
        const task = body.task ?? body
        return ['completed', 'done', 'review'].includes(task.status) ? task : null
      }, AGENT_RESPONSE_MS)

      expect(
        completedTask,
        `Task #${taskId} did not reach completed status within ${AGENT_RESPONSE_MS / 1000}s`
      ).not.toBeNull()

      const resolution: string = completedTask!.resolution ?? ''
      expect(
        resolution,
        'Task resolution is the placeholder — agent.wait timeout fix not active'
      ).not.toBe(PLACEHOLDER)
      expect(resolution.trim().length, 'Task resolution is empty').toBeGreaterThan(0)

      // Verify the activity feed recorded this task's events
      const activitiesRes = await request.get(
        `/api/activities?since=${since}&limit=200`,
        { headers: API_KEY_HEADER }
      )
      expect(activitiesRes.status()).toBe(200)
      const activitiesBody = await activitiesRes.json()
      const activities: Array<{
        type: string
        entity_id?: number
        description?: string
        metadata?: string
      }> = activitiesBody.activities ?? []

      const taskActivities = activities.filter(
        a =>
          (a.type?.includes('task') || a.description?.toLowerCase().includes('task')) &&
          (a.entity_id === taskId || a.description?.includes(String(taskId)))
      )
      expect(
        taskActivities.length,
        `No task activity rows found for task #${taskId}`
      ).toBeGreaterThan(0)

      // None of the activity rows for this task should mention placeholder resolution
      for (const act of taskActivities) {
        const meta = act.metadata ?? ''
        expect(
          meta,
          `Activity row for task #${taskId} contains placeholder resolution text`
        ).not.toContain(PLACEHOLDER)
      }

      // Reload /activity — page must still render cleanly
      await page.reload()
      await expect(page.locator('main').first()).toBeVisible({ timeout: 8_000 })
    } finally {
      await deleteTestTask(request, taskId).catch(() => {})
    }
  })
})
