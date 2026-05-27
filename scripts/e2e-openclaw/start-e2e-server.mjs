#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'

// Mirrors src/lib/password.ts — must stay in sync with SALT_LENGTH, KEY_LENGTH, SCRYPT_COST
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 32, { N: 65536, maxmem: 128 * 65536 * 8 * 2 }).toString('hex')
  return `${salt}:${hash}`
}

async function findAvailablePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to resolve dynamic port')))
        return
      }
      const { port } = address
      server.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}

const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))
const mode = modeArg ? modeArg.split('=')[1] : 'local'
if (mode !== 'local' && mode !== 'gateway' && mode !== 'real-gateway') {
  process.stderr.write(`Invalid mode: ${mode}\n`)
  process.exit(1)
}

const repoRoot = process.cwd()
const fixtureSource = path.join(repoRoot, 'tests', 'fixtures', 'openclaw')
const runtimeRoot = path.join(repoRoot, '.tmp', 'e2e-openclaw', mode)
const dataDir = path.join(runtimeRoot, 'data')
const openCodeDir = path.join(runtimeRoot, '.local', 'share', 'opencode')
const openCodeDbPath = path.join(openCodeDir, 'opencode-e2e.db')
const mockBinDir = path.join(repoRoot, 'scripts', 'e2e-openclaw', 'bin')
const skillsRoot = path.join(runtimeRoot, 'skills')

function findStandaloneServer(root) {
  const direct = path.join(root, '.next', 'standalone', 'server.js')
  if (fs.existsSync(direct)) return direct

  const standaloneRoot = path.join(root, '.next', 'standalone')
  if (!fs.existsSync(standaloneRoot)) return null

  const stack = [standaloneRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && entry.name === 'server.js') {
        return full
      }
    }
  }

  return null
}

function runBlocking(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: baseEnv,
      stdio: 'inherit',
      ...options,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve(undefined)
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`))
    })
  })
}

fs.rmSync(runtimeRoot, { recursive: true, force: true })
fs.mkdirSync(runtimeRoot, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(openCodeDir, { recursive: true })
fs.cpSync(fixtureSource, runtimeRoot, { recursive: true })

const openCodeDb = new Database(openCodeDbPath)
const now = Date.now()
openCodeDb.exec(`
  CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY,
    worktree TEXT,
    vcs TEXT,
    name TEXT,
    icon_url TEXT,
    icon_color TEXT,
    time_created INTEGER,
    time_updated INTEGER,
    time_initialized INTEGER,
    sandboxes TEXT,
    commands TEXT
  );
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    parent_id TEXT,
    slug TEXT,
    title TEXT,
    directory TEXT,
    time_created INTEGER,
    time_updated INTEGER,
    version TEXT,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_compacting INTEGER,
    time_archived INTEGER,
    workspace_id TEXT
  );
  CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    data TEXT,
    time_created INTEGER,
    time_updated INTEGER
  );
