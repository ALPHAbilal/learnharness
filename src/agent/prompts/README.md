# Prompt composition

The runtime composes prompts for five conversation agents (**prober**, **planner**, **teacher**, **practice**, **build** coach) and for the **coach** (code name `mentor`), which reviews learner answers and never speaks to the learner. The source of truth is [`listSourceSegments` / `effectivePromptSegments`](../prompt-segments.ts); [`composeInstructions`](../teacher-agent.ts) (conversation agents) and [`mentorInstructions`](../subagents/mentor.ts) (the coach) select effective text, trim each segment, drop empty segments and join them with `\n\n---\n\n`. Non-fragment documentation such as this README never enters the prompt.

## Composition order

| Agent | Segments, in order |
|---|---|
| Prober | [`system-prompt.md`](../system-prompt.md) → `prober/10-probe.md` → every sorted `shared/` fragment |
| Planner | `system-prompt.md` → `planner/10-plan.md` → shared `10-voice.md`, `15-accuracy.md`, `30-learner-files.md` |
| Teacher | `system-prompt.md` → `teacher/10-job.md`, `20-turn.md`, `30-questions.md`, `35-stuck.md`, `40-jobs.md`, `50-demos.md`, `55-images.md` → every sorted `shared/` fragment |
| Practice | `practice/00-base.md`, `10-doctrine.md` → shared `10-voice.md`, `15-accuracy.md`, `16-mental-model.md`, `35-side-conversations.md`, `40-formatting.md`; **no teaching base** |
| Build coach | `build/00-base.md`, `10-doctrine.md` → shared `10-voice.md`, `15-accuracy.md`, `35-side-conversations.md`, `40-formatting.md`; **no teaching base** |
| Coach (`mentor`) | `mentor/00-base.md` only; **no base and no shared fragments** |
| Side questions | [`side-chat/00-base.md`](side-chat/00-base.md) → shared `10-voice.md`, `15-accuracy.md`, `40-formatting.md` → final side-only [`90-style.md`](side-chat/90-style.md); composed by [`src/agent/side-chat.ts`](../side-chat.ts), not by the segment loader |

Directory discovery accepts only filenames matching `^\d+-[\w.-]+\.md$` and sorts them lexicographically by filename; the filenames above are the current source. Keep numeric prefixes consistently padded when order matters. The teaching base supplies the purpose/philosophy for the prober, planner and teacher; voice, accuracy, mental-model, question, confidence, file, side-conversation and formatting guidance are separate shared fragments. Probing doctrine lives in `prober/`, planning doctrine in `planner/`, the teacher's job, turn shape, question ladder and stuck rules in `teacher/`, and the coach's review doctrine in `mentor/`.

The side-question base is not an editable segment (it is not listed in Settings); its shared appendix honors enabled overrides by the same keys the other agents use.

The loader's shared-fragment rule: the prober and teacher have no allowlist and compose **every** `shared/` fragment; the planner, practice, build coach and coach compose only their allowlists in [`prompt-segments.ts`](../prompt-segments.ts) (the coach's is empty), in sorted order. Adding a shared fragment therefore reaches the prober and teacher only, unless an allowlist changes.

## Overrides and defaults

Source files are the default instructions. User override files mirror segment keys under [`PROMPTS_OVERRIDE_DIR`](../../../config.ts), normally `data/prompts/` (relocated by `LH_DATA_DIR`):

```text
system-prompt.md
prober/<fragment>.md
planner/<fragment>.md
teacher/<fragment>.md
practice/<fragment>.md
build/<fragment>.md
mentor/<fragment>.md
shared/<fragment>.md
```

An override is effective only when **both** its `settings.json` → `agent.prompts[segmentPath]` switch is `true` **and** its file can be read. Absent/off switches and missing/unreadable files use source text. File presence alone does not enable anything. An enabled empty override contributes no text after trimming; it does not fall back to source.

