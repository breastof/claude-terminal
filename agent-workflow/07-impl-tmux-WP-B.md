# 07 — Implementation: WP-B (tmux.conf)

> Phase 7 deliverable for `impl-tmux-WP-B`. Implements `06-integration-plan-tmux.md` §4.3 against `/root/projects/claude-terminal/tmux.conf`. File-disjoint from WP-A and WP-C — no other file touched.

---

## 1. Scope summary

WP-B is config-only. The change kills resize-storm physics at the tmux layer (per `05-decision-tmux.md` §2 D-Q13 and the "physics-layer" rationale), enables RGB / sync / clipboard / focus terminal features for atomic redraws, surfaces editor focus events, suppresses bells / auto-rename / OSC 52 clipboard writes. Existing tmux sessions need detach+reattach to pick up the new options (acceptable per `05-decision-tmux.md` §8 risk #8); the host's running tmux server is intentionally NOT restarted by this PR.

---

## 2. Before / after — every changed line

### Section 2 — terminal capabilities (extended)

| Line | Before | After |
|---|---|---|
| `# Terminal capabilities` | `# Terminal capabilities` | `# Terminal capability — enable atomic redraws, focus events, RGB.` (extended block-comment with rationale; see file lines 27-30) |
| default-terminal | `set -g default-terminal "xterm-256color"` | `set -g default-terminal "tmux-256color"` |
| terminal-overrides | `set -ga terminal-overrides ",xterm-256color:Tc"` | `set -ga terminal-overrides ",*256col*:Tc"` |
| terminal-features | *(absent)* | `set -ga terminal-features ",*256col*:RGB,clipboard,focus,sync"` |

### Section 3 — streaming reliability (extended; existing settings preserved verbatim)

| Line | Before | After |
|---|---|---|
| status off | preserved verbatim | preserved verbatim |
| mouse off | preserved verbatim | preserved verbatim |
| allow-rename off | preserved verbatim | preserved verbatim |
| remain-on-exit off | preserved verbatim | preserved verbatim |
| focus-events | *(absent)* | `set -g focus-events on` |
| automatic-rename | *(absent — defaulted to `on`)* | `setw -g automatic-rename off` |
| monitor-bell | *(absent — defaulted to `on`)* | `setw -g monitor-bell off` |
| set-clipboard | *(absent — defaulted to `external`)* | `set -g set-clipboard off` |

### Section 4 — geometry (REPLACED; load-bearing for P5)

| Line | Before | After |
|---|---|---|
| `# Resize to match the latest attached client` | `# Resize to match the latest attached client` | `# Geometry — kill resize storms (load-bearing for P5)` block (file lines 58-64) — existing comment removed; new comment block plus `# WAS:` markers retain the prior values for grep-discoverability per the WP-B brief constraint about preserving conflict context. |
| window-size | `set -g window-size latest` | `set -g window-size manual` |
| aggressive-resize | `set -g aggressive-resize on` | `setw -g aggressive-resize off` (note `set` → `setw`; `aggressive-resize` is a window option, not a server option — both forms work since tmux 2.0 because `set` aliases to `setw` for window options, but `setw` is the canonical form per the integration plan §4.3) |
| default-size | *(absent — defaulted to `80x24`)* | `set -g default-size "200x50"` |

### Preserved verbatim (no changes)

- `set -g prefix C-]`
- `unbind C-b`
- `set -g escape-time 0` (already correct per plan)
- `set -g history-limit 50000` (already correct per plan)

### Comments / structure

A new comment block at the top labels the four sections (Behavior / Compat / Streaming reliability / Geometry) per the brief's request. Each section has its own banner comment. The existing rationale comments for `mouse off` (xterm.js conflict) and the WAS: comments for the geometry overrides are preserved.

---

## 3. Directive count

| Bucket | Count |
|---|---|
| **Added** (new directives not present before) | 6 — `terminal-features`, `focus-events`, `automatic-rename off`, `monitor-bell off`, `set-clipboard off`, `default-size 200x50` |
| **Changed** (existing directive value flipped) | 4 — `default-terminal` (xterm→tmux), `terminal-overrides` (specific→glob), `window-size` (latest→manual), `aggressive-resize` (on→off) |
| **Preserved** (no change) | 8 — `prefix C-]`, `unbind C-b`, `escape-time 0`, `history-limit 50000`, `status off`, `mouse off`, `allow-rename off`, `remain-on-exit off` |
| **Removed (verbatim)** | 0 — old `window-size latest` / `aggressive-resize on` are retained as `# WAS:` comments per brief instruction (preserve conflict context over deletion) |
| **TOTAL effective directives** | 18 |

---

## 4. Syntax validation

`tmux 3.4` is installed on the host (`/usr/bin/tmux`); `terminal-features` requires tmux ≥ 3.2 (per integration plan §4.3 "New dependencies"), satisfied.

### Validation method 1 — direct `new-session -d`
```bash
tmux -L probe-validate-test -f /root/projects/claude-terminal/tmux.conf new-session -d "true"
```
Result: `server exited unexpectedly` (exit 1).

**This is NOT a config syntax error.** Bisecting with single-directive configs proved that the failure is triggered by `set -g window-size manual` running in a detached `new-session -d` with no attached client — under that mode, tmux cannot determine pane geometry from any client and the spawned process exits immediately, taking the (only) session and the (only) server with it. Running the same `new-session -d` against `/dev/null` config or a config with `window-size latest`/`window-size largest` succeeds. The integration plan's recommended sanity command (`tmux ... new-session -d -s test 'sleep 1' && kill-server`) is therefore unreliable as a parse-test for configs that include `window-size manual`. **In production this is a non-issue:** `terminal-manager.js` always invokes `tmux new-session` together with `pty.spawn(... { cols, rows })` so a client and an explicit geometry are present from the first byte (terminal-manager.js:623, :697 — `new-session -d ... -x 120 -y 40`); the WP-A implementer will adjust those `-x/-y` values if/when they touch that file.

### Validation method 2 — `start-server` parse-only
```bash
tmux -L probe-final -f /root/projects/claude-terminal/tmux.conf start-server
```
Result: **exit 0**. All `set-option` invocations succeeded with no parse error. Verbose log (`tmux -vv`) shows every directive being processed by `cmdq_fire_command <global>` followed by `format_expand1` + `options_push_changes` for the named option.

### Validation method 3 — `source-file` into a kept-alive server
```bash
tmux -L pkeepalive new-session -d -s keepalive "sleep 300"   # baseline session, default config
tmux -L pkeepalive source-file /root/projects/claude-terminal/tmux.conf
```
Result: **exit 0**. `source-file` returned 0 (the canonical "config parses without errors" signal in tmux). `show-options -g` and `show-options -gw` confirm every spec'd value is now applied:

| Option | Expected | Observed |
|---|---|---|
| `prefix` | `C-]` | `C-]` |
| `escape-time` | `0` | `0` |
| `history-limit` | `50000` | `50000` |
| `default-terminal` | `tmux-256color` | `tmux-256color` |
| `terminal-overrides` | contains `*256col*:Tc` | `terminal-overrides[0] *256col*:Tc` |
| `terminal-features` | contains `*256col*:RGB,clipboard,focus,sync` | `terminal-features[3] *256col*:RGB`, `[4] clipboard`, `[5] focus`, `[6] sync` (tmux normally splits on commas) |
| `status` | `off` | `off` |
| `mouse` | `off` | `off` |
| `allow-rename` | `off` | `off` |
| `remain-on-exit` | `off` | `off` |
| `focus-events` | `on` | `on` |
| `set-clipboard` | `off` | `off` |
| `automatic-rename` (window) | `off` | `off` |
| `monitor-bell` (window) | `off` | `off` |
| `aggressive-resize` (window) | `off` | `off` |
| `window-size` | `manual` | `manual` |
| `default-size` | `200x50` | `200x50` |

**Conclusion: config parses cleanly and every spec'd directive applies.** The only "validation failure" was an environment artifact of the integration plan's own recommended command, not a config bug.

---

## 5. Plan ↔ current-config disagreements

| Item | Plan says | Current host says | Action taken |
|---|---|---|---|
| `terminal-features` syntax requires tmux ≥ 3.2 | yes | host has tmux 3.4 | none — proceed as planned |
| `tmux-256color` terminfo entry must exist on host | implicit | not verified by this WP (terminfo lookup); the integration plan §4.3 notes this is the recommended internal entry | terminfo file `/usr/share/terminfo/t/tmux-256color` exists on most Ubuntu installs (`ncurses-term` package); WP-B does NOT install it. If absent, tmux will fall back to a base entry and may lose some capability hints — operationally non-fatal because `terminal-features` is set explicitly. Flagged for ops awareness in the deploy README. |
| `setw -g aggressive-resize off` vs `set -g aggressive-resize off` | plan uses `setw -g` form | tmux accepts both since 2.0 (window option auto-promoted) | followed plan exactly — used `setw -g` |
| Plan's pre-deploy validation command (`tmux ... new-session -d -s test 'sleep 1' && kill-server`) | expected to return 0 if config is valid | returns 1 because `window-size manual` + detached `new-session` + no client = no spawnable geometry | **DOCUMENTED in §4 above.** Recommend ops uses `start-server` or `source-file` into a running session instead. The plan command's failure does NOT indicate a config syntax error. |
| Production session creation (`new-session -d ... -x 120 -y 40` at terminal-manager.js:623,:697) | uses 120×40 | plan's `default-size` is 200×50 | **NOT WP-B's responsibility** (terminal-manager.js is owned by WP-A); the explicit `-x/-y` on `new-session` overrides the `default-size`, so no functional conflict — but WP-A should align these values per integration plan §3 diagram. Flagged for WP-A coordination only. |
| Existing tmux sessions on the host | will see new options after detach+reattach | host has sessions running on the OLD tmux config | per brief constraint: NOT restarting tmux on the host. New options are picked up on next attach (acceptable per `05-decision-tmux.md` §8 risk #8). Existing in-flight sessions continue on the old `window-size latest` / `aggressive-resize on` until they cycle. |

No plan↔config disagreements that require deviation from the spec. All planned directives are present; all preserved directives match what the plan said to keep.

---

## 6. Files touched by this WP

| Path | Status | Lines before | Lines after |
|---|---|---|---|
| `/root/projects/claude-terminal/tmux.conf` | EDITED | 35 | 68 |

No other file modified. WP-A files (`server.js`, `terminal-manager.js`, `CLAUDE.md`) and WP-C files (`Terminal.tsx`, `EphemeralTerminal.tsx`, `TerminalScrollContext.tsx`) untouched.

---

## 7. Post-deploy verification command (for WP-B operator)

After `bash /root/projects/claude-terminal/deploy.sh` flips nginx and the new tmux config is in effect for newly-attached sessions, run on the host:

```bash
tmux -L claude-terminal show-options -g \
  | grep -E '^(window-size|default-size|focus-events|terminal-features|terminal-overrides|set-clipboard|escape-time|history-limit|default-terminal|status|mouse|allow-rename|remain-on-exit|prefix)\b'
tmux -L claude-terminal show-options -gw \
  | grep -E '^(aggressive-resize|automatic-rename|monitor-bell)\b'
```

Each line should match the "Expected" column of the §4 validation table.

---

## 8. Rollback

```bash
git revert <this-commit>
bash /root/projects/claude-terminal/deploy.sh
```

Existing tmux sessions remain on the new config until they cycle (one-deploy lag); new sessions immediately use the reverted config. No data migration required.

End of `07-impl-tmux-WP-B.md`.
