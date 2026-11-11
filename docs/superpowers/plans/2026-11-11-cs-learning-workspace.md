# Programming Learning (Workspace, Build Courses, Infinite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Every new chat gets a folder on disk that the agent can run commands and write files in, teaching sessions can run staged "build your own X" courses, and a third chat kind, Infinite, poses endless harder coding challenges toward an agreed target.

**Architecture:** A required `agent.workspace.path` setting; `POST /api/chats` creates `<path>/<slug>-<id-tail>` and stamps it on the chat record as `workspaceDir`. When a record has `workspaceDir`, the teacher, practice and infinite agents receive two extra tools (`run_command`, `write_file`) and a short workspace instruction block; every tool call of every agent is appended to a per-chat JSONL log. Infinite is a new `ChatKind` that behaves as practice everywhere (same `problem`/`conclude` tools, same UI flow) except for its own prompt directory and its label.

**Tech Stack:** TypeScript, Next.js 16 route handlers, React 19, pi-agent-core tools (TypeBox schemas), `node:test` via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-11-11-cs-learning-workspace-design.md`

## Global Constraints

- Read `node_modules/next/dist/docs/` before changing route or page files (`AGENTS.md`).
- The agent layer (`src/agent/`) never imports `src/store/` adapters.
- Prompt fragments: filename `^\d+-[\w.-]+\.md$`, tool names must match real schemas.
- Practice sessions behave exactly as today, apart from gaining the workspace tools.
- No sandbox, no in-app editor or terminal, no migration of existing chats.
- The sensitive-path guard (`src/agent/tools/fs-shared.ts`) applies to `write_file`.
- No CodeCrafters text, names or branding anywhere.
- Plugins see an Infinite chat as `"practice"`; the plugin API types do not change.

## Review Focus

1. Workspace path set to a folder that does not exist or cannot be written: chat creation must fail with a readable message and leave no chat record.
2. A chat title with characters illegal in folder names (`/ \ : * ? " < > |`, emoji, only spaces): the folder name must still be valid on Windows, macOS and Linux.
3. A command that never exits or prints megabytes: it must be killed at its time limit and its output cut, without hanging the turn.
4. A chat created before this change (no `workspaceDir`): it must open and run turns exactly as before, with no workspace tools and no button.
5. `code` is not on PATH: the open-folder action must report the folder path instead of failing silently.

---

### Task 1: Core types, helpers, and the workspace setting

**Files:**
- Create: `src/core/workspace.ts`
- Modify: `src/core/contracts/chat.ts`, `src/core/ports.ts`, `src/core/settings.ts`, `src/core/settings-resolution.ts`, `src/core/index.ts`, `src/server/settings-body.ts`
- Test: `tests/workspace-core.test.ts`

**Interfaces — Produces:**
- `type ChatKind = "teach" | "practice" | "infinite"`
- `isPracticeLike(kind: string | undefined): boolean` (true for practice and infinite), in `contracts/chat.ts`
- `ChatRecord.workspaceDir?: string`
- `ChatStore.createChat(title: string, kind?: "practice" | "infinite", workspaceDir?: (id: string) => string): ChatRecord`
- `src/core/workspace.ts`: `interface WorkspaceSettings { path?: string }`, `isWorkspacePath(value: string): boolean` (absolute, `~`, or `~/…`; no NUL), `workspaceFolderName(title: string, chatId: string): string`, `WORKSPACE_NOT_CONFIGURED_CODE = "workspace_not_configured"`, `WORKSPACE_NOT_CONFIGURED_MESSAGE = "Choose a workspace folder in Settings → Agent before starting a chat."`
- `AgentSettings.workspace?: WorkspaceSettings`; effective settings expose `agent.workspace`.

- [x] Test `workspaceFolderName`: `("Build your own Shell!", "chat_abc_12345678")` → `"build-your-own-shell-12345678"`; `("///", id)` → `"chat-12345678"`; a 200-character title gives a slug of at most 40 characters; reserved names (`con`, `nul`) get the `chat-` prefix; trailing dots and spaces are stripped.
- [x] Test `isWorkspacePath`: accepts `/a/b`, `C:\\x`, `~/code`; rejects `relative/x`, `""`, a string with NUL.
- [x] Test `parseAgentSettingsBody({ workspace: { path: "relative" } })` fails; `{ workspace: { path: "~/lh" } }` succeeds; `{ workspace: {} }` clears the path.
- [x] Implement, run `npx tsx --test tests/workspace-core.test.ts`, expect pass.

