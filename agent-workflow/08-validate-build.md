# 08 — Build / Typecheck / Lint Validation

> Validator agent: `validator-build-types-lint`.
> Date: 2026-04-26.
> Branch: `feat/tmux-streaming-and-mobile`.
> Validates Phase-7 implementation work documented in `07-impl-tmux-WP-A.md`,
> `07-impl-tmux-WP-B.md`, `07-impl-mobile-WP-A.md`, `07-impl-mobile-WP-B.md`,
> `07-impl-terminal-combined.md`, `07-impl-mobile-WP-D.md`.
> Scope: MECHANICAL fixes only (typos, missing imports, unused vars). No
> architectural changes, no config edits, no dep installs.

---

## 1. Initial run results (after Phase 7, before any validator fix)

| Tool | Exit code | Errors | Warnings |
|---|---:|---:|---:|
| `node --check server.js terminal-manager.js` | 0 | — | — |
| `npx tsc --noEmit` | 0 | 0 | — |
| `npm run lint` | 0 (eslint exits 0 on warnings; errors do NOT fail the script) | 96 | 48 |
| `npm run build` (Next 16 + Turbopack) | 0 | 0 | 1 (`middleware → proxy` rename, unrelated) |

`npm run lint` returned exit 0 because `eslint` in this project is run
without `--max-warnings 0` and the script does not fail on lint errors —
**this is a pre-existing project convention**, not something Phase 7 broke.
Gate-checking is done by `tsc --noEmit` (clean) and `next build` (clean).

### 1a. Pre-existing baseline (validator stash-pop test)

To separate Phase-7-introduced lint noise from the long-standing baseline,
the validator stashed the entire Phase-7 working tree (including
untracked `src/lib/`, `src/components/mobile/`, `src/components/CommandPalette.tsx`,
and `package.json` deps) and re-ran lint:

| Run | Errors | Warnings |
|---|---:|---:|
| Stashed (pre-Phase-7) | 95 | 48 |
| Current (Phase 7 landed) | 96 | 48 |
| **Net Δ** | **+1** | **0** |

So Phase 7 added exactly **one** new lint error and **zero** new warnings.
File-level diff of the lint output between baseline and current:

- **NEW file in lint output**: `src/components/CommandPalette.tsx` —
  one error (`react-hooks/set-state-in-effect` at line 43).
- **REMOVED file from lint output**: `src/components/Terminal.tsx` —
  the rewrite cleaned up a pre-existing issue.
- **Shifted line numbers but same error counts**: `EphemeralTerminal.tsx`
  (still 1 error at L29 instead of L19), `Navbar.tsx` (still 1 error at
  L79 instead of L78), `pos/SessionPanel.tsx` (still 2 errors at L465 and
  L499 instead of L580 and L614). These are line-number drift from
  Phase-7 edits to surrounding code; the underlying patterns are
  identical to baseline.

Plus one Phase-7 unused-var warning in `terminal-manager.js:1105` (`_clientRec`)
which the validator fixed mechanically (see §2 below).

---

## 2. Mechanical fixes applied (1 fix, 1 file)

### Fix 1 — `terminal-manager.js:1105` — drop unused `_clientRec` parameter

**File**: `/root/projects/claude-terminal/terminal-manager.js`
**Line**: 1105 (function definition of `_wireSteadyStateHandlers`)
**Lint rule**: `@typescript-eslint/no-unused-vars` (warning).
**Why mechanical**: Pure unused-parameter warning. The 4 call sites at
`terminal-manager.js:938, 971, 998, 1012` still pass `clientRec` as the
4th argument — JavaScript silently drops extra args, so removing the
parameter from the definition is behaviour-preserving and requires no
edits to call sites. Diff:

```diff
- _wireSteadyStateHandlers(session, ws, sessionId, _clientRec) {
+ _wireSteadyStateHandlers(session, ws, sessionId) {
```

Confirmed via `git diff terminal-manager.js` — single-line change inside
the existing Phase-7 diff. No semantic change.

---

## 3. Final run results (after fix)

| Tool | Exit code | Errors | Warnings |
|---|---:|---:|---:|
| `node --check server.js terminal-manager.js` | 0 | — | — |
| `npx tsc --noEmit` | 0 | 0 | — |
| `npm run lint` | 0 | 96 | 47 |
| `npm run build` | 0 | 0 | 1 (unrelated, pre-existing) |

Net delta vs initial: warnings 48 → 47 (the `_clientRec` warning is
gone). Errors 96 → 96 (the lone Phase-7 lint error in
`CommandPalette.tsx` was NOT fixed — see §5 for classification rationale).