`)
openCodeDb.prepare(`INSERT OR REPLACE INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'proj_e2e',
  '/tmp/opencode-e2e-project',
  'git',
  null,
  null,
  null,
  now - 10000,
  now,
  null,
  '[]',
  null,
)
openCodeDb.prepare(`INSERT OR REPLACE INTO session (id, project_id, parent_id, slug, title, directory, time_created, time_updated, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_compacting, time_archived, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'ses_e2e_1',
  'proj_e2e',
  null,
  'hidden-wolf',
  'OpenCode E2E Session',
  '/tmp/opencode-e2e-project',
  now - 10000,
  now - 1000,
  '1.0.0',
  null,
  0,
  0,
  0,
  null,
  null,
  null,
  null,
  null,
  null,
)
openCodeDb.prepare(`INSERT OR REPLACE INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`).run(
  'msg_e2e_1',
  'ses_e2e_1',
  JSON.stringify({ role: 'user', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }, tokens: { input: 12, output: 0 } }),
  now - 10000,
  now - 10000,
)
openCodeDb.prepare(`INSERT OR REPLACE INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`).run(
  'msg_e2e_2',
  'ses_e2e_1',
  JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', content: 'CONTINUE_OK', tokens: { input: 0, output: 6 } }),
  now - 5000,
  now - 1000,
)
openCodeDb.close()

// Seed MC DB admin user so the browser login works on a fresh e2e DB
const mcDbPath = path.join(dataDir, 'mission-control.db')
const mcDb = new Database(mcDbPath)
const e2eUsername = process.env.AUTH_USER || 'testadmin'
const e2ePassword = process.env.AUTH_PASS || 'testpass1234!'
mcDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'operator',
    provider TEXT NOT NULL DEFAULT 'local',
    provider_user_id TEXT,
    email TEXT,
    avatar_url TEXT,
    is_approved INTEGER NOT NULL DEFAULT 1,
    approved_by TEXT,
    approved_at INTEGER,
    workspace_id INTEGER NOT NULL DEFAULT 1,
    clerk_user_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_login_at INTEGER
  )
`)
mcDb.prepare(`
  INSERT OR IGNORE INTO users (username, display_name, password_hash, role, provider, is_approved, workspace_id)
  VALUES (?, ?, ?, 'admin', 'local', 1, 1)
`).run(e2eUsername, e2eUsername.charAt(0).toUpperCase() + e2eUsername.slice(1), hashPassword(e2ePassword))

// Seed agents from fixture openclaw.json so GET /api/agents returns them immediately.
// The scheduler is disabled in MISSION_CONTROL_TEST_MODE, so sync never runs —
// we seed directly here instead.
mcDb.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    session_key TEXT UNIQUE,
    soul_content TEXT,
    status TEXT NOT NULL DEFAULT 'offline',
    last_seen INTEGER,
    last_activity TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    config TEXT,
    workspace_id INTEGER NOT NULL DEFAULT 1
  )
`)
const e2eAgentConfig = JSON.stringify({
  openclawId: 'main',
  model: { primary: 'anthropic/claude-sonnet-4-5' },
  identity: { name: 'Main Agent', theme: 'orchestrator', emoji: ':robot:' },
  isDefault: true,
})
mcDb.prepare(`
  INSERT OR IGNORE INTO agents (name, role, status, config, workspace_id)
  VALUES ('Main Agent', 'orchestrator', 'offline', ?, 1)
