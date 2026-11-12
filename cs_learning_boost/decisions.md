# Two-Agent Learning Loop: decisions so far

Status: design in progress (2026-11-12). Builds on `imagination.md` in this folder.
Nothing is implemented yet. When all open questions are answered, these decisions
become a design spec (like `docs/superpowers/specs/2026-11-11-cs-learning-workspace-design.md`)
for approval, then implementation.

## Agreed decisions

1. **Placement.** A new, 4th session kind, next to Teaching, Practice and Infinite.
   Those three stay exactly as they are.
2. **Scope.** Computer science and programming only.
3. **Tasks.** Every task is code written in VS Code, in the chat's folder, and run
   by the agent. This includes the Phase 1 scan (step 2): the scan is small code
   tasks, not chat questions.
4. **Authority.** The Shadow *advises*; the Tutor has the final say. Every
   disagreement is logged.
5. **Timing.** The Shadow runs in the background. The Tutor waits for it only where
   it needs the Shadow's work:
   - step 3 (show the map): waits for the Shadow's map
   - step 6 (explain the gap): waits for the Shadow's root cause (see the disagreement zone)
   - step 7 (act on verdict): waits for the Shadow's advice
   - step 9 (re-test): no wait; the schedule was computed earlier
6. **The Shadow is split into app code and a small AI judge.** Bookkeeping is plain
   code (no AI): exact, instant, free. Judgment is the small AI.

   | # | Step | Job | Done by |
   |---|---|---|---|
   | 1 | 1 | Open session: topic, scope, empty map | app code |
   | 2 | 2 | Score each part: solid / shaky / missing | Shadow (AI) |
   | 3 | 3 | Build the map: order gaps by dependency | Shadow (AI) |
   | 4 | 4 | Counters: attempts, time, hints | app code |
   | 5 | 5 | Tag root cause; add new gap to map | Shadow (AI) |
   | 6a | 6 | Log hint size | app code |
   | 6b | 6 | Judge depth of "why" | Shadow (AI) |
   | 7 | 7 | Advise repeat / next / review | Shadow (AI), Tutor decides |
   | 8 | 8 | Transfer score: understood or memorised | Shadow (AI) |
   | 9 | 9 | Re-test schedule; fail puts the gap back on the map | app code |
   | 10 | all | Update KPIs every attempt | app code |

   The Tutor only talks and teaches. It never counts or scores.

## The disagreement zone (step 6)

At step 6 both agents diagnose why the learner broke. If they disagree, the
disagreement is shown, because the learner learns from seeing it.

```
┌─ DISAGREEMENT ZONE ──────────────────────────────────────────┐
│ ⚠ Tutor and Shadow disagree on why this broke                │
│                                                              │
│ [TUTOR]   I think you broke because ...                      │
│ [SHADOW]  No, I think the root cause is ...                  │
│ [TUTOR]   But line 12 shows ...                              │
│ [SHADOW]  🚩 needs your input: "What did you expect          │
│            `x` to hold after the loop?"                      │
│ ┌──────────────────────────────────────────────────────┐     │
│ │ your answer → seen by SHADOW only                    │     │
│ └──────────────────────────────────────────────────────┘     │
│ [SHADOW]  That confirms my view, because ...                 │
│ [TUTOR]   Agreed, then ...                                   │
│                                              [ Stop ]        │
│ ┌──────────────────────────────────────────────────────┐     │
│ │ your final word                                      │     │
│ └──────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

Rules:
1. Both agents speak directly, each with its own label (Tutor / Shadow). This
   zone is the one place the Shadow talks where the learner can see it.
2. They debate in rounds. The learner watches; the input is locked.
3. Either agent, or both, can raise a 🚩 flag asking the learner for input on
   something specific.
4. A flag unlocks the learner's input. The answer is seen only by the agent(s)
   that raised the flag, even though it is all one conversation.
5. After the answer, the debate continues.
6. At the end of the loop, the learner gets a final word.
7. The loop ends when they agree. There is no round cap.
8. A **Stop** button lets the learner end the debate at any time. Then the
   Tutor's diagnosis wins (the Tutor has the final say).

## Open questions (not decided yet)

From the disagreement zone:
- Rule 6: what does the learner's final word do? (Changes the diagnosis? Only
  logged? Read by both agents?)
- Rule 4: can the agent that saw a private answer quote or paraphrase it to the
  other agent in the debate?
- Does the zone also apply to step 7 (Tutor rejects the Shadow's advice), or only
  to step 6?
- When they agree right away, is the zone shown at all?

From the main loop:
1. Step 5 "stay quiet, let you struggle": how long before the Tutor steps in?
   (Until the learner asks? After N failed runs? After some time?)
2. Can the learner force teaching ("teach me now")?
3. What counts as **passed** for a gap?
4. Phase 1 scan: maximum number of tasks before it gets tiring?
5. What the learner sees: the map with `[x]` marks; the KPIs too?
6. Step 9 re-test days later: what triggers it, and is it tied to the chat or
   the topic?
7. Which model the Shadow uses: the Cheap slot or the Strong slot.
8. Does it feed the knowledge graph?
9. The name of the new session kind.

## Notes from the code (for the spec)

- Today's Teaching session already does steps 1 to 3 in part: the prober measures,
  then `plan_init` shows a live dependency map (`src/agent/prompts/teacher/10-planning.md`).
- Today's map deliberately never marks a node finished ("a tag is a position, not
  a verdict"). This loop needs `[x]` verdicts, so it needs its own map behaviour.
- Today's teacher is explain-first (`src/agent/prompts/teacher/05-method.md`). This
  loop is task-first; that's one reason it's a separate session kind.
- Background agents already exist (`src/agent/subagents/`: extractor, auditor),
  so a background Shadow follows an existing pattern.
- Infinite's `conclude` tool already records `rung`, `missClass`, `retest`, but the
  Tutor fills them in itself. In this loop that bookkeeping moves to app code and
  the Shadow.
- Workspace folder, `run_command` and `write_file` come from the 2026-11-11 workspace
  work and are reused for VS Code tasks.
- README promise: the knowledge graph stores "ideas and their connections, not
  ratings of your ability". The Shadow's scores are a new kind of data; where they
  live is open question 8.
