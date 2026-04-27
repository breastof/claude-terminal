# Tmux Streaming Reliability — Agent Roster Plan

> Goal: permanently fix divergence between browser xterm.js view and real tmux output in claude-terminal.

---

## Hypotheses to Investigate (starting checklist for downstream agents)

1. **UTF-8 cut on WS frame boundary** — node-pty emits Buffer chunks; if server forwards as UTF-8 string before chunk-aligning multi-byte codepoints, browser receives mojibake / truncated escape sequences.
2. **Replay buffer truncation mid-escape-sequence** — 500 KB circular buffer in `terminal-manager.js` likely slices on byte count; on reconnect the head of the replay can start mid-CSI/OSC, leaving xterm.js in a broken parser state.
3. **No backpressure / flow control** — if WS `send()` is fire-and-forget without checking `bufferedAmount`, slow clients cause server-side buffering blow-up or, worse, dropped writes when socket is in CLOSING state.
4. **xterm.js `write()` not awaited** — calling `term.write(chunk)` without chaining the next chunk on its callback can interleave async writes out of order under high throughput.
5. **Reconnect race: late buffer flush vs. live stream** — on resume the server may push replay AND new live bytes concurrently, producing duplicated or out-of-order frames.
6. **tmux `pipe-pane` vs control-mode mismatch** — using raw `pipe-pane` loses redraw/resize semantics; tmux `-CC` (control mode) gives structured `%output` events with pane IDs and would eliminate "ghost output" classes.
7. **PTY resize storms** — `resize` event from xterm fires per-keystroke during fit; if not debounced, tmux re-renders the entire pane mid-stream and bytes from the old size race with the new.
8. **Server-side throttling / coalescing** — if `terminal-manager.js` batches output on a timer, escape sequences split across batches can land in different WS frames and arrive reordered with control messages.
9. **Two clients on one session** — multiplexed broadcast without per-client cursor may send each client a different slice of the replay than the live stream expects.
10. **nginx blue/green flip mid-session** — upstream switch can sever WS without graceful drain; client reconnects to a fresh server with an empty replay buffer.

Downstream agents must explicitly accept-or-reject each hypothesis with evidence.

---

## Phase 2 — Architecture Scan (3 agents, parallelizable)

### `scanner-pty-pipeline`
- **Role**: Map the full data path: node-pty → tmux attach → server.js handler → WS send.
- **Inputs**: source files (`server.js`, `terminal-manager.js`, `tmux.conf`).
- **Outputs**: `agent-workflow/02-scan-pty.md` — sequence diagram, every `.on('data')` / `.write()` / `.send()` call site, encoding decisions, chunk sizes observed in code.
- **Tools**: Read, Grep, Bash (`wc`, `node -e` for chunk-size probe).
- **Decisions to close**: Are buffers passed as Buffer or string? Is there any UTF-8 boundary handling? Where is the 500 KB replay sliced? Is `pipe-pane` or control-mode used?
- **Dependencies**: none.

### `scanner-ws-transport`
- **Role**: Audit WebSocket layer — framing, backpressure, reconnect handshake, ping/pong, broadcast fan-out.
- **Inputs**: `server.js`, `Terminal.tsx`, `EphemeralTerminal.tsx`.
- **Outputs**: `agent-workflow/02-scan-ws.md` — message protocol table, reconnect state machine, list of every code path that can drop or duplicate a frame.
- **Tools**: Read, Grep.
- **Decisions to close**: Does server check `ws.bufferedAmount`? Is there an ack/seq number? What happens to in-flight bytes during reconnect? Is `binaryType` set?
- **Dependencies**: none.

### `scanner-xterm-client`
- **Role**: Audit browser-side render path — xterm.js write loop, resize/fit, IME, addons.
- **Inputs**: `Terminal.tsx`, `EphemeralTerminal.tsx`, `package.json` (xterm version + addons).
- **Outputs**: `agent-workflow/02-scan-client.md` — write-call audit, resize debounce status, addon list, callback chaining pattern.
- **Tools**: Read, Grep.
- **Decisions to close**: Are `write()` calls chained via callback? Is `FitAddon` debounced? Is `WebLinksAddon` / serializer interfering? Is replay applied before live stream resumes?
- **Dependencies**: none.

---

## Phase 3 — Best-Practice Research (2 agents, parallelizable)

### `researcher-pty-streaming`
- **Role**: Survey proven PTY-to-browser streaming stacks.
- **Inputs**: Phase 2 outputs (for context on current stack).
- **Outputs**: `agent-workflow/03-research-streaming.md` — one section per project: ttyd, gotty, code-server, VS Code Remote Server, wetty, Jupyter terminal, sshx, xterm.js official examples. For each: protocol, framing, backpressure approach, UTF-8 handling, replay/scrollback strategy.
- **Tools**: Read, WebSearch, WebFetch.
- **Decisions to close**: Which projects solve UTF-8 chunking? Which use binary frames? Which implement seq+ack? Which use snapshot+delta?
- **Dependencies**: Phase 2 (for relevance filtering).

### `researcher-tmux-modes`
- **Role**: Deep-dive tmux attach modes: control mode (`-CC`), `pipe-pane`, `capture-pane`, `iTerm2` integration spec.
- **Inputs**: Phase 2 outputs, tmux man page.
- **Outputs**: `agent-workflow/03-research-tmux.md` — comparison of attach modes, what each guarantees about output ordering, support for resize/redraw, multi-client semantics; concrete example of control-mode `%output` parsing.
- **Tools**: Read, WebSearch, WebFetch, Bash (`man tmux`, test harness).
- **Decisions to close**: Does tmux control mode eliminate replay-buffer-truncation risk? Cost of switching from raw attach to `-CC`? Does `capture-pane -p -e -J` give a clean snapshot for reconnect?
- **Dependencies**: Phase 2.