`).run(e2eAgentConfig)
mcDb.close()

// For real-gateway mode, use the real gateway coords from env; for mock/local use loopback.
const gatewayHost = mode === 'real-gateway'
  ? (process.env.OPENCLAW_GATEWAY_HOST || 'https://gateway.holalumina.com')
  : '127.0.0.1'
const gatewayPort = mode === 'real-gateway'
  ? (process.env.OPENCLAW_GATEWAY_PORT || '443')
  : String(await findAvailablePort('127.0.0.1'))

const baseEnv = {
  ...process.env,
  // Disable Clerk so API-key auth works in e2e; do not inherit live Clerk keys
  CLERK_SECRET_KEY: '',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
  // Force non-Secure cookies so the browser sends them over HTTP (127.0.0.1:3005)
  MC_COOKIE_SECURE: '0',
  CLERK_JWT_KEY: '',
  API_KEY: process.env.API_KEY || 'test-api-key-e2e-12345',
  AUTH_USER: process.env.AUTH_USER || 'admin',
  AUTH_PASS: process.env.AUTH_PASS || 'admin',
  HOSTNAME: '127.0.0.1',
  PORT: '3005',
  MISSION_CONTROL_TEST_MODE: process.env.MISSION_CONTROL_TEST_MODE || '1',
  MC_DISABLE_RATE_LIMIT: '1',
  MISSION_CONTROL_DATA_DIR: dataDir,
  MISSION_CONTROL_DB_PATH: path.join(dataDir, 'mission-control.db'),
  HOME: runtimeRoot,
  OPENCODE_DB_PATH: openCodeDbPath,
  OPENCLAW_STATE_DIR: mode === 'real-gateway' ? path.join(os.homedir(), '.openclaw') : runtimeRoot,
  OPENCLAW_CONFIG_PATH: path.join(runtimeRoot, 'openclaw.json'),
  OPENCLAW_GATEWAY_HOST: gatewayHost,
  OPENCLAW_GATEWAY_PORT: gatewayPort,
  OPENCLAW_BIN: path.join(mockBinDir, 'openclaw'),
  OPENCODE_BIN: path.join(mockBinDir, 'opencode'),
  CLAWDBOT_BIN: path.join(mockBinDir, 'clawdbot'),
  MC_SKILLS_USER_AGENTS_DIR: path.join(skillsRoot, 'user-agents'),
  MC_SKILLS_USER_CODEX_DIR: path.join(skillsRoot, 'user-codex'),
  MC_SKILLS_PROJECT_AGENTS_DIR: path.join(skillsRoot, 'project-agents'),
  MC_SKILLS_PROJECT_CODEX_DIR: path.join(skillsRoot, 'project-codex'),
  MC_SKILLS_OPENCLAW_DIR: path.join(skillsRoot, 'openclaw'),
  PATH: `${mockBinDir}:${process.env.PATH || ''}`,
  E2E_GATEWAY_EXPECTED: (mode === 'gateway' || mode === 'real-gateway') ? '1' : '0',
}

const children = []
let app = null

if (mode === 'gateway') {
  const gw = spawn('node', ['scripts/e2e-openclaw/mock-gateway.mjs'], {
    cwd: repoRoot,
    env: baseEnv,
    stdio: 'inherit',
  })
  gw.on('error', (err) => {
    process.stderr.write(`[openclaw-e2e] mock gateway failed to start: ${String(err)}\n`)
    shutdown('SIGTERM')
    process.exit(1)
  })
  gw.on('exit', (code, signal) => {
    const exitCode = code ?? (signal ? 1 : 0)
    if (exitCode !== 0) {
      process.stderr.write(`[openclaw-e2e] mock gateway exited unexpectedly (code=${exitCode}, signal=${signal ?? 'none'})\n`)
      shutdown('SIGTERM')
      process.exit(exitCode)
    }
  })
  children.push(gw)
}

const buildIdPath = path.join(repoRoot, '.next', 'BUILD_ID')

if (!fs.existsSync(buildIdPath)) {
  await runBlocking('pnpm', ['build'])
}

const standaloneServerPath = findStandaloneServer(repoRoot)

// Standalone builds omit .next/static and public — copy them in so the
// server can serve JS/CSS chunks. Without this every chunk returns text/html
// and React never hydrates, causing form submits to fire as native GET.
if (standaloneServerPath) {
  const standaloneDir = path.dirname(standaloneServerPath)
  const staticSrc = path.join(repoRoot, '.next', 'static')
  const staticDst = path.join(standaloneDir, '.next', 'static')
  if (fs.existsSync(staticSrc) && !fs.existsSync(staticDst)) {
    fs.cpSync(staticSrc, staticDst, { recursive: true })
  }
  const publicSrc = path.join(repoRoot, 'public')
  const publicDst = path.join(standaloneDir, 'public')
  if (fs.existsSync(publicSrc) && !fs.existsSync(publicDst)) {
    fs.cpSync(publicSrc, publicDst, { recursive: true })
  }
}

app = standaloneServerPath && fs.existsSync(standaloneServerPath)
  ? spawn('node', [standaloneServerPath], {
      cwd: repoRoot,
      env: baseEnv,
      stdio: 'inherit',
    })
  : spawn('pnpm', ['start'], {
      cwd: repoRoot,
      env: baseEnv,
      stdio: 'inherit',
    })
children.push(app)

function shutdown(signal = 'SIGTERM') {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill(signal)
      } catch {
        // noop
      }
    }
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT')
  process.exit(130)
})
process.on('SIGTERM', () => {
  shutdown('SIGTERM')
  process.exit(143)
})

app.on('exit', (code) => {
  shutdown('SIGTERM')
  process.exit(code ?? 0)
})