### Task 2: Chat creation creates the folder

**Files:**
- Create: `src/server/workspace.ts`
- Modify: `src/store/chats.ts`, `src/server/index.ts`, `app/api/chats/route.ts`, `tests/graph-context.test.ts`, `tests/chat-birth-stamp.test.ts`
- Test: `tests/chat-workspace.test.ts`

**Interfaces — Produces:**
- `resolveWorkspaceRoot(): string | null` (settings path with `~` expanded; null when unset)
- `createWorkspaceFolder(root: string, title: string, chatId: string): string` (mkdir recursive; returns the absolute folder)
- `POST /api/chats` body `kind` accepts `"practice"` and `"infinite"`; unset path → `409 { error: WORKSPACE_NOT_CONFIGURED_MESSAGE, code: "workspace_not_configured" }`; mkdir failure → `500 { error }` and no chat record is left behind.

- [x] Test: no workspace setting → 409 with the code, `listChats()` unchanged.
- [x] Test: with a temp workspace → 200, folder exists, `getChat(id).workspaceDir` equals it.
- [x] Test: `kind: "infinite"` → record kind is `"infinite"`.
- [x] Test: workspace path pointing at a regular file → 500 and no new chat (Review Focus 1).
- [x] Implement; fix the two existing route tests by setting a temp workspace; run the three test files.

### Task 3: Workspace tools and the tool log

**Files:**
- Create: `src/agent/tools/workspace.ts`, `src/agent/tool-log.ts`
- Test: `tests/workspace-tools.test.ts`, `tests/tool-log.test.ts`

**Interfaces — Produces:**
- `runCommandTool(dir: string): AgentTool` named `run_command`, input `{ command: string, timeoutSeconds?: integer 1..600 }`, default 60 s; runs through the system shell with `cwd = dir`; result text is `exit code`, then stdout and stderr, each capped at 30 000 characters keeping the tail; a timeout kills the process tree and is reported as an error result.
- `writeFileTool(dir: string): AgentTool` named `write_file`, input `{ path: string, content: string }`; a relative path resolves against `dir`, an absolute path is used as is; parent folders are created; refused when `isSensitivePath` says so.
- `workspaceTools(dir: string): Record<string, AgentTool<any>>`
- `workspaceInstructions(dir: string): string`
- `withToolLog(chatId: string, agent: string, tools: AgentTool<any>[]): AgentTool<any>[]`; one JSON line per call in `toolLogDir.current/<chatId>.jsonl`: `{ t, agent, tool, callId, args, isError, result }` with `result` cut to 4 000 characters; `toolLogDir` is a test seam defaulting to `PATHS.data/tool-logs`. A logging failure never fails the tool call.

- [x] Test `run_command`: `echo hi` returns exit code 0 and `hi`; `pwd` equals the folder; a failing command reports its exit code without throwing; `sleep 5` with `timeoutSeconds: 1` returns an error result within 3 s (Review Focus 3); output larger than the cap is cut and says so.
- [x] Test `write_file`: relative path lands in the folder; nested folders are created; absolute path outside the folder is written; a `.env` target is refused.
- [x] Test `withToolLog`: a successful and a throwing tool each append one line with the exact args; an unwritable log folder does not break the call.
- [x] Implement and run both test files.

### Task 4: Agents — Infinite kind, workspace wiring, prompts

**Files:**
- Create: `src/agent/prompts/teacher/60-build-courses.md`, `src/agent/prompts/infinite/00-base.md`, `src/agent/prompts/infinite/10-doctrine.md`
- Modify: `src/core/prompt-segments.ts`, `src/agent/prompt-segments.ts`, `src/agent/teacher-agent.ts`, `src/agent/prompts/README.md`, `app/api/settings/prompts/route.ts`, `scripts/build-server.mjs` (only if prompts are listed by directory)
- Test: `tests/infinite-agent.test.ts`

**Interfaces — Produces:**
- `PromptAgent` and `AgentKind` gain `"infinite"`; infinite composes its own directory plus the practice shared allowlist, no teaching base.
- `AgentBuildOptions.workspaceDir?: string`
- `createInfiniteAgent(ctx: PracticeToolContext, opts?: AgentBuildOptions)`
- With `workspaceDir` and a `chatId`, teacher, practice and infinite get `run_command` and `write_file`, and `workspaceInstructions(dir)` is appended to the system prompt. The prober does not.
- With a `chatId` and no explicit test registry, all tools are wrapped by `withToolLog`.
- Plugin contributions for infinite are requested as agent `"practice"`.

