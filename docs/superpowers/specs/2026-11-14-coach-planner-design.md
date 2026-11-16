# Coach, planner and fresh-context teacher — design

Status: Implemented on branch `feat/coach-planner` (uncommitted)
Date: 2026-11-14. Source: design conversation with the owner plus three read-only code investigations.

## 1. Why

The Flask lesson (`data/chats/chat_mwff0i6s_e2fa4199.json`) failed in ways no single prompt edit fixes:

1. Hidden prerequisites (modules, exceptions, closures) were never probed and each blocked the lesson later.
2. Nothing defined when a plan node was learned; one multiple-choice answer moved the lesson on.
3. Nothing stepped back and corrected the road when the learner was stuck repeatedly.
4. The teacher carried planning, teaching, question and demo rules plus the whole history on a small model, and dropped rules (long turns, undefined terms, code not in view, options that leak the answer, malformed tool calls).
5. The learner never typed code.
6. The knowledge graph records what the teacher said, not what the learner showed.

## 2. Decisions made by the owner

| # | Decision |
|---|---|
| D1 | Three real agent switches, each with its own instructions: prober → planner → teacher. |
| D2 | The teacher starts with a fresh context when teaching begins and again at every plan node. It never sees the probe or planning conversation or earlier nodes' conversations. |
| D3 | Each fresh start gets a hard-coded handoff template filled deterministically by the app. Two templates: first node, later nodes. |
| D4 | A background worker, the coach, watches the learner. It is silent: it never addresses the learner; anything it needs asked goes through the prober or teacher. |
| D5 | The coach wakes after every learner answer, in the probe and in teaching. The next agent turn waits for it. The UI shows a minimal "Coach is reviewing…" indicator. |
| D6 | Coach output reaches the agents only as app-built fixed templates ("cards"). No free conversation between agents. |
| D7 | The coach sees the current node in full and past nodes only as a road record (what the node was, how it ended). |
| D8 | The coach decides when a node is passed. |
| D9 | The learner model is facts, arrows and results, the same shape as the knowledge graph (propositions and chains), not a hand-written profile. |
| D10 | Each fact holds a number (probability the learner knows it), updated by the app by formula after every graded answer. A node passes when all its facts are above the pass line. Fading with time is deferred. |
| D11 | The planner writes facts and arrows before teaching, in batches of 4 nodes. The app wakes the planner when 1 node of the batch is left. The coach may add missing facts, arrows and nodes. |
| D12 | The post-hoc extractor is off for teaching sessions. It stays for imported notes and PDFs. |
| D13 | Typed-code questions come from the Coding questions core plugin inside the lesson. The build workspace stays for larger builds. |
| D14 | Coach-added nodes look different on the plan map. The knowledge-base graph is unchanged for now, except that it later shows the number. |
| D15 | Evidence persists across sessions. |
| D16 | All roles keep the existing session model. Reliability comes from narrow instructions, fresh context, app-side rules and strict tool validation. |
| D17 | Built in one go. The main session manages; Opus 5.5 subagents implement to written briefs. |

## 3. Further decisions (owner, 2026-11-14)

| # | Decision |
|---|---|
| O1 | The number starts at 30%; the pass line is 85%. |
| O2 | "Coach" already names the build-workspace agent. The learner-facing name of the new worker stays "Coach"; its code identifier is `mentor` (kind, files, events, marker types, prompt directory). |
| O3 | A "Start" button under the plan accepts it. Typing instead sends the text to the planner as a change request. |
| O4 | The new design applies to new sessions. Existing sessions stay readable and are not continued. |
| O5 | Work happens on branch `feat/coach-planner`, created from the current tree. No commits until the owner asks. |
| O6 | When unsure, the planner verifies against Wikipedia and official documentation only, through the existing `research` job with that restriction stated in its question. The coach has no web access (it is a single awaited call). |

Drafts of the four roles' instructions: [2026-11-14-coach-planner-prompts.md](2026-11-14-coach-planner-prompts.md). Their wording needs owner approval before it is installed.

## 4. Architecture

