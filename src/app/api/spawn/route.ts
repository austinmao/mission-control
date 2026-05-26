import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { callOpenClawGateway } from '@/lib/openclaw-gateway'
import { config } from '@/lib/config'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { heavyLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { validateBody, spawnAgentSchema } from '@/lib/validation'
import { scanForInjection } from '@/lib/injection-guard'
import { logAuditEvent, getDatabase } from '@/lib/db'

function getPreferredToolsProfile(): string {
  return String(process.env.OPENCLAW_TOOLS_PROFILE || 'coding').trim() || 'coding'
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = heavyLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, spawnAgentSchema)
    if ('error' in result) return result.error
    const { task, model, label, timeoutSeconds } = result.data

    // Scan the task prompt and label for injection before sending to an agent
    const fieldsToScan = [
      { name: 'task', value: task },
      ...(label ? [{ name: 'label', value: label }] : []),
    ]
    for (const field of fieldsToScan) {
      const injectionReport = scanForInjection(field.value, { context: 'prompt' })
      if (!injectionReport.safe) {
        const criticals = injectionReport.matches.filter(m => m.severity === 'critical')
        if (criticals.length > 0) {
          logger.warn({ field: field.name, rules: criticals.map(m => m.rule) }, `Blocked spawn: injection detected in ${field.name}`)
          return NextResponse.json(
            { error: `${field.name} blocked: potentially unsafe content detected`, injection: criticals.map(m => ({ rule: m.rule, description: m.description })) },
            { status: 422 }
          )
        }
      }
    }

    const timeout = timeoutSeconds

    // Generate spawn ID
    const spawnId = `spawn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // Construct the spawn command
    // Using OpenClaw's sessions_spawn function via clawdbot CLI
    const spawnPayload = {
      task,
      label,
      ...(model ? { model } : {}),
      runTimeoutSeconds: timeout,
      tools: {
        profile: getPreferredToolsProfile(),
      },
    }

    try {
      // sessions_spawn is not yet a registered gateway RPC method in OpenClaw.
      // Implement equivalent behaviour using sessions.create + chat.send, then
      // register the spawned session as a new agent in MC's local DB so that
      // /api/agents reflects the new entry immediately.
      const sessionKey = `spawn-${spawnId}`
      let result: any = {}
      let compatibilityFallbackUsed = false

      // 1. Create a new session in the gateway (uses the default agent).
      try {
        const createResult = await callOpenClawGateway<any>('sessions.create', { key: sessionKey }, 10_000)
        result = createResult ?? {}
      } catch (createErr: any) {
        // sessions.create is best-effort — proceed even if it fails; the session
        // key is valid as a logical identifier for the spawned work unit.
        logger.warn({ err: createErr }, 'sessions.create failed during spawn (non-fatal)')
      }

      // 2. Send the task to the new session (fire-and-forget; spawn returns
      //    immediately, the agent works asynchronously).
      callOpenClawGateway<any>(
        'chat.send',
        {
          sessionKey,
          message: task,
          idempotencyKey: `spawn-send-${spawnId}`,
          deliver: true,
        },
        60_000,
      ).catch((sendErr: any) => {
        logger.warn({ err: sendErr }, 'chat.send failed for spawned session (non-fatal)')
      })

      // 3. Register the spawned session as a new agent entry in MC's local DB so
      //    /api/agents count increases and the agent appears in the UI.
      try {
        const db = getDatabase()
        const now = Math.floor(Date.now() / 1000)
        const agentName = label || `spawned-${spawnId.slice(6, 14)}`
        const workspaceId = (auth.user as any).workspace_id ?? 1
        const existing = db
          .prepare('SELECT id FROM agents WHERE name = ? AND workspace_id = ?')
          .get(agentName, workspaceId)
        const finalName = existing ? `${agentName}-${Date.now()}` : agentName
        db.prepare(`
          INSERT INTO agents (name, role, session_key, soul_content, status,
            created_at, updated_at, config, workspace_id, runtime_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          finalName,
          'spawned',
          sessionKey,
          null,
          'busy',
          now, now,
          JSON.stringify({ task, model: model ?? null, spawnId, toolsProfile: getPreferredToolsProfile() }),
          workspaceId,
          null,
        )
        result.agentName = finalName
      } catch (dbErr: any) {
        logger.warn({ err: dbErr }, 'Failed to register spawned agent in DB (non-fatal)')
      }

      const sessionInfo = sessionKey

      const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
      logAuditEvent({
        action: 'agent_spawn',
        actor: auth.user.username,
        actor_id: auth.user.id,
        detail: {
          spawnId,
          model: model ?? null,
          label,
          task_summary: task.length > 120 ? task.slice(0, 120) + '...' : task,
          toolsProfile: getPreferredToolsProfile(),
          compatibilityFallbackUsed,
        },
        ip_address: ipAddress,
      })

      return NextResponse.json({
        success: true,
        spawnId,
        sessionInfo,
        task,
        model: model ?? null,
        label,
        timeoutSeconds: timeout,
        createdAt: Date.now(),
        result,
        compatibility: {
          toolsProfile: getPreferredToolsProfile(),
          fallbackUsed: compatibilityFallbackUsed,
        },
      })

    } catch (execError: any) {
      logger.error({ err: execError }, 'Spawn execution error')

      return NextResponse.json({
        success: false,
        spawnId,
        error: execError.message || 'Failed to spawn agent',
        task,
        model: model ?? null,
        label,
        timeoutSeconds: timeout,
        createdAt: Date.now()
      }, { status: 500 })
    }

  } catch (error) {
    logger.error({ err: error }, 'Spawn API error')
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Get spawn history
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = heavyLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)

    // In a real implementation, you'd store spawn history in a database
    // For now, we'll try to read recent spawn activity from logs
    
    try {
      if (!config.logsDir) {
        return NextResponse.json({ history: [] })
      }

      const files = await readdir(config.logsDir)
      const logFiles = await Promise.all(
        files
          .filter((file) => file.endsWith('.log'))
          .map(async (file) => {
            const fullPath = join(config.logsDir, file)
            const stats = await stat(fullPath)
            return { file, fullPath, mtime: stats.mtime.getTime() }
          })
      )

      const recentLogs = logFiles
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5)

      const lines: string[] = []

      for (const log of recentLogs) {
        const content = await readFile(log.fullPath, 'utf-8')
        const matched = content
          .split('\n')
          .filter((line) => line.includes('sessions_spawn'))
        lines.push(...matched)
      }

      const spawnHistory = lines
        .slice(-limit)
        .map((line, index) => {
          try {
            const timestampMatch = line.match(
              /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/
            )
            const modelMatch = line.match(/model[:\s]+"([^"]+)"/)
            const taskMatch = line.match(/task[:\s]+"([^"]+)"/)

            return {
              id: `history-${Date.now()}-${index}`,
              timestamp: timestampMatch
                ? new Date(timestampMatch[1]).getTime()
                : Date.now(),
              model: modelMatch ? modelMatch[1] : 'unknown',
              task: taskMatch ? taskMatch[1] : 'unknown',
              status: 'completed',
              line: line.trim()
            }
          } catch (parseError) {
            return null
          }
        })
        .filter(Boolean)

      return NextResponse.json({ history: spawnHistory })

    } catch (logError) {
      // If we can't read logs, return empty history
      return NextResponse.json({ history: [] })
    }

  } catch (error) {
    logger.error({ err: error }, 'Spawn history API error')
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
