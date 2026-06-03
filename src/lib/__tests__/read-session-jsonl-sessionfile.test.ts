import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSessionJsonl, parseJsonlTranscript } from '../transcript-parser'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

function msg(role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } })
}

function setup(): { stateDir: string; sessionsDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), 'mc-sessionfile-'))
  tempDirs.push(stateDir)
  const sessionsDir = join(stateDir, 'agents', 'main', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  return { stateDir, sessionsDir }
}

describe('readSessionJsonl sessionFile rollover handling', () => {
  // The bug: after rollover/compaction OpenClaw reassigns sessionId but keeps the original
  // transcript filename, exposing the real path via the session store's `sessionFile`.
  test('reads the transcript by sessionFile basename when sessionId != filename', () => {
    const { stateDir, sessionsDir } = setup()
    // Real transcript lives under the ORIGINAL filename.
    writeFileSync(
      join(sessionsDir, 'e8e57985-real.jsonl'),
      [msg('user', 'QA probe'), msg('assistant', 'OK')].join('\n'),
    )

    // sessionId is the NEW post-rollover id (no such file exists); sessionFile is the
    // gateway's ABSOLUTE path (different mount root) to the real transcript.
    const raw = readSessionJsonl(
      stateDir,
      'main',
      '53679a1d-new-rollover-id',
      '/home/node/.openclaw/agents/main/sessions/e8e57985-real.jsonl',
    )
    expect(raw).not.toBeNull()
    const messages = parseJsonlTranscript(raw as string, 100)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.parts[0]).toMatchObject({ type: 'text', text: 'OK' })
  })

  test('returns null (does not crash) when sessionId has no file and no sessionFile given', () => {
    const { stateDir } = setup()
    expect(readSessionJsonl(stateDir, 'main', 'missing-id')).toBeNull()
  })

  test('falls back to sessionId when sessionFile is empty', () => {
    const { stateDir, sessionsDir } = setup()
    writeFileSync(join(sessionsDir, 'plain-id.jsonl'), [msg('user', 'hi'), msg('assistant', 'yo')].join('\n'))
    const raw = readSessionJsonl(stateDir, 'main', 'plain-id', '')
    expect(raw).not.toBeNull()
    expect(parseJsonlTranscript(raw as string, 100).find((m) => m.role === 'assistant')?.parts[0])
      .toMatchObject({ type: 'text', text: 'yo' })
  })

  test('merges rotated .bak files resolved via sessionFile basename', () => {
    const { stateDir, sessionsDir } = setup()
    // Older turn rotated into a .bak; live file holds the newest turn. Both keyed by the
    // ORIGINAL filename, which sessionFile points at.
    writeFileSync(join(sessionsDir, 'orig.jsonl.bak-1-1000'), [msg('user', 'first'), msg('assistant', 'reply-A')].join('\n'))
    writeFileSync(join(sessionsDir, 'orig.jsonl'), [msg('user', 'second'), msg('assistant', 'reply-B')].join('\n'))
    const raw = readSessionJsonl(stateDir, 'main', 'rolled-id', '/abs/orig.jsonl')
    const messages = parseJsonlTranscript(raw as string, 100)
    const assistants = messages.filter((m) => m.role === 'assistant').map((m) => (m.parts[0] as { text: string }).text)
    expect(assistants).toEqual(['reply-A', 'reply-B'])
  })
})