The normal turn handler passes the resolved switch map, so composition reads source/override text fresh for each newly constructed agent. Calls that omit `promptSwitches` use the source-only compositions cached at module initialization. The coach's instructions compose for each review from the same switch map. Editing a file does not rewrite an already-running agent's instructions. There are no factory-enabled overrides.

The available segment list always comes from current source discovery. An override for a removed source segment stops composing but is not automatically deleted from disk. Shared segments use the same key across all agents that include them. Path grammar is defined in [`src/core/prompt-segments.ts`](../../core/prompt-segments.ts); override CRUD lives in [`src/store/prompt-overrides.ts`](../../store/prompt-overrides.ts), exposed by the settings prompt routes/UI. The agent-side reader is separate so agents do not import store adapters.

## Phases and tool contracts

- Teaching sessions select an agent each turn from the record ([`agentKindFor`](../../core/native-messages.ts)): the prober until a successful `probe_done` call **and matching result** (a bare/refused call does not count); the teacher once the learner has accepted the plan (a `node-handoff` marker) and no later `planner-wake` exists; the planner otherwise. The teacher's model context starts at the latest `node-handoff`, the planner's at a `planner-wake` when that is the latest boundary; the prober reads the whole record.
- App-written context reaches the agents as user-role messages that open with a bracket tag: `[Node handoff]` (teacher), `[Planner brief]` (planner, after a wake), `[Coach card]` (prober and teacher, after a reviewed answer). Their text is fixed in [`contracts/handoff.ts`](../../core/contracts/handoff.ts); fragments describe them but do not define them.
- Practice sessions use the practice prompt from turn one. `problem` commits a solution before posing; `conclude` reveals it. The doctrine requires a pause after conclusion until the learner explicitly moves on. This is a conversational agent, not the retired problem-set generation/grading pipeline.
- Prompt instructions are not a substitute for structural validation. For example, the app's pass rule, not the teacher, finishes a node; `plan_batch`'s schema enforces at most four nodes and one to eight facts per node, while the planner prompt's two to five facts per node is doctrine; the conclude pause is doctrine rather than a terminating execute result. Read the actual registry and schemas before describing a behavior as enforced.

Tools each prompt may name (see [`src/agent/tools.ts`](../tools.ts) and [`src/agent/subagents/mentor.ts`](../subagents/mentor.ts)):

| Prompt | Tools |
|---|---|
| Prober | `probe` (`recall` under free recall), `ask_user_question`, `probe_done` |
| Planner | `plan_batch`, `research` |
| Teacher | `quiz` (`explain` under free recall), `ask_user_question`, `coding_question` when the Coding questions plugin is enabled, the job tools (`research`, `pdf`, `demo`, `visual`), `show_image` |
| Coach (`mentor`) | `review`, its only tool |

All three teaching agents also have the read-only file tools; the prober also has research/PDF dispatch and, behind the graph switches, the graph readers. `plan_init` is in no registry any more; its name stays reserved against plugin tools.

See [architecture](../../../docs/architecture.md#teaching-and-practice) for runtime phases, registry differences and pause mechanics; [teaching methodology](../../../docs/teaching-methodology.md) for the method. Background workers and extraction have their own instructions in their implementation modules; this loader is not a catalog of every prompt in the application.

## Editing fragments

- Put agent-specific doctrine in that agent's directory. Use `shared/` only for guidance appropriate to every agent that composes it; check the allowlists.
- Match tool names and input fields to the actual schemas in `src/agent/tools.ts` and `src/agent/tools/`. Agents share one record, not identical toolsets or context: prober `probe`/`recall` and teacher `quiz`/`explain` deliberately differ. Do not imply a tool is available merely because another phase uses it.
- Keep always-in-context text concise. Avoid duplicating the base, other fragments, tool schemas or runtime reference documentation.
- Verify composition/override behavior against `tests/prompt-overrides.test.ts` and the agent-flow tests when changing loader behavior. Prompt assets must remain included in standalone packaging (the tracing includes in `next.config.ts` and the sanity list in `scripts/build-server.mjs`).
