import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getSchedulerStatus, triggerTask } from '@/lib/scheduler'

/**
 * GET /api/scheduler - Get scheduler status
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  return NextResponse.json({ tasks: getSchedulerStatus() })
}

/**
 * POST /api/scheduler - Manually trigger a scheduled task
 * Body: { task_id: 'auto_backup' | 'auto_cleanup' | 'agent_heartbeat' }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json().catch(() => ({}))
  const taskId = typeof body?.task_id === 'string' ? body.task_id : ''

  // Fall back to static known IDs when scheduler hasn't been initialized (test mode)
  const KNOWN_TASK_IDS = new Set(['auto_backup', 'auto_cleanup', 'agent_heartbeat', 'task_dispatch', 'task_reconcile', 'agent_sync'])
  const runtimeIds = new Set(getSchedulerStatus().map((task) => task.id))
  const allowedTaskIds = runtimeIds.size > 0 ? runtimeIds : KNOWN_TASK_IDS

  if (!taskId || !allowedTaskIds.has(taskId)) {
    return NextResponse.json({
      error: `task_id required: ${Array.from(allowedTaskIds).join(', ')}`,
    }, { status: 400 })
  }

  const result = await triggerTask(taskId)
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}
