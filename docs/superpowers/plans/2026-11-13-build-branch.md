# Build Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Build it yourself" button on every lesson step opens a child "build" session with a CodeCrafters-style coach, a real terminal, files, an editor and locked stage tests; returning delivers an evidence summary to the parent lesson.

**Architecture:** A new `ChatKind` `"build"` reuses the existing turn/persistence pipeline (chat-handler builds a `createBuildAgent` for it, like practice). Workspace I/O (files, PTY terminal, tests) lives in `src/server/build-workspace.ts` + `src/server/build-terminal.ts` behind confinement helpers in `src/core/build-branch.ts`. Learner workspace activity reaches the coach as a `build-activity` marker at turn start; returns are queued on the parent (`ChatRecord.buildReturns`) and delivered as `build-return` markers at the parent's next learner turn (never between a tool call and its result).

**Tech Stack:** Next 16 app router, TypeScript, pi-agent-core tools (typebox), `@lydell/node-pty` (prebuilt N-API PTY, lazy-loaded, pipe-shell fallback), `@xterm/xterm` + `@xterm/addon-fit`, CodeMirror 6 (`codemirror`, `@codemirror/lang-python`, `@codemirror/lang-javascript`), node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-11-13-workspace-practice-branch-design.md`

## Global Constraints

- Shell: WSL bash when available on Windows (`wsl.exe`), else PowerShell; `bash` on Linux/macOS.
- Coach file/command paths confined to the branch folder; guard is a mistake-catcher, not a security boundary.
- Test file locked once a stage starts; writes to it are refused.
- No time/duration estimates in prompts or UI copy.
- Build sessions never run graph extraction.
- Folder: `<LH_DATA_DIR>/practice/<parentChatId>-<nodeId|start>-<n>/`, never auto-deleted.
- Record writes mid-turn never touch `messages` (write-ahead/persistTurn owns them).

## Review Focus

1. Path escape via `..`, absolute paths, `~`, or a symlink inside the folder → refused (tests in Task 1, Task 2).
2. A `build-return` arriving while the parent has a pending quiz → delivered only after the answer, never between call and result (Task 5 test).
3. PTY module fails to load (packaged/unsupported platform) → terminal still works via pipe shell (Task 3 fallback test).
4. A long-running server started by `terminal_run` → tool returns "still running" with partial output, process stopped on return (Task 3 test).
5. Branch reopened after restart → stages, folder, transcript intact (Task 2 state file test).

---

### Task 1: Core contracts and pure helpers
**Files:** Modify `src/core/contracts/chat.ts`, `src/core/native-messages.ts`, `src/core/prompt-segments.ts`; Create `src/core/build-branch.ts`; Test `tests/build-branch.test.ts`.
**Produces:** `ChatKind = "teach" | "practice" | "build"`; `BuildBranch { parentChatId; parentNodeId: string | null; parentNodeTitle: string; folder: string; phase: "customize" | "build" | "returned"; returnedAt?: string }`; `BuildReturnEntry { id; branchId; nodeId: string | null; nodeTitle: string; summary: string; createdAt: string; delivered: boolean }`; `ChatRecord.branch?`, `ChatRecord.buildReturns?`; marker types `"build-context" | "build-activity" | "build-return"` (neutral cause); `resolveInside(folder, rel): string | null`; `commandEscape(command, folder): string | null`; `buildContextText(parent, nodeId): { text; nodeTitle }`; `newBuildContextMessage`, `newBuildActivityMessage`, `newBuildReturnMessage`; `branchFolderName(parentId, nodeId, n)`.
- [ ] Tests: `resolveInside` accepts `a/b.py`, rejects `../x`, `/etc/passwd`, `C:\\x`, `~/.ssh`; `commandEscape` flags `cat /etc/passwd`, `cd ..`, `rm -rf ~`, allows `python3 server.py`, `curl -i http://localhost:5000/chat`; `buildContextText` includes goal, probe assessment, plan node titles and lesson text up to the node.
- [ ] Implement; run `npx tsx --test tests/build-branch.test.ts`; typecheck.

