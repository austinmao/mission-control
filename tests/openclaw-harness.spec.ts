import { test, expect } from '@playwright/test'
import { API_KEY_HEADER } from './helpers'

const EXPECT_GATEWAY = process.env.E2E_GATEWAY_EXPECTED === '1'

test.describe('OpenClaw Offline Harness', () => {
  test('capabilities expose OpenClaw state dir/config in offline test mode', async ({ request }) => {
    const res = await request.get('/api/status?action=capabilities', {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(body.openclawHome).toBe(true)
    expect(Boolean(body.claudeHome)).toBeTruthy()
    expect(Boolean(body.gateway)).toBe(EXPECT_GATEWAY)
  })

  test('sessions API reads fixture sessions without OpenClaw install', async ({ request }) => {
    const res = await request.get('/api/sessions', {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(Array.isArray(body.sessions)).toBe(true)
    expect(body.sessions.length).toBeGreaterThan(0)
    expect(body.sessions[0]).toHaveProperty('agent')
    expect(body.sessions[0]).toHaveProperty('tokens')
  })

  test('cron API reads fixture jobs', async ({ request }) => {
    const res = await request.get('/api/cron?action=list', {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(Array.isArray(body.jobs)).toBe(true)
    expect(body.jobs.length).toBeGreaterThan(0)
    expect(body.jobs[0]).toHaveProperty('name')
    expect(body.jobs[0]).toHaveProperty('schedule')
  })

  test('gateway config API reads fixture config', async ({ request }) => {
    const res = await request.get('/api/gateway-config', {
      headers: API_KEY_HEADER,
    })
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(typeof body.path).toBe('string')
    expect(body.path.endsWith('openclaw.json')).toBe(true)
    expect(body.config).toHaveProperty('agents')
  })

  test('coordinator chat ping-pong: POST stores message and produces a coordinator status reply', async ({ request }) => {
    const convId = `coord:e2e-harness-${Date.now()}`

    const postRes = await request.post('/api/chat/messages', {
      headers: API_KEY_HEADER,
      data: {
        to: 'coordinator',
        content: 'ping from e2e harness',
        message_type: 'text',
        conversation_id: convId,
        forward: true,
      },
    })
    expect(postRes.status()).toBe(200)
    const postBody = await postRes.json()
    expect(postBody).toHaveProperty('message')
    expect(postBody.message.conversation_id).toBe(convId)

    // Give the coordinator reply time to write (it fires async after HTTP response)
    await new Promise((r) => setTimeout(r, 500))

    const getRes = await request.get(
      `/api/chat/messages?conversation_id=${encodeURIComponent(convId)}&limit=20`,
      { headers: API_KEY_HEADER }
    )
    expect(getRes.status()).toBe(200)
    const getBody = await getRes.json()
    const messages: any[] = getBody.messages ?? getBody.parsed ?? []

    // User message must be present
    const userMsg = messages.find((m: any) => m.content === 'ping from e2e harness')
    expect(userMsg).toBeDefined()

    // Coordinator must have replied with a status message (offline, delivery_failed,
    // processing, or accepted — exact status depends on gateway availability)
    const coordinatorReplies = messages.filter(
      (m: any) => m.from_agent === 'coordinator' && m.message_type === 'status'
    )
    expect(coordinatorReplies.length).toBeGreaterThan(0)

    // The reply must never be the old bad "Unable to read completion status" fallback
    for (const reply of coordinatorReplies) {
      expect(reply.content).not.toContain('Unable to read completion status from coordinator runtime.')
    }

    if (EXPECT_GATEWAY) {
      // In gateway mode the coordinator must acknowledge receipt
      const acceptedOrProcessing = coordinatorReplies.some(
        (m: any) =>
          m.content.includes('Received') ||
          m.content.includes('still processing') ||
          m.content.includes('completed')
      )
      expect(acceptedOrProcessing).toBe(true)
    } else {
      // In local mode no real gateway is reachable — coordinator reports offline or delivery failure
      const offlineOrFailed = coordinatorReplies.some(
        (m: any) =>
          m.content.includes('offline') ||
          m.content.includes('delivery_failed') ||
          m.content.includes('could not retrieve') ||
          m.content.includes('still processing')
      )
      expect(offlineOrFailed).toBe(true)
    }
  })
})