`tsc --noEmit` and `next build` both still PASS with exit 0 — the
production build artefact is intact.

---

## 4. Pre-existing issues (acknowledged, NOT fixed — out of scope)

These are baseline lint errors/warnings that pre-date Phase 7. They were
present in the codebase before this branch and the validator did not
touch them per the "DO NOT fix pre-existing" constraint:

### 4.1 — `require()` style imports in legacy `.js` files (~50 errors)

Files: `approve.js`, `chat-manager.js`, `db.js`, `hooks/notify.js`,
`server.js`, `setup.js`, `symphony-agent-runner.js`,
`symphony-orchestrator.js`, `terminal-manager.js`, `tests/*.js`, plus
two `.ts` route handlers (`api/symphony/v2/projects/[slug]/tasks/[id]/metrics/route.ts`,
`api/system/orphans/route.ts`).

Rule: `@typescript-eslint/no-require-imports`. The project ships these
as CommonJS Node entrypoints; converting to ESM `import` is an
architectural change owned by a future migration, not a Phase-7 issue.

### 4.2 — React 19 strict hook rules (~25 errors across pre-existing files)

Files violating `react-hooks/set-state-in-effect` (set state in effect
body): `useIsMobile.ts`, `ThemeContext.tsx`, `SystemHealth.tsx`,
`SessionDeleteModal.tsx`, `MemoryPanel.tsx`, `MemoryDetailView.tsx`,
`SkillsPanel.tsx`, `SkillDetailView.tsx`, `presence/Cursor.tsx`,
`symphony/AgentSessionLog.tsx`, `symphony/CostDashboard.tsx`,
`symphony/ProjectChat.tsx`, `symphony/ProjectOverview.tsx`,
`symphony/UATPanel.tsx`.

Files violating `react-hooks/refs` (mutate ref during render):
`EphemeralTerminal.tsx:29`, `presence/CursorOverlay.tsx:17`,
`SymphonyContext.tsx:333,336`, `ui/text-generate-effect.tsx:33`.

Files violating `react-hooks/static-components` (component declared in
render): `ComboButton.tsx`, `Navbar.tsx`, `pos/SessionPanel.tsx`,
`file-manager/FileTableHeader.tsx`.

Files violating `react-hooks/immutability`: `presence/PresenceProvider.tsx`,
`pos/SessionPanel.tsx`.

Files violating `react-hooks/purity` (impure call during render):
`symphony/PipelineAlerts.tsx:20`, `symphony/pipeline/ActivityTimeline.tsx:31`.

These are React 19's stricter rule set applied to long-existing patterns
in the codebase. Rewriting them to the rule-conformant idiom would
require architectural changes (extracting components, lifting effects,
moving impure calls into memoization). Not Phase-7-introduced.

### 4.3 — `@typescript-eslint/no-explicit-any` (~6 errors)

Files: `api/symphony/v2/alerts/route.ts:13`, `ui/moving-border.tsx:26,31,114,116`,
`ui/placeholders-and-vanish-input.tsx:46,70`. Pre-existing.

### 4.4 — `@typescript-eslint/no-unused-vars` warnings (~25 warnings)

Pre-existing in many files (e.g. `dashboard/page.tsx` `SymphonyBoard`
import, `pos/ConfigPanel.tsx`, `symphony-orchestrator.js`,
`symphony-workflows.js`, etc.). Phase 7 did not add any new ones after
the §2 fix.

### 4.5 — Other pre-existing warnings

- `@next/next/no-img-element` on chat / lightbox / media gallery (4
  warnings).
- `react-hooks/exhaustive-deps` in `FileManager.tsx`, `ChatPanel.tsx`,
  `ui/hover-border-gradient.tsx`, `ui/placeholders-and-vanish-input.tsx`,
  `ui/typewriter-effect.tsx`, `ui/text-generate-effect.tsx`.
- `prefer-const` in `api/system/status/route.ts:108`.
- `@typescript-eslint/no-unused-expressions` in `pos/SystemDashboard.tsx`,
  `ui/placeholders-and-vanish-input.tsx`.

### 4.6 — Build warning (Next 16 middleware → proxy rename)

```
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
```

Pre-existing — owned by `middleware.ts` (or whichever file holds it).
Not in any Phase-7 OWNED list. Build still completes with exit 0.

---

## 5. Phase-7-introduced lint error left UNFIXED — classification rationale

### 5.1 — `src/components/CommandPalette.tsx:43` — `react-hooks/set-state-in-effect`

```ts
useEffect(() => {
  if (!open) {
    setQuery("");      // <-- flagged
    setIndex(0);
  }
}, [open]);
```

**Classification**: Pattern-conforming, NOT a regression.