```
learner
  │ goal, answers
  ▼
PROBER ──probe_done──► PLANNER ──plan accepted──► TEACHER (fresh per node)
  ▲                       ▲                          ▲
  │ card                  │ learner picture          │ handoff + card
  └───────────────────────┴──────────────────────────┘
                     COACH (background, awaited)
                       │ proposes
                       ▼
                  APP RULES (deterministic)
        evidence ledger · number per fact · node passed ·
        planner wake · templates
```

### 4.1 Agent kinds and selection

- `AgentKind` gains `planner`. Selection becomes a pure, record-derived function `agentKindFor(record)` beside `hasProbeDone` in `src/core/native-messages.ts`, replacing the ternary leaf at `src/server/chat-handler.ts:754-822`:
  - `prober` until a concluded `probe_done`;
  - `planner` while no plan has been accepted, or while an unanswered planner-wake marker is the latest boundary;
  - `teacher` otherwise.
- The test seam keeps `teaching: boolean` and gains `kind`.
- Every site that enumerates kinds needs a `planner` decision: `teacher-agent.ts:58,102-107,213,233`; `narration-guard.ts:24`; `tools/send-to-user.ts:21`; `core/plugins.ts:116` and `server/plugin-host.ts:101,461` (planner takes no plugin contributions); `config.ts` `ModelRole`; `core/prompt-segments.ts:23,47`; `agent/prompt-segments.ts:81,94,137`; `app/api/settings/prompts/route.ts`; `components/settings/agent-section.tsx:108,260`; `next.config.ts:73-95`; `chat-handler.ts:371,978` (token estimate should follow the selected kind).

### 4.2 Plan data

Extend `src/core/contracts/plan.ts` with optional fields so old records still parse:

```ts
PlanFact  { id: string /* session slug, e.g. "f7" */; graphId: string /* n_… */; statement: string }
PlanNode  { id; title; summary?; facts?: PlanFact[]; origin?: "planner" | "coach"; batch?: number }
PlanTree  { nodes; edges; arrows?: { premises: string[]; conclusion: string }[]; version }
```

- New planner tool `plan_batch` (structured JSON, not mermaid; name keeps the `tool-plan_` prefix that `latestTree`, `planNodeCount` and `view.ts` match). Input: up to 4 nodes `{id, title, requires[], facts[{id, statement, existing?}]}` plus `arrows[{premises[], conclusion}]`. Required fields lead; the description carries an example call; validation errors name the culprit (existing safeguards in `plan-tree.ts`, `question-core.ts`, `argument-heal.ts`). Nested stringified arrays need a `prepareArguments` shim like `healStringifiedArrays`.
- Append semantics: the tool merges into the stored tree server-side, node ids stable. Every result's `details.tree` carries the full merged tree, because the UI reads the tree from the latest plan tool result.
- `plan_init` leaves the teacher registry. Exact-name sites to update: `pending.ts:171`, `plugin-renderers.tsx:19,114`, `CONVERSATION_TOOL_NAMES`, `plan-blocks.ts:87`, `view.ts:130-138`, golden fixture tool inventory.
- Coach-added nodes: the app applies them to `record.tree` and appends a transcript marker carrying the full tree, so the client sees the change.

### 4.3 Facts in the graph, evidence ledger, the number

- Facts are graph propositions; arrows are graph chains. New core function `writePlannedFacts(chatId, facts, arrows, deps)` beside `mergeFindings` (`src/core/graph.ts:149`): chat-level provenance `{chatId, messageId: ""}`, returns the local→`n_…` mapping, does not run whole-ledger `simplifyChains`, calls `settleGraphLayout`.
- Identity across sessions: before writing, candidate search (`createPropositionCandidateSearch`, `tools/graph.ts`) offers existing propositions to the planner and coach; a fact with `existing` links to that node instead of minting a new one. Without this, D15 does not hold.
- New ledger `data/graph/evidence.jsonl`, append-only events:

```ts
EvidenceEvent { nodeId; chatId; messageId; at;
                source: "probe" | "quiz" | "code" | "recall" | "practice";
                correct: boolean; dontKnow?: boolean;
                guess: number /* chance of a right answer without knowing */;
                confidence?: number /* 0–100 */ }
```

  Additive file, no format bump. Touch: `config.ts` `LEDGER_FILES`, `contracts/graph.ts`, `ports.ts`, `store/graph.ts`, `graph-deletion.ts` (purge dead node rows), `core/graph.ts` `graphSnapshot` (side map `knowledge`), `server/graph.ts` `graphRevision`.
