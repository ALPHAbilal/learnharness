# CS specialization of the original design: decisions

Started 2026-11-12. Replaces the shelved multi-agent design in `decisions.md`.

## Principle

Keep the agent layer simple. No new agents. Specialize the **original** design,
Teaching (prober → teacher) and Practice, for computer science and programming,
mostly through prompt and configuration tweaks.

Infinite sessions, build courses (`teacher/60-build-courses.md`) and per-chat
workspaces (commit `8bbcec5`) are the owner's experiments, not the reference design.

## Agreed

1. **Scope:** computer science and programming only.
2. **Where code is written:** in VS Code, in the chat's workspace folder (the
   workspace experiment stays). The in-app Coding questions plugin editor is not
   the path for this.
3. **Teacher + code:** build courses are always on. Every Teaching session is a
   project built in stages (why → build → run → one "why" question), using
   `teacher/60-build-courses.md`, no longer conditional on the goal being CS.
4. **Prober:** quiz/explain questions find the edge first (original method), then
   ONE small code task in VS Code checks that the learner can write what they can
   read. The prober gets the workspace tools (`run_command`, `write_file`).
5. **Practice:** every problem is solved in VS Code. The statement names a file in
   the chat's folder; the learner writes it, says done, the agent runs it. The
   thinking field is only for questions and hint requests.
6. **Prompt rewrite depth: medium.** Add CS/programming framing to the base
   prompts (teaching and practice), swap non-CS examples in the method, teaching
   and practice text for CS ones, and replace practice's LaTeX rules with
   code-block rules.
7. **Non-CS topics:** the agent declines politely, says the harness is for CS and
   programming only, and offers a CS angle when one exists (e.g. French grammar →
   "build a French verb conjugator").
8. **Infinite:** left untouched this round.
9. **UI text:** left untouched this round (no UI changes; prompts and tool wiring only).
10. **LaTeX:** edit the shared rules to "code in code blocks first; LaTeX only for
    real math (complexity, discrete math)". Infinite gets this formatting change
    too, since it reads `shared/40-formatting.md`.

## Findings from studying the original design

- Prober measures with quick quiz/explain questions (no code), binary-searching
  each strand for a floor and a ceiling. Teacher plans a live map and teaches with
  the first-principles method (`teacher/05-method.md`) in predict → teach → check.
- Practice trains production from a cold start ("knowing a proposition and having
  it come to mind are different states"): recall, discrimination, composition;
  hint ladder R0 to R5; retests every miss on a fresh surface before the end.
- The learner profile seen in `sim/`: reads code, can't yet write it by hand.
  That is Practice's core target.
- The core plugin Coding questions (in-app editor plus auto-run tests) exists but
  is off by default. Not used here (decision 2).

## Gaps (tweak candidates)

- G1: core prompts are subject-general (math and networking examples, LaTeX rules
  in practice).
- G2: code is optional for the teacher and practice agents.
- G3: the prober can't test writing code (no workspace tools, by the experiment's
  design).
- G4: Practice has the workspace tools but its prompts never say how to use them.

## Implementation plan (awaiting owner approval)

Prompt changes:

| # | File | Change |
|---|---|---|
| P1 | `src/agent/system-prompt.md` (prober + teacher base) | Add: this harness teaches computer science and programming only. Non-CS request → decline politely, offer a CS angle if one exists. |
| P2 | `teacher/60-build-courses.md` | Make it unconditional: drop "When the goal is a programming or CS one"; every lesson is a build course. Keep the no-folder fallback for old chats. |
| P3 | `prober/10-probe-doctrine.md` | Swap the "LLMs" goal example for a CS-build one. New step before `probe_done`: one small code task in VS Code (a file in the chat's folder), sized at the edge just found; the learner writes it, says done; the prober runs it with `run_command`; the result (can / can't write what they read) goes into `probe_done`'s strand entries. |
| P4 | `teacher/05-method.md` | Swap the math examples ("why try this formula? why manipulate the equation?") for CS ones (why this data structure? why this loop shape?). Keep the 3Blue1Brown reference: it names the explaining style, not a subject. |
| P5 | `practice/00-base.md` | CS framing and the non-CS decline. Replace the LaTeX statement rule with code blocks first. New "Working in VS Code" mechanics: every `problem` statement names a file in the chat's folder and the command that checks it; the learner writes it and says done; the files are the truth (read and run before any verdict or hint); the thinking field carries only questions and hint requests; the model solution is verified privately and never written where the learner can open it. |
| P6 | `practice/10-doctrine.md` | Swap the math hint examples (e.g. R1 "a sum of many small things") for CS ones. Claimed answers are verified by running, not only by reading. |
| P7 | `shared/40-formatting.md`, `shared/20-question-tools.md` | Code in code blocks first; LaTeX only for real math (complexity, discrete math). |

Code changes:

| # | File | Change |
|---|---|---|
| C1 | `src/agent/teacher-agent.ts:229` | Stop excluding the prober from workspace tools (`run_command`, `write_file`, folder block). |
| C2 | `tests/infinite-agent.test.ts:95-104` | Update "the prober never does" to the prober now getting them. |
| C3 | `docs/architecture.md:90` | Update the line that says the prober does not get the workspace tools. |

Not changed: Infinite prompts, UI, the Coding questions plugin, the knowledge
graph, the agent structure.

Checks after implementing: `npm test`, `npm run typecheck`, `npm run lint`.
