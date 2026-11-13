# Build branch: hands-on workspace practice from any lesson step — design

Status: draft for owner approval · 2026-11-13

## Intent and why

The learner is in a teaching session (example: chat "101", tracing a Flask `/chat` endpoint). Multiple-choice checks confirm recognition, not understanding. The learner wants to **leave the lesson at any step, build the real thing with their own hands in a real workspace, then return** to the lesson, which continues where it paused and adapts to what the build showed.

Owner's goal: become a deep CS practitioner — "understand the concept deeply, not memorize it." The workspace must handle anything a CS learner does (write code, edit files, run programs, start servers, use databases, debug, break and fix), not only shell commands.

The experience follows the **CodeCrafters philosophy**: build the real thing from scratch in small stages; each stage is described as Hook → Concept → Tests → Notes; automated tests are the judge; the loop is edit → run tests → see the result. It is combined with this app's own theory (`docs/teaching-methodology.md`): one reasoning step per stage, predict before running, and the terminal condition is that the concept feels obviously true. The final stage always places the learner's build next to the real tool (e.g. their raw-socket server next to Flask's `/chat`), which is where loose facts collapse into "Flask just does this for me."

## Goals

1. A **Build it yourself** button on **every** teaching step (every node-tagged explanation/check in the transcript, not only the current one) opens a **build branch**: a child session tied to the parent chat and that plan node.
2. Each branch runs three phases:
   1. **Customize** — the agent already has the main session's probe assessment, the lesson goal, the plan, and the branched-from step. It continues from there (no fresh probe), talks with the learner until they agree on what to build, and asks only quick checks for prerequisites the main probe never covered. It ends by presenting a **build plan** (ordered stages); the learner accepts or asks for changes, as with the main lesson's plan. The size of the build is decided here, per branch.
   2. **Build** — stage by stage, CodeCrafters-style (below).
   3. **Return** — a summary (solid / shaky / gaps, with evidence) is added to the parent lesson; the main lesson resumes at the step it paused on and the teacher adapts.
3. The branch screen has a **coach chat**, **build plan / stage panel**, **file list**, **code editor**, **real terminal**, and a **Run tests** button.
4. **Both the learner and the AI** can type in the same terminal and create/edit files. Every terminal line and file change is attributed (`you` / `AI`); the coach sees commands, output, errors and edits.
5. Branches survive restarts, appear under their parent in history, and can be reopened with folder and transcript intact. Multiple branches per step are allowed.

## Non-goals (for now)

- No sandbox / Docker isolation (owner decision: runs directly on the laptop).
- No time or duration estimates anywhere in the experience (owner decision).
- No knowledge-graph writes from branches (outcomes are session evidence, like existing practice).
- No change to the side chat (stays tool-less) or to graph-based Practice sessions.
- No git-push submission; tests run locally in the branch folder.

## Anti-goals (failure even if it "works")

- The AI writes the learner's solution code or does the concept-carrying work while the learner watches.
- Tests changed after a stage starts (moving the goalposts).
- Multiple-choice probing inside the branch.
- Starting the learner over: re-probing what the main session already established.
- The main lesson silently changing, skipping, or losing its place while a branch is open.
- The AI touching files outside the branch folder.

## Constraints

- Runs on the learner's machine (Windows + WSL). Shell: **WSL bash when available, otherwise PowerShell** (my call).
- **Confinement:** the coach prompt forbids paths outside the branch folder (owner decision), **plus** a server-side guard (my call): AI-issued commands and file operations whose paths resolve outside the folder (absolute paths, `..`, `~`, symlinks) are refused with an error the model sees. A mistake-catcher, not a security boundary; docs and UI say so.
- Follows existing contracts: `ChatRecord` versioning, write-ahead turns, SSE streaming, prompt composition under `src/agent/prompts/`, tool validation/healing in `src/agent/tools.ts`.
- Terminal uses a native PTY module in the Next server process; must work in `npm run dev`, `desktop:dev`, and packaged Electron (native rebuild/unpack).
- No WebSockets in the app router today: terminal output over **SSE**, input over **POST**.
- Repo files use CRLF.

## Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| 1 | **New "build" session kind linked to the lesson**: child `ChatRecord` with a parent link, a new coach agent with real tools, a new branch screen, summary returned to the parent as a custom marker. | Largest build; reuses sessions, turns, persistence, recovery, history. | **Chosen by owner.** |
| 2 | Upgrade the side chat into a workspace. | Side chat is deliberately tool-less and not an application turn; changing that breaks its contract. | Rejected. |
| 3 | A plugin. | Keeps core untouched; plugin ability to spawn a PTY is unverified. | Rejected for v1. |

Branch contents: **starter files + a stage test file written by the coach** (CodeCrafters' starter-repo model), chosen over an empty folder or copying the learner's real project. Copying a real project can be a later option.

## Design

### Experience

```
 MAIN LESSON ──●── http ──●── anatomy ──●── ...      [⚒ Build it yourself] on every step
                   │
                   ▼
 BRANCH  1 CUSTOMIZE  agent reads probe + goal + step → talks → build plan → learner accepts
         2 BUILD      per stage: Hook → Concept → Tests → Notes
                      predict → learner codes → Run tests → pass/fail → explain why it passed
                      final stage: learner's build next to the real tool
         3 RETURN     summary → parent lesson resumes at the paused step
```

Example (step "HTTP is plain text"): stage 1 accept a socket connection and print the raw bytes; stage 2 reply `HTTP/1.1 200 OK\r\n\r\n` by hand; stage 3 route `/chat` → 200, else 404; stage 4 missing `Authorization` → 401; stage 5 parse JSON body, empty → 400; final: map each piece onto the learner's Flask `/chat` code.

### Coach doctrine (new prompt folder `src/agent/prompts/build/`)

`00-base.md` (tool mechanics) and `10-doctrine.md` (method), composed with the shared voice/accuracy/formatting fragments and overridable like the other agents. Doctrine rules:

1. **Customize before building.** Continue from the main session's assessment; never re-probe what it established. Ask only targeted checks for prerequisites it did not cover. Talk until the build is agreed; present the build plan through the plan tool; wait for the learner's acceptance.
2. **Stages are reasoning steps.** Each stage adds one capability and one concept, ordered so each builds on held ground.
3. **Stage format:** Hook (one line: what you will make happen), Concept (the idea behind it, minimal), Tests (exactly what the tests will do and expect), Notes (scope limits: what is deliberately left for later).
4. **Tests first, then locked.** Write starter files and the stage's test file before posing the stage. The test file is committed and cannot be changed for that stage. If a test is wrong, say so explicitly, record it, and repost the stage.
5. **Predict before run.** Before each test run or command that demonstrates the concept, the learner predicts the outcome.
6. **The learner's hands do the work.** The coach runs commands only for setup or demonstration, announces them first, and never writes the learner's solution code. Help is a hint ladder, one rung per request: point at the failing test output → name the concept → point at the relevant line/area → show an analogous (not identical) snippet.
7. **Tests are the judge.** Pass/fail comes from the test run, not the coach's opinion. After a pass, the learner explains why it passed; a pass without a correct explanation is noted as shaky.
8. **Break it on purpose.** Where useful, after a pass the coach asks the learner to break the code in a predicted way and observe the failure.
9. **Close with the real tool.** The final stage maps the learner's build onto the real system they are learning (Flask, the protocol, the library).
10. **Return with evidence.** The summary lists strands as solid / shaky / gap, each with evidence quoted from test runs, terminal output, or the learner's explanations.
11. One task at a time; end the turn after giving the learner something to do. No time or duration estimates.

### Coach tools

- `set_level` — record the build level the learner agreed to (guided / half / scratch) with its evidence; required before `build_plan` (added later the same day: [build calibration](2026-11-13-build-calibration.md)).
- `build_plan` — set/replace the stage list (validated; drives the stage panel). Acceptance is the learner's natural reply, as with `plan_init`.
- `stage_start` — pose a stage: hook/concept/tests/notes text, starter files, test file + test command. Commits and locks the test file; one active stage at a time.
- `run_tests` — run the active stage's test command (also the **Run tests** button); returns pass/fail, bounded output, exit code. Each run is recorded with its attribution and the learner's prediction, if any.
- `stage_complete` — record outcome (passed / passed-shaky / skipped) with evidence.
- `terminal_run` — run a command in the branch terminal, visible live, attributed `AI`; returns bounded output, exit code, still-running flag (servers).
- `terminal_read` — recent terminal transcript, including learner lines.
- `file_read`, `file_write`, `file_list` — confined to the branch folder; writes to a locked test file are refused.
- `return_to_lesson` — write the summary, mark the branch returned. The learner's **Done** button asks the coach to call it.
- Existing read-only file tools and research dispatch stay available (for reading the learner's real code, e.g. their Flask app).

Learner terminal input, file saves and test runs reach the coach as attributed custom entries at the start of its next turn (the "gather new raw exchanges" pattern side chats use), never interrupting a running call.

### Data

- `ChatKind` gains `"build"`.
- Build sessions carry `branch: { parentChatId, parentNodeId, parentNodeTitle, folder, shell, phase: "customize" | "build" | "returned", returnedAt?, summary? }`.
- Stage state on the branch record: plan (stage list), active stage, locked test file hash, per-stage outcome and test-run log.
- Context handed to the coach at branch start: parent goal, the parent's `probe_done` assessment, parent plan tree, the branched-from node and the lesson text up to that node.
- New `LhMarkerMessage.customType`: `"build-return"` — model-visible summary projected as user-role reference (like `side-question`), never as a learner answer; `details` carries branch id and node id for the UI.
- Workspace folder: `<learning data>/practice/<parentChatId>-<nodeId>-<n>/`, created on branch open, never deleted automatically.
- Terminal transcript persisted per branch (append-only, attributed, bounded with a truncation marker).

### UI

```
 ┌─ BUILD BRANCH: "HTTP is plain text" (from 101) ─────────────────────────┐
 │ Coach chat          │ Stages      │ Files     │ Editor: server.py        │
 │                     │ ✔ 1 bytes   │ server.py │                          │
 │                     │ ✔ 2 200 OK  │ test_3.py │                          │
 │                     │ ▶ 3 routing │           │                          │
 │                     │ · 4 401     ├───────────┴──────────────────────────┤
 │                     │ · 5 400     │ Terminal  (AI / YOU per line)        │
 │                     │             │ [ Run tests ]                        │
 ├─────────────────────┴─────────────┴──────────────────────────────────────┤
 │ [ Done → back to lesson ]                                                │
 └──────────────────────────────────────────────────────────────────────────┘
```

- **Build it yourself** on every node-tagged explanation/check in the main transcript.
- Main lesson shows a branch marker at that step (open / returned) that reopens the branch; after return it shows the summary card.
- Terminal: `xterm.js`. Editor: CodeMirror or Monaco (builder's call; lighter preferred).

### Return flow

1. Learner clicks **Done**, or the coach proposes returning after the final stage.
2. Coach calls `return_to_lesson`.
3. Server appends a `build-return` marker to the parent chat, sets the branch phase to `returned`, stops the branch's running processes, and navigates back.
4. Teacher doctrine gains one paragraph: use build summaries to repair gaps or move faster; do not re-teach what the evidence shows is solid.

## Left to the builder

- PTY library and Electron packaging.
- Exact endpoints under `app/api/chats/[id]/build/...`.
- Editor library.
- Test command conventions per language (default: a Python test script run by the shell).
- Transcript limits and truncation format.
- Parent→child indexing.
- Tests: confinement guard (inside/outside, `..`, `~`, symlinks), locked test file refusal, branch create/return persistence, marker projection into teacher context, restart recovery of an open branch, button presence on past steps.