- The number is a pure fold over a fact's events (never stored), Bayesian knowledge tracing with fixed parameters:
  - prior `p0` (O1), slip `s = 0.10`;
  - guess `g`: `1/n` for single-select multiple choice with `n` options, `0.05` for typed code that passed tests, `0.10` for a free-text answer judged by the coach;
  - right answer: `p' = p(1−s) / (p(1−s) + (1−p)g)`; wrong or "I don't know": `p' = p·s / (p·s + (1−p)(1−g))`;
  - a wrong answer given with confidence ≥ 90 also raises a misconception flag for the coach card.
  - Check: 0.30 → 0.54 → 0.76 → 0.89 on three right 3-option answers; 0.30 → 0.89 on one passed code question.
- Node passed ⇔ every fact of the node ≥ pass line (O1). Computed by the app.
- Evidence is stamped server-side in the `"answer"` case of `inputAppends` (`src/core/input-events.ts:312-318`), re-deriving `correct` from the committed answer instead of trusting the client. Coding-question pass/fail is read at `chat-handler.ts:513-531`.

### 4.4 Questions carry facts

- `quiz`, `explain`, `probe`, `recall` gain `facts: string[]` (min 1), placed after `type`/`nodeId`, validated by `factsProblem` beside `nodeIdProblem` (`tools.ts:355-367`): ids must be facts of the tagged node (teacher) or of the probe fact list (prober). A bare string is wrapped into an array.
- Plugin teach questions (`coding_question`): `facts` is optional in `buildParameters` (historical snapshots are re-validated against the current schema, `plugin-questions.ts:433-461`) and enforced in the ledger `execute`.
- Free-text answers have no app verdict. The coach returns `{factId, correct}` for them; the app turns that into evidence with `g = 0.10`.

### 4.5 The coach

- One awaited LLM call per learner answer, session engine (`resolveConversationSpec`), structured submit tool (`runSubmitAgent` pattern, `src/agent/subagents/submit-agent.ts`), bypassing the shared worker pool as compaction does.
- Runs inside the answer POST under `claimPreparingTurn` (`src/server/turn-preparation.ts`), after the write-ahead save, before the agent is built. Not on `steers`, `continue`, retries, or while the parallel-question gate is deferring. Injectable for tests.
- Input (built by the app): goal; probe assessment when it exists; the plan with numbers; road record of past nodes; the current node's conversation in full; the latest answer.
- Output (validated):

```ts
CoachResult {
  judged?:   { factId: string; correct: boolean }[];      // free-text answers only
  addFacts?: { nodeId: string; id: string; statement: string; existing?: string }[];
  addArrows?: { premises: string[]; conclusion: string }[];
  addNodes?: { id: string; title: string; before: string; facts: […] }[];   // origin "coach"
  askLearner?: string;      // relayed by the prober or teacher
  notes: string[];          // ≤ 3 short lines for the next turn
}
```

- The app then: writes evidence, recomputes numbers, decides passed, applies additions to the plan and graph, builds the card marker, and if the node passed appends the next handoff marker.
- Probe mode: same call; before any plan exists the coach's `addFacts` form the probe fact list (the hidden prerequisites of the goal) that the prober's questions must tag.
- Failure or abort: one retry, then the turn proceeds without a card (the answer is already saved and app-computed evidence is already written).
- Events: `coach-changed {chatId, running}` modelled on `compaction-changed` (`core/events.ts:35`, GET route snapshot flags, `chat.tsx:1556-1563`, indicator beside `PendingTurnIndicator` at `chat.tsx:2040-2048`).
- Usage recorded with `appendTurnUsage`, as compaction does.

### 4.6 Fresh context and handoff templates