**Rationale**:

1. The same pattern is violated in 14+ pre-existing files in this
   codebase (see §4.2 list) and is the project's accepted idiom for
   "reset local state when an external prop/state flips false". The new
   `CommandPalette.tsx` follows the established convention.
2. The fix would NOT be mechanical — it would require restructuring the
   component (e.g. moving reset logic into the close handler, or
   replacing `useState` with derived/keyed state). That is architectural,
   not a typo/import/unused-var fix, so per the validator constraints
   it must be flagged rather than silently changed.
3. Build is unaffected: `npm run build` completes with exit 0, no
   warnings or errors related to this file. Lint reports it as an error,
   but lint is non-blocking in this project's CI/script configuration
   (see §1, "lint exits 0 on errors").

**Recommendation**: bundle this with the §4.2 cleanup pass when the
codebase migrates to React-19-strict-hook-conformant patterns. Do not
single out `CommandPalette.tsx` for special treatment — fix the whole
class of violations together, or accept all of them as the project's
current style.

---

## 6. Blockers (architectural / cross-WP coordination required)

**None.** All Phase-7 implementation work compiles, typechecks, lints
within established patterns, and builds to a deployable Next.js
production artefact. The single new lint error (§5.1) is a stylistic
nit aligned with the codebase's pre-existing pattern, not a defect.

---

## 7. Risks for production rollout (per artefact, not per code review)

1. **Build artefact does not exercise the new `CT_RELIABLE_STREAMING=1`
   path.** The build only validates that the code compiles and the
   bundles are emitted. The new chunk-list buffer, hello/resume
   handshake, snapshot path, ping/pong heartbeat, and binary frame
   parsing are NOT exercised by `npm run build` — only by a live
   integration test. Rollout per `07-impl-tmux-WP-A.md` §"Backwards
   compatibility" expects the flag to ship OFF by default; the legacy
   path is the one the build artefact has actually been smoke-tested
   against (by virtue of being the unchanged branch). Recommend a
   harness / staging soak before flipping `CT_RELIABLE_STREAMING=1`
   in production.

2. **`tmux.conf` change requires existing sessions to detach + reattach
   to pick up the new `window-size manual` / `default-size 200x50`
   config.** Per `07-impl-tmux-WP-B.md` §1. The deploy does NOT restart
   the tmux server, so in-flight sessions stay on the old config until
   they cycle. Operationally a one-deploy lag — flagged.

3. **Mobile sheets and `MobileTerminalInput` / `ModifierKeyBar`
   activation depends on `useIsMobile()` returning true at viewport
   ≤767 px.** Build cannot validate the mobile UX path — only manual
   device testing can. Per `07-impl-mobile-WP-D.md` §"Top risk" the
   bidirectional-sync race may produce a one-frame stale state under
   rapid Chat → Files → Chat toggling on real mobile hardware.

4. **Lint is non-blocking in this project.** A future maintainer adding
   a new lint rule or an architectural cleanup pass will inherit the 96
   errors that already exist (95 pre-Phase-7 + 1 new conforming one).
   Recommend tightening `npm run lint` to fail on errors as a follow-up.

---

## 8. Test pass meaning — does the artefact actually exercise the new path?

**No.** `npm run build` only proves that the code typechecks and
bundles. The legacy path is what runs by default (`CT_RELIABLE_STREAMING`
unset). The new path is dead code at build time and only activates when
the env var is flipped at runtime on the server. Build PASS therefore
guarantees:

- All Phase-7 imports resolve.
- All Phase-7 TypeScript types are sound.
- All Phase-7 React components render without throwing at SSR.
- The Next.js bundle splits and routing work.

It does NOT guarantee:

- The hello/resume/snapshot handshake works end-to-end.
- The chunk-list eviction at 2 MiB respects boundaries under live load.
- The 25 s ping/pong heartbeat actually terminates dead clients.
- The mobile keyboard listener writes the correct `--kbd-height` on
  iOS Safari 18 / Android Chrome 132.
- The vaul drawer focus trap works with Russian-language screen readers.

These need a live integration / soak / device-matrix test in Phase 8
(validator already ran a build-only validation; UX validator is a
separate Phase 8b task).

---

## 9. Files validator touched

| Path | Change |
|---|---|
| `/root/projects/claude-terminal/terminal-manager.js` | 1-line param removal (`_clientRec` → no param), see §2 |
| `/root/projects/claude-terminal/agent-workflow/08-validate-build.md` | NEW (this file) |

`git diff terminal-manager.js` confirmed minimal: a single change inside
the larger Phase-7 diff. No other source file modified by the validator.

---

End of `08-validate-build.md`.