- [x] Test: `composeInstructions("infinite")` contains the Infinite doctrine heading, not the teaching base's opening line, and includes the shared voice fragment.
- [x] Test: `composeInstructions("teacher")` contains the build-course heading.
- [x] Test: an infinite agent built with `workspaceDir` has tools `problem`, `conclude`, `run_command`, `write_file` and the folder path in its system prompt; a practice agent without `workspaceDir` has neither tool (Review Focus 4).
- [x] Test: a prober built with `workspaceDir` has no `run_command`.
- [x] Implement, run the test, then `tests/prompt-overrides.test.ts` and `tests/practice-agents.test.ts`.

### Task 5: Server — treat Infinite as practice, pass the folder

**Files:**
- Modify: `src/server/chat-handler.ts`, `src/server/plugin-problems.ts`, `src/core/input-events.ts`, `src/core/source-organization.ts` (and its `chatKind` producer), `components/chain-table.tsx`, `plugins/drawing-pad/src/backend.ts` only if it reads `record.kind` through a typed path
- Test: `tests/infinite-flow.test.ts`

- [x] Replace each `record.kind === "practice"` / `!== "practice"` in the files above with `isPracticeLike(record.kind)`; prompt-size estimates use the record's own agent kind.
- [x] Build `createInfiniteAgent` for `kind === "infinite"`; pass `workspaceDir: record.workspaceDir` in `agentOpts`.
- [x] Test with a scripted engine (pattern: `tests/practice-flow.test.ts`): an infinite chat poses a problem, the turn ends, the record holds the problem call, and no extraction is scheduled.
- [x] Run `tests/practice-flow.test.ts` and `tests/chat-flow.test.ts`.

### Task 6: Open-folder route

**Files:**
- Create: `app/api/chats/[id]/workspace/route.ts`
- Test: `tests/workspace-open.test.ts`

**Interfaces — Produces:** `POST /api/chats/:id/workspace` → `{ ok: true, path }` when the editor launched, `{ ok: false, path, error }` (status 200) when `code` could not be started, `404` for an unknown chat or one without a folder. The launcher is `launchEditor(dir: string): Promise<string | null>` in `src/server/workspace.ts`, with a test seam `editorCommand.current` (default `"code"`).

- [x] Test: unknown chat → 404; chat without folder → 404; seam set to a missing binary → `ok: false` with the path (Review Focus 5); seam set to `true`/`node -e ""` → `ok: true`.
- [x] Implement and run.

### Task 7: Interface

**Files:**
- Modify: `components/start-session.ts`, `components/new-session.tsx`, `app/chat/new/page.tsx`, `components/home.tsx`, `components/sidebar.tsx`, `app/chat/[id]/page.tsx`, `components/chat.tsx`, `components/settings/agent-section.tsx`
- Test: extend `tests/opening-prompt.test.ts` or add `tests/start-session-workspace.test.ts`

- [x] `SessionStarter.start` accepts `kind?: "practice" | "infinite"`; on a 409 with the workspace code it throws an `Error` whose message is `WORKSPACE_NOT_CONFIGURED_MESSAGE`. Test this with a fake fetch.
- [x] Home and the draft screen show that message instead of the generic failure.
- [x] Home mode switch: Teach / Practice / Infinite. Draft screen: `?mode=infinite`, title "New infinite session", placeholder "What do you want to get good at?".
- [x] Sidebar: an "Infinite" create button, an "Infinite" filter value, an infinity icon on infinite rows.
- [x] Chat page passes `kind` as `"practice"` for infinite chats plus `infinite` and `workspaceDir` props; the chat top bar shows "Infinite" for those and an "Open in VS Code" button when `workspaceDir` is set, which calls the Task 6 route and shows the folder path if the editor could not start.
- [x] Settings → Agent: a "Workspace folder" text field writing `agent.workspace.path`; Settings → prompts gains an "Infinite" tab.
- [x] Run the render tests that cover these components.

### Task 8: Whole-suite verification and docs

- [x] `npx tsc --noEmit`: no errors beyond the baseline set recorded before Task 1.
- [x] `npm test`: no failures beyond the baseline set.
- [x] `npm run lint` on changed files.
- [x] `npm run build` succeeds.
- [x] Add a "Workspaces and Infinite" section to `docs/architecture.md`; update the spec's status line.
