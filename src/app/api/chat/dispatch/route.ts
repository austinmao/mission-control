import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { callOpenClawGateway } from '@/lib/openclaw-gateway'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { config } from '@/lib/config'
import { getAllGatewaySessions } from '@/lib/sessions'
import { readSessionJsonl, parseJsonlTranscript } from '@/lib/transcript-parser'

function extractReplyText(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return null
  for (const key of ['text', 'message', 'response', 'output', 'result']) {
    if (typeof payload[key] === 'string' && payload[key].trim()) return payload[key].trim()
  }
  if (Array.isArray(payload.output)) {
    const parts: string[] = []
    for (const item of payload.output) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.text === 'string' && item.text.trim()) parts.push(item.text.trim())
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (!block || typeof block !== 'object') continue
          const t = String(block.type || '')
          if (['text', 'output_text', 'input_text'].includes(t) && typeof block.text === 'string' && block.text.trim()) {
            parts.push(block.text.trim())
          }
        }
      }
    }
    if (parts.length > 0) return parts.join('\n').slice(0, 8000)
  }
  return null
}

function recoverChatReplyFromTranscript(openclawAgentId: string, sentMessage: string): string | null {
  if (!config.openclawStateDir) return null
  const agentId = openclawAgentId.toLowerCase().replace(/\s+/g, '-')
  const sessions = getAllGatewaySessions(24 * 60 * 60 * 1000, true)
    .filter((s) => s.agent?.toLowerCase().replace(/\s+/g, '-') === agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)

  const needle = sentMessage.trim().toLowerCase().slice(0, 60)
  for (const session of sessions) {
    if (!session.agent || !session.sessionId) continue
    const raw = readSessionJsonl(config.openclawStateDir, session.agent, session.sessionId)
    if (!raw) continue
    const messages = parseJsonlTranscript(raw, 500)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== 'user') continue
      const userText = msg.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { type: 'text'; text: string }).text)
        .join(' ')
        .toLowerCase()
      if (!userText.includes(needle)) continue
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j]
        if (candidate.role !== 'assistant') continue
        const text = candidate.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { type: 'text'; text: string }).text)
          .join('\n')
          .trim()
        if (text) return text.slice(0, 10_000)
      }
    }
  }
  return null
}

/**
 * POST /api/chat/dispatch - Dispatch a message to an agent via the gateway and wait for a reply.
 * Body: { agent: string, conversation_id?: string, message: string }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const body = await request.json().catch(() => ({}))

    const agentName = typeof body.agent === 'string' ? body.agent.trim() : ''
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : ''
    const messageContent = typeof body.message === 'string' ? body.message.trim() : ''

    if (!agentName || !messageContent) {
      return NextResponse.json({ error: 'agent and message are required' }, { status: 400 })
    }

    const agentRow = db
      .prepare('SELECT * FROM agents WHERE lower(name) = lower(?) AND workspace_id = ?')
      .get(agentName, workspaceId) as any

    if (!agentRow) {
      return NextResponse.json({ error: `Agent not found: ${agentName}` }, { status: 404 })
    }

    let agentConfig: Record<string, any> = {}
    try { agentConfig = JSON.parse(agentRow.config || '{}') } catch { /* noop */ }
    const openclawAgentId: string = agentConfig.openclawId || agentName.toLowerCase().replace(/\s+/g, '-')

    const acceptPayload = await callOpenClawGateway<any>(
      'agent',
      {
        agentId: openclawAgentId,
        message: messageContent,
        deliver: true,
        idempotencyKey: `chat-dispatch-${conversationId}-${Date.now()}`,
      },
      15_000,
    )

    const runId = typeof acceptPayload?.runId === 'string' ? acceptPayload.runId.trim() : null
    if (!runId) {
      logger.warn({ agentName, openclawAgentId, acceptPayload }, 'chat dispatch: no runId returned from gateway')
      return NextResponse.json({ ok: false, reason: 'no_run_id' }, { status: 202 })
    }

    let waitPayload: any = null
    try {
      waitPayload = await callOpenClawGateway<any>(
        'agent.wait',
        { runId, timeoutMs: 90_000 },
        95_000,
      )
    } catch (err) {
      logger.warn({ err, runId }, 'chat dispatch: agent.wait failed or timed out')
      return NextResponse.json({ ok: false, reason: 'wait_timeout', runId }, { status: 202 })
    }

    const replyText = extractReplyText(waitPayload) ?? recoverChatReplyFromTranscript(openclawAgentId, messageContent)
    const content = replyText ?? 'Deferred agent run completed without textual output.'
    const effectiveConversationId = conversationId || `agent_dispatch_${Date.now()}`

    const insertResult = db.prepare(`
      INSERT INTO messages (conversation_id, from_agent, to_agent, content, message_type, metadata, workspace_id)
      VALUES (?, ?, ?, ?, 'text', ?, ?)
    `).run(
      effectiveConversationId,
      agentName,
      auth.user.display_name || auth.user.username || 'system',
      content,
      JSON.stringify({ runId, source: 'chat_dispatch', status: 'completed' }),
      workspaceId,
    )

    const replyRow = db.prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?')
      .get(insertResult.lastInsertRowid, workspaceId) as any

    eventBus.broadcast('chat.message', replyRow)

    logger.info({ agentName, runId, conversationId: effectiveConversationId }, 'chat dispatch: reply stored')
    return NextResponse.json({ ok: true, runId, message: replyRow }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/chat/dispatch error')
    return NextResponse.json({ error: 'Dispatch failed' }, { status: 500 })
  }
}