- New marker `node-handoff`, compaction-shaped: appended at the tail, `details.firstKeptMessageId`, content = the filled template. A teacher-only `convertToLlm` wrapper around `toLlmMessages` (`native-messages.ts:656-750`) renders from that boundary with the marker as head. Prober and planner keep the unfiltered converter.
- The boundary never splits a tool call from its result: the app appends the handoff after the answer result that completed the node, so the next teacher turn starts clean.
- New marker `coach-card` (hidden from the learner, user-role to the model), and `planner-wake`.
- Each new marker joins the `LhMarkerMessage` union (`native-messages.ts:75-90`) and `nativeInputCause` (`:988-995`, neutral), with model text single-sourced in `core/contracts`, opening with a bracket tag per the preamble law.
- Boundary-aware accounting: `lastAssistantUsageIndex`, `compactionCutIndex`, `cliContextWindowOf` treat `node-handoff` as a boundary; a compaction head older than the boundary is dropped.
- Templates (fixed text, filled by the app):
  - START: first node; map with position; this node's facts with numbers; arrows into them; learner picture (facts this node stands on with numbers; misconception flags).
  - CONTINUE: same, plus the road record (one line per past node: title, passed, facts that needed more than one attempt) and the last coach card.
  - Fact and arrow lines reuse the `graph-context` layout (`newGraphContextMessage`, `formatChainLine`).
- Plan acceptance (O3) is a foreground learner input; the app appends the START handoff write-ahead in that request, the way build cargo is appended (`chat-handler.ts:588-595`).

### 4.7 Planner wake

- After a node passes, if at most 1 unpassed node remains in the batch, the app appends `planner-wake`; the next turn builds the planner, which calls `plan_batch`. The teacher's next handoff follows. The learner sees "Planning next steps…" through the same indicator.
- The planner's context: goal, probe assessment, the plan with numbers, road record, coach notes. Not the lesson conversation.

### 4.8 Instructions

- New directory `src/agent/prompts/planner/`. Prober and teacher directories rewritten. Teacher and planner get shared-fragment allowlists (`agent/prompt-segments.ts:94`).
- Objectives:
  - prober: find exactly what the learner holds and does not hold, on the facts given;
  - planner: draw the shortest road from what he holds to the goal, as nodes with facts and arrows;
  - coach: watch the learner — judge, find what is missing, correct the road;
  - teacher: make him prove the current node's facts, by building understanding one small step at a time.
- Teacher rules carry the session fixes: one new idea per turn; every term defined before use; code in the same card as the question, question sentence first; options are bare claims; move from choosing to predicting to typing code; after two "I don't know" on the same fact stop quizzing and ask what blocks.
- Prompt wording is written by the main session and shown to the owner, not delegated.
- `HANDOFF_TEXT` (`contracts/chat.ts:267`) is reworded for the planner. `shared/40-formatting.md` loses "use it maximally".
- Tests to update: `prompt-overrides.test.ts:163-210,~247`.

### 4.9 Extraction and coverage

- Remove the teach case at `chat-handler.ts:914-924`. Hide `CoverageRing` (`chat.tsx:1752`) and the coverage menu block for teach sessions.

### 4.10 UI

- Indicator: one line, spinner, "Coach is reviewing…" / "Planning next steps…".
- Plan map (`components/plan-block.tsx`): passed state and per-node progress in `BOX`/`TEXT` and the node group; dashed outline for `origin: "coach"`; "Start" button under a newly presented plan.
- Knowledge graph: number column in `chain-table.tsx:557-558` and a line in the node card (`graph-view.tsx:1579-1592`).
- Coding questions enabled through `data/plugins-state.json` (Settings → Core plugins).

## 5. Test and environment notes

- Tests do not run under WSL node (Windows esbuild binary). Run through `cmd.exe /c "set NODE_ENV=test&& node_modules\.bin\tsx.cmd --test <files>"`.
- Baseline before any change: the sampled suites pass except `build-branch.test.ts` "confines paths, including through symlinks" (Windows symlink permission, unrelated).
- `git status` shows ~1270 modified files from line endings; the real diff is 5 files. Builders must not normalise line endings or stage unrelated files.
- AGENTS.md: read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code.

## 6. Work packages

Sequential where they share `chat-handler.ts`; each ends with typecheck and the affected tests green.

