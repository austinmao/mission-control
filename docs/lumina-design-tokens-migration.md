# Migrating MC Fork to @lumina/design-tokens (D-T2)

Source: D-T2 (design-review JSONL) — "MC fork imports @lumina/design-tokens, removes own token CSS".

**Status:** scaffold + checklist landed. Full migration of all token-usage sites = follow-on work.

---

## Goal

Replace MC fork's own design tokens with `@lumina/design-tokens` (extracted from open-design v0.7.0). Single source of truth for MC fork + OD fork.

**Scope per design-review D3:** TOKEN-ONLY reskin. Do NOT change layout, IA, panel composition, navigation, or interaction patterns. Only swap visual primitives (colors, typography, spacing, radii, shadows, motion).

## Package linkage

`@lumina/design-tokens` lives in `openclaw/packages/lumina-design-tokens/` (after PR #344 merges to main).

### Option A: pnpm workspace
Requires repo restructure (single workspace spanning both repos).

### Option B: file: protocol (recommended for Phase 1)

`mission-control/package.json`:
```json
{
  "dependencies": {
    "@lumina/design-tokens": "file:../openclaw/packages/lumina-design-tokens"
  }
}
```

Trade-off: requires both repos in same parent dir; CI must clone both.

### Option C: npm pack + private registry
Most robust for prod CI/CD. Recommend for V1 demo.

**Recommendation:** Option B for Phase 1, migrate to C before V1 demo.

## Example import

```ts
// mission-control/src/styles/lumina-tokens-import.example.ts
import { tokens } from '@lumina/design-tokens';

const accentColor = tokens.colors.accent;
const headingFont = tokens.typography.heading.family;
const spaceLg = tokens.spacing.lg;

// As CSS string for runtime injection
import tokensCss from '@lumina/design-tokens/css';

// In Tailwind config
import { tokens } from '@lumina/design-tokens';
export default {
  theme: {
    extend: {
      colors: tokens.colors,
      fontFamily: { sans: [tokens.typography.body.family] },
      spacing: tokens.spacing,
      borderRadius: tokens.radii,
      boxShadow: tokens.shadows,
    },
  },
};
```

## Migration checklist

Run from `mission-control/`:
```bash
rg -l "var\(--" src/ | sort -u > /tmp/mc-token-sites.txt
rg -l "color:|background:|font-family:" src/styles/ | sort -u >> /tmp/mc-token-sites.txt
sort -u /tmp/mc-token-sites.txt | wc -l
```

Per file:
- [ ] Identify CSS variable (e.g., `var(--color-primary)`)
- [ ] Find corresponding token in `@lumina/design-tokens/src/tokens.ts`
- [ ] Import `@lumina/design-tokens/css` once at app entry
- [ ] If variable names differ between MC and OD, add per-token aliases in `src/styles/lumina-aliases.css`
- [ ] Visual smoke test

Suggested sweep order (high-traffic first):
1. `src/components/layout/*` — chrome
2. `src/components/buttons/*` — primitives
3. `src/components/cost-panel/*` — Phase 6 audit surface
4. `src/components/agents/*` — dashboard
5. `src/components/tasks/*` — task list
6. `src/components/memory/*` — memory view
7. `src/app/globals.css` + `src/styles/*.css`
8. `tailwind.config.ts`

## Validation

After each swap:
```bash
pnpm typecheck
pnpm test
pnpm test:e2e
```

Visual A/B per D-T4 (deferred until first MC deploy):
```bash
node scripts/visual-snapshot.ts --panels overview,agents,tasks,memory,cost --out tmp/before
# swap tokens
node scripts/visual-snapshot.ts --panels overview,agents,tasks,memory,cost --out tmp/after
node scripts/visual-diff.ts tmp/before tmp/after
```

D-T4 reference: `docs/artifacts/mc-token-reskin-visual-diff.md` (openclaw repo) — authored after first MC deploy succeeds.

## Rollback

If migration breaks prod:
1. Revert package.json to pre-Phase-2a commit
2. Delete `src/styles/lumina-aliases.css`
3. `pnpm install` falls back to bundled CSS
4. Deploy previous image SHA per `docs/runbooks/mc-rollback-rehearsal.md`

## Token coverage (D-T1 extracted 57 vars)

Covered by `@lumina/design-tokens`:
- colors (palette, surface, text, accent)
- typography (families, sizes, weights, line-heights)
- spacing (4-32 scale)
- radii (none/sm/md/lg/full)
- shadows (sm/md/lg)
- motion (durations + easings)
- layout (max-widths + breakpoints)

NOT covered (MC fork keeps in `src/styles/mc-only-tokens.css`):
- Z-index scale (MC stacking context)
- Component-specific tokens
- Dark-mode pairings (if MC has them and OD doesn't)

## Exit criteria for D-T2 full migration

- [ ] `@lumina/design-tokens` linked (Option B minimum)
- [ ] At least one example component imports + uses tokens
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test:e2e` passes
- [ ] 5-panel visual A/B (D-T4) shows no unintended regressions
- [ ] CHANGELOG.md updated
- [ ] UPSTREAM.md "Divergence inventory" row updated for tokens + tailwind

Phase 2a COMPLETE when all checked.
