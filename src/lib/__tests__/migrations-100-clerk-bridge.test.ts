/**
 * Lane T1 — unit coverage for migration `100_clerk_bridge`
 * (src/lib/migrations.ts:1433-1462).
 *
 * Covers:
 *   - Fresh DB: ALTER adds `users.clerk_user_id` + `tenants.clerk_org_id`
 *     (TEXT, DEFAULT NULL).
 *   - Idempotent re-run: running migration twice does NOT throw.
 *   - NULL clerk_user_id allowed.
 *   - Partial UNIQUE index `idx_users_clerk_user_id` enforces uniqueness
 *     only for NON-NULL values (multiple NULLs are fine).
 *   - Same partial UNIQUE behavior for `tenants.clerk_org_id` via
 *     `idx_tenants_clerk_org_id`.
 *
 * Uses better-sqlite3 in-memory DB. We invoke the full `runMigrations`
 * pipeline (the migrations module does not export the array directly) and
 * assert on the post-state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { runMigrations } from '../migrations'

type Db = InstanceType<typeof Database>

interface PragmaRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

interface IndexRow {
  seq: number
  name: string
  unique: number
  origin: string
  partial: number
}

function tableInfo(db: Db, table: string): PragmaRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as PragmaRow[]
}

function indexList(db: Db, table: string): IndexRow[] {
  return db.prepare(`PRAGMA index_list(${table})`).all() as IndexRow[]
}

function hasColumn(rows: PragmaRow[], name: string): PragmaRow | undefined {
  return rows.find((r) => r.name === name)
}

let db: Db

beforeEach(() => {
  db = new Database(':memory:')
})

afterEach(() => {
  db?.close()
})

describe('migration 100_clerk_bridge — schema additions', () => {
  it('adds users.clerk_user_id as TEXT DEFAULT NULL', () => {
    runMigrations(db)

    const col = hasColumn(tableInfo(db, 'users'), 'clerk_user_id')
    expect(col).toBeDefined()
    expect(col!.type.toUpperCase()).toBe('TEXT')
    // SQLite returns DEFAULT NULL as either null or 'NULL'; both are OK.
    expect([null, 'NULL']).toContain(col!.dflt_value)
    // Column must be nullable (no NOT NULL constraint).
    expect(col!.notnull).toBe(0)
  })

  it('adds tenants.clerk_org_id as TEXT DEFAULT NULL', () => {
    runMigrations(db)

    const col = hasColumn(tableInfo(db, 'tenants'), 'clerk_org_id')
    expect(col).toBeDefined()
    expect(col!.type.toUpperCase()).toBe('TEXT')
    expect([null, 'NULL']).toContain(col!.dflt_value)
    expect(col!.notnull).toBe(0)
  })

  it('creates partial UNIQUE index idx_users_clerk_user_id', () => {
    runMigrations(db)

    const idx = indexList(db, 'users').find((r) => r.name === 'idx_users_clerk_user_id')
    expect(idx).toBeDefined()
    expect(idx!.unique).toBe(1)
    expect(idx!.partial).toBe(1)
  })

  it('creates partial UNIQUE index idx_tenants_clerk_org_id', () => {
    runMigrations(db)

    const idx = indexList(db, 'tenants').find((r) => r.name === 'idx_tenants_clerk_org_id')
    expect(idx).toBeDefined()
    expect(idx!.unique).toBe(1)
    expect(idx!.partial).toBe(1)
  })

  it('records the migration in schema_migrations', () => {
    runMigrations(db)

    const row = db
      .prepare(`SELECT id FROM schema_migrations WHERE id = '100_clerk_bridge'`)
      .get() as { id: string } | undefined
    expect(row).toBeDefined()
    expect(row!.id).toBe('100_clerk_bridge')
  })
})

describe('migration 100_clerk_bridge — idempotency', () => {
  it('running migrations twice does not throw', () => {
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('running migrations twice keeps a single clerk_user_id column', () => {
    runMigrations(db)
    runMigrations(db)
    const matches = tableInfo(db, 'users').filter((c) => c.name === 'clerk_user_id')
    expect(matches.length).toBe(1)
  })

  it('running migrations twice keeps a single clerk_org_id column', () => {
    runMigrations(db)
    runMigrations(db)
    const matches = tableInfo(db, 'tenants').filter((c) => c.name === 'clerk_org_id')
    expect(matches.length).toBe(1)
  })
})

describe('migration 100_clerk_bridge — nullability + partial UNIQUE on users', () => {
  // users schema (migration 005_users):
  //   id, username UNIQUE, display_name, password_hash NOT NULL,
  //   role DEFAULT 'operator', created_at, updated_at, last_login_at
  // Plus migration 100_clerk_bridge adds: clerk_user_id (TEXT, NULL).
  const INSERT_USER = `
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, '', ?)
  `
  const INSERT_USER_WITH_CLERK = `
    INSERT INTO users (username, display_name, password_hash, role, clerk_user_id)
    VALUES (?, ?, '', ?, ?)
  `

  beforeEach(() => {
    runMigrations(db)
  })

  it('inserts a user with NULL clerk_user_id (no UNIQUE conflict)', () => {
    expect(() => {
      db.prepare(INSERT_USER).run('alice', 'Alice', 'viewer')
    }).not.toThrow()
  })

  it('allows TWO users with NULL clerk_user_id (partial index ignores NULLs)', () => {
    db.prepare(INSERT_USER).run('alice', 'Alice', 'viewer')
    expect(() => {
      db.prepare(INSERT_USER).run('bob', 'Bob', 'viewer')
    }).not.toThrow()

    const rows = db.prepare(`SELECT username FROM users WHERE clerk_user_id IS NULL`).all()
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('allows a NON-NULL clerk_user_id alongside NULL ones', () => {
    db.prepare(INSERT_USER_WITH_CLERK).run('carol', 'Carol', 'admin', 'user_2abc')

    const row = db
      .prepare(`SELECT clerk_user_id FROM users WHERE username = 'carol'`)
      .get() as { clerk_user_id: string }
    expect(row.clerk_user_id).toBe('user_2abc')
  })

  it('rejects TWO users with the SAME non-null clerk_user_id', () => {
    db.prepare(INSERT_USER_WITH_CLERK).run('carol', 'Carol', 'admin', 'user_2dup')

    expect(() =>
      db.prepare(INSERT_USER_WITH_CLERK).run('dave', 'Dave', 'viewer', 'user_2dup'),
    ).toThrow(/UNIQUE/i)
  })
})

describe('migration 100_clerk_bridge — nullability + partial UNIQUE on tenants', () => {
  // tenants schema (migration 012_super_admin_tenants):
  //   id, slug UNIQUE, display_name NOT NULL, linux_user NOT NULL UNIQUE,
  //   plan_tier DEFAULT 'standard', status DEFAULT 'pending',
  //   openclaw_home NOT NULL, workspace_root NOT NULL,
  //   gateway_port, dashboard_port, config DEFAULT '{}',
  //   created_by DEFAULT 'system', created_at, updated_at
  // Plus migration 100_clerk_bridge adds: clerk_org_id (TEXT, NULL).
  const INSERT_TENANT = `
    INSERT INTO tenants (slug, display_name, linux_user, openclaw_home, workspace_root)
    VALUES (?, ?, ?, ?, ?)
  `
  const INSERT_TENANT_WITH_CLERK = `
    INSERT INTO tenants (slug, display_name, linux_user, openclaw_home, workspace_root, clerk_org_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `

  beforeEach(() => {
    runMigrations(db)
  })

  it('inserts a tenant with NULL clerk_org_id', () => {
    expect(() =>
      db
        .prepare(INSERT_TENANT)
        .run('acme', 'Acme Co', 'acme', '/home/acme', '/srv/acme'),
    ).not.toThrow()
  })

  it('allows TWO tenants with NULL clerk_org_id', () => {
    db.prepare(INSERT_TENANT).run('acme', 'Acme Co', 'acme', '/home/acme', '/srv/acme')
    expect(() =>
      db
        .prepare(INSERT_TENANT)
        .run('umbrella', 'Umbrella Inc', 'umbrella', '/home/umbrella', '/srv/umbrella'),
    ).not.toThrow()
    const rows = db.prepare(`SELECT slug FROM tenants WHERE clerk_org_id IS NULL`).all()
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('allows a NON-NULL clerk_org_id alongside NULL ones', () => {
    db.prepare(INSERT_TENANT_WITH_CLERK).run(
      'mapped',
      'Mapped Tenant',
      'mapped',
      '/home/mapped',
      '/srv/mapped',
      'org_2map',
    )

    const row = db
      .prepare(`SELECT clerk_org_id FROM tenants WHERE slug = 'mapped'`)
      .get() as { clerk_org_id: string }
    expect(row.clerk_org_id).toBe('org_2map')
  })

  it('rejects TWO tenants with the SAME non-null clerk_org_id', () => {
    db.prepare(INSERT_TENANT_WITH_CLERK).run(
      'one',
      'One',
      'one',
      '/home/one',
      '/srv/one',
      'org_2dup',
    )

    expect(() =>
      db
        .prepare(INSERT_TENANT_WITH_CLERK)
        .run('two', 'Two', 'two', '/home/two', '/srv/two', 'org_2dup'),
    ).toThrow(/UNIQUE/i)
  })
})