### Task 2: Store + workspace server (files, state, tests runner)
**Files:** Modify `src/store/chats.ts`, `src/core/ports.ts`; Create `src/server/build-workspace.ts`; Test `tests/build-workspace.test.ts`.
**Produces:** `createChat(title, kind?: "practice" | "build", branch?)`; `saveBranch(id, branch)`; `queueBuildReturn(parentId, entry)`; `markBuildReturnsDelivered(parentId, ids)`; workspace API: `ensureFolder(branch)`, `listFiles(folder)`, `readFile(folder, rel)`, `writeFile(folder, rel, content, by)`, `readState(branchId)`, `writeState(branchId, state)` (`BuildState { plan: BuildStage[]; activeStage: number | null; lockedTest?: { path; sha256 }; testCommand?: string; runs: TestRun[]; activityWatermark: number; events: WorkspaceEvent[] }`), `runTests(branchId, by): Promise<TestRun>`.
- [ ] Tests: realpath symlink escape refused; locked test write refused; state round-trips; `runTests` captures exit code/pass.

### Task 3: Terminal service
**Files:** Create `src/server/build-terminal.ts`; Test `tests/build-terminal.test.ts`; Modify `package.json` (deps), `next.config.ts` (`serverExternalPackages` add `@lydell/node-pty`).
**Produces:** `terminalFor(branchId, folder)`: `{ write(data), resize(cols, rows), subscribe(fn): unsubscribe, transcript(sinceSeq?), stop() }`; `runAiCommand(branchId, folder, command, { timeoutMs }) → { output; exitCode: number | null; running: boolean }`; `stopBranchProcesses(branchId)`.
- [ ] Tests (pipe fallback forced via env `LH_BUILD_PTY=off`): echo round-trip; AI command banner + exit code; `sleep 30` returns running and is killed by `stopBranchProcesses`.

### Task 4: Coach agent (tools + prompts)
**Files:** Create `src/agent/tools/build.ts`, `src/agent/prompts/build/00-base.md`, `src/agent/prompts/build/10-doctrine.md`; Modify `src/agent/teacher-agent.ts`, `src/agent/prompt-segments.ts`; Test `tests/build-tools.test.ts`.
**Produces:** `BuildToolContext { branchId; chatStore; workspace; terminal }`; `buildTools(ctx)` registry: `build_plan`, `stage_start`, `run_tests`, `stage_complete`, `terminal_run`, `terminal_read`, `file_read`, `file_write`, `file_list`, `return_to_lesson`; `createBuildAgent(ctx, opts)`.
- [ ] Tests: `stage_start` before `build_plan` errors; second `stage_start` while active errors; `file_write` to locked test errors; `terminal_run` with escaping path errors; `return_to_lesson` queues a parent return and sets phase `returned`.

### Task 5: Turn pipeline wiring
**Files:** Modify `src/server/chat-handler.ts`; Test `tests/build-flow.test.ts`.
- [ ] Build sessions construct `createBuildAgent`; prompt-size estimate uses `"build"`; no extraction.
- [ ] At build-session turn start, append one `build-activity` marker summarizing new terminal lines / file saves / test runs since the watermark (skip when empty).
- [ ] At teach-session learner turn start (not staged automatic), when no question is left unresolved, append undelivered `build-return` markers and mark them delivered after the write-ahead save.

### Task 6: HTTP routes
**Files:** Create `app/api/chats/[id]/build/route.ts` (POST create from parent `{ nodeId }`, GET branches), `app/api/chats/[id]/workspace/route.ts` (GET state+files), `.../workspace/file/route.ts` (GET/PUT), `.../workspace/terminal/route.ts` (GET SSE, POST `{ data } | { cols, rows }`), `.../workspace/tests/route.ts` (POST).
- [ ] Route-level guards: 404 unknown chat, 400 non-build chat, same-origin writes per existing proxy.

### Task 7: UI
**Files:** Create `components/build/workspace-panel.tsx`, `components/build/terminal-view.tsx`, `components/build/code-editor.tsx`, `components/build/build-button.tsx`; Modify `components/chat.tsx` (kind `"build"`, header chip, workspace slot, Done button, build button beside side entry, build-return card), `app/chat/[id]/page.tsx`, `src/core/view.ts` (build markers to parts).
- [ ] Manual verification in `npm run dev`: create branch from a lesson step, terminal echo, edit+save file, Run tests, Done → parent shows summary.

### Task 8: Docs + full verification
**Files:** Modify `docs/architecture.md` (Build branches section), `docs/getting-started.md` (one paragraph).
- [ ] `npx tsc --noEmit`, `npm run lint`, targeted tests, full `npm test` compared to baseline.