---

## Phase 4 — Pros/Cons Analysis (1 agent)

### `analyst-tradeoffs`
- **Role**: For every candidate solution from Phase 3, produce structured pros/cons against current claude-terminal constraints (mobile UX, blue/green deploy, single-user, low-latency Russian VPS).
- **Inputs**: `02-scan-*.md`, `03-research-*.md`.
- **Outputs**: `agent-workflow/04-tradeoffs.md` — one matrix row per candidate × criterion (correctness, complexity, deploy risk, mobile cost, latency, dev time).
- **Tools**: Read.
- **Decisions to close**: Rank candidates; flag any that hard-conflict with existing architecture.
- **Dependencies**: Phase 2 + 3.

---

## Phase 5 — Tech-Lead Arbiter (1 agent)

### `arbiter-tech-lead`
- **Role**: Pick the final solution set. Must be opinionated.
- **Inputs**: All Phase 2-4 artifacts.
- **Outputs**: `agent-workflow/05-decision.md` — chosen stack, rejected alternatives with one-line reasons, success criteria (e.g. "zero divergence over 1h Claude Code session at 500 KB/s burst").
- **Tools**: Read, Write.
- **Decisions to close**: Binary WS frames yes/no? Switch to tmux control mode yes/no? Add seq+ack yes/no? Replace replay buffer with snapshot+delta yes/no?
- **Dependencies**: Phase 4.

---

## Phase 6 — Integration Plan (1 agent)

### `planner-integration`
- **Role**: Translate Phase 5 decision into a file-by-file change plan with non-overlapping work packages.
- **Inputs**: `05-decision.md`, current source tree.
- **Outputs**: `agent-workflow/06-integration-plan.md` — per-file diffs sketch, new files, migration steps, rollback plan, partitioned work packages WP-A / WP-B / WP-C with explicit "files owned" lists.
- **Tools**: Read, Grep.
- **Decisions to close**: Which work package owns which file? What's the merge order? What feature flag gates the new path?
- **Dependencies**: Phase 5.

---

## Phase 7 — Implementation (3 agents, parallel — disjoint files)

### `impl-server-transport`
- **Role**: Implement server-side changes (WS framing, backpressure, seq numbers, replay rework).
- **Inputs**: `06-integration-plan.md` WP-A.
- **Outputs**: code changes in `server.js`, `terminal-manager.js`; `agent-workflow/07-impl-server.md` change log.
- **Tools**: Read, Edit, Write, Bash.
- **Dependencies**: Phase 6.

### `impl-tmux-attach`
- **Role**: Implement tmux attach-mode change (e.g. control mode wrapper) and `tmux.conf` tuning.
- **Inputs**: `06-integration-plan.md` WP-B.
- **Outputs**: changes in `tmux.conf` + new tmux-control-mode module; `agent-workflow/07-impl-tmux.md`.
- **Tools**: Read, Edit, Write, Bash.
- **Dependencies**: Phase 6.

### `impl-client-render`
- **Role**: Implement browser-side changes (binary frames, write chaining, resize debounce, reconnect protocol).
- **Inputs**: `06-integration-plan.md` WP-C.
- **Outputs**: changes in `Terminal.tsx`, `EphemeralTerminal.tsx`, related hooks; `agent-workflow/07-impl-client.md`.
- **Tools**: Read, Edit, Write, Bash.
- **Dependencies**: Phase 6.

---

## Phase 8 — Validation (2 agents, parallel)

### `validator-build-types`
- **Role**: Run build, typecheck, lint; fix mechanical breakage only.
- **Inputs**: Phase 7 code.
- **Outputs**: `agent-workflow/08-validate-build.md` — pass/fail with logs.
- **Tools**: Bash, Read, Edit.
- **Dependencies**: Phase 7.

### `validator-behavioral`
- **Role**: Run scripted stress tests: `yes | head -c 5M`, `htop`, full-screen vim redraw, rapid resize, reconnect mid-stream, 1h Claude Code session.
- **Inputs**: Phase 7 code, Phase 5 success criteria.
- **Outputs**: `agent-workflow/08-validate-behavior.md` — per-test result, divergence-detection method (diff `tmux capture-pane` vs xterm serializer).
- **Tools**: Bash, Read.
- **Dependencies**: Phase 7.

---

## Phase 9 — Audit Against Original Ask (1 agent)

### `auditor-user-intent`
- **Role**: Verify the fix actually addresses the user's complaint ("ломающаяся трансляция", "пакеты теряются") — not just adjacent issues.
- **Inputs**: original complaint, Phase 8 results, Phase 5 success criteria.
- **Outputs**: `agent-workflow/09-audit.md` — checklist of user pain points × evidence; explicit "permanently fixed" yes/no per symptom.
- **Tools**: Read.
- **Dependencies**: Phase 8.

---

## Phase 10 — Final Test + Polish (1 agent)

### `polisher-final`
- **Role**: Live deploy via `bash deploy.sh`, smoke-test in production, tidy logs/comments, update `CLAUDE.md`.
- **Inputs**: All prior artifacts.
- **Outputs**: deployed system; `agent-workflow/10-final.md` — release notes, follow-up tickets, monitoring hooks.
- **Tools**: Read, Edit, Bash.
- **Dependencies**: Phase 9.