1. Core data: plan contract extensions, evidence ledger, the fold and pass rule, `writePlannedFacts`. Pure code and tests.
2. Planner kind: `agentKindFor`, registry, `plan_batch`, prompt loader and Settings surfaces, extraction off.
3. Fresh context: markers, teacher converter, templates, boundary-aware accounting, plan acceptance input.
4. Questions: `facts` field and validation, server-side evidence stamping, coding-question facts and pass/fail.
5. Coach: worker, answer-POST integration, events, application of its output, planner wake.
6. UI: indicator, plan map states, Start button, graph number.
7. Instructions: prober, planner, teacher, coach (main session).
8. Docs: `docs/architecture.md`, `src/agent/prompts/README.md`, plugin question contract.

## 7. As built — differences from this design

Read from the code on the branch. UI work (§4.10) is not covered here.

Plan and planner:

- `plan_batch` replaces the whole stored plan on every call until the learner accepts it (no `node-handoff` yet), removing the replaced plan's newly minted facts that carry no evidence from the graph; only after acceptance does it append. §4.2 describes append semantics throughout.
- `plan_batch` facts also carry a required `name` (the graph label); a node holds 1–8 facts by schema (the planner prompt asks for 2–5).
- The planner is woken when, after the current node passes, at most one node of the whole tree is unpassed, or no unpassed node has all its prerequisites passed (§4.7 counts the batch). After it appends the next stretch, the learner accepts it with another `plan-accept`; the next handoff is not appended automatically.
- The planner's context starts at a `planner-wake` that is later than the latest `node-handoff`; its first planning and revisions before acceptance read the full record (§4.6 says the planner keeps the unfiltered converter).
- Candidate search (§4.3) is offered to the coach only, as up to 12 lexically related propositions from other sessions. The planner gets no candidate list; graph ids reach it only in the planner brief at a wake.
- A plan fact that reuses a probe fact's id and names no `existing` links to that probe fact's graph node (unless the node is gone), so the probe's evidence carries over to the plan.

Fresh context:

- The teacher's boundary is the `node-handoff` marker itself; `details.firstKeptMessageId` exists but is always `null` and unused.
- Teacher fragments are `10-job.md`, `20-turn.md`, `30-questions.md`, `35-stuck.md` (the prompt draft names `40-stuck.md`), plus the existing `40-jobs.md`, `50-demos.md`, `55-images.md`.
- The prober and teacher still compose every shared fragment; only the planner received an allowlist (§4.8). The coach composes `mentor/` alone, with no base and no shared fragments.

Questions and evidence:

- `probe`/`recall` keep `facts` optional in the schema; validation requires it only once the session has a probe fact list (§4.4 says min 1). `quiz`/`explain` require it by schema.
- Evidence is stamped in the chat handler after the write-ahead save (`afterAnswer`), not in `inputAppends`; deferred sibling answers are stamped too. Stamping is idempotent per (chat, message, node).
- Multi-select multiple choice uses guess 1/(2ⁿ−1); every multiple-choice guess is clamped to 0.01–0.5. Failed code also uses guess 0.05.
- A node passes only if it has at least one fact. The misconception flag reflects only the fact's latest answer.
- The `practice` evidence source exists in the type and validator, but nothing writes it.
- Deleting a proposition removes its evidence rows. Deleting sessions with their graph contributions removes rows of nodes that die and keeps rows about surviving nodes, including rows written by the deleted sessions.

The coach:

- The coach always produces a `coach-card`, even when the review is empty, failed, or (in tests without an injected runner) never ran; the card then carries the app's numbers only. §4.5 says a failed review proceeds without a card.
- A run is retried once when it never submits or throws; within a run, validation problems return to the model for up to three model calls.
- An aborted review ends the answer request without markers or an agent turn; the answer and its evidence stay saved.
- `addNodes` has no `before` field: nodes are always inserted before the current node, as its prerequisites, with 1–5 facts each. When the coach inserts nodes, the app hands off to the next node to teach (normally the first inserted one) instead of applying the advance rule.
- The coach's conversation input is capped at the most recent 12,000 characters.
- The event is `mentor-changed` (not `coach-changed`), and chat GET/list payloads carry a `coaching` flag.
- Usage is recorded per model call against the card's message id.

Graph and extraction:

- `writePlannedFacts` does not settle the layout; its callers (`plan_batch`, the coach step) run `settleGraphLayout` afterwards.
- Automatic extraction after a turn was removed for every chat session kind, not only the teach case (`triggerExtraction` is no longer called). Imports and the manual extract route still run the pipeline.
