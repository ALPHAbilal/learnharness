# Agentic design patterns

A catalogue of design patterns for building an agent layer, taken from how `pstack` (the `cursor/plugins` repository, folder `pstack/`) is put together. pstack is a toolkit for coding agents, but the patterns below are stated in general terms so they can be applied to any agent system: a tutor, a support agent, a research agent, a data pipeline.

Each pattern says what it is, when to use it, how to build it in any stack, and where it stops working. The last column of the summary table points to the pstack file that shows it.

## How to read this

An agent layer has five places where a design decision can live. Every pattern below belongs to one of them.

```
   1 ENTRY        how a request becomes a defined job
   2 CONTROL      who decides what happens next
   3 WORKERS      how work is split, isolated and handed over
   4 PROOF        what counts as done, and who checks
   5 LEARNING     how the system gets better after each run
```

## Summary

| # | Pattern | Layer | One line | pstack source |
|---|---|---|---|---|
| 1 | Router and playbooks | Entry | One entry point picks a fixed, numbered procedure for the task type | `skills/poteto-mode/SKILL.md`, `playbooks/` |
| 2 | Restate the goal first | Entry | The agent says the goal back in its own words before acting | `skills/in-your-own-words`, `poteto-mode` non-negotiables |
| 3 | Sharpen the request | Entry | Rewrite a vague ask into a deeper one before running it | `skills/sharpen` |
| 4 | Steps copied verbatim | Control | The procedure's steps go into the task list word for word | `poteto-mode` "Playbooks" |
| 5 | Small rules, loaded on demand | Control | Many tiny rule files, each read only when its trigger fires | `skills/principle-*` |
| 6 | Trigger then action | Control | Every rule is written as "when X, do Y" | `poteto-mode` non-negotiables |
| 7 | Design a procedure when none fits | Control | For novel work, the first deliverable is the workflow itself | `skills/figure-it-out` |
| 8 | Exit condition as a predicate | Control | "Done" is a check that can pass or fail, fixed before starting | `playbooks/autonomous-run.md`, `hillclimb.md` |
| 9 | Reversible or not | Control | Proceed on reversible work; stop only for irreversible actions | `skills/principle-never-block-on-the-human` |
| 10 | Experiment instead of asking | Control | If a question can be settled by running something, run it | `playbooks/prototype.md` |
| 11 | Fresh worker, consolidated brief | Workers | New work goes to a new worker with everything it needs in one brief | `poteto-mode` "Subagents" |
| 12 | Guard the context window | Workers | Bulk goes to workers; only summaries return to the lead | `skills/principle-guard-the-context-window` |
| 13 | Separate before serializing | Workers | Give each worker its own write target instead of locking a shared one | `skills/principle-separate-before-serializing-shared-state` |
| 14 | One owner per unit | Workers | Exactly one writer per artifact, from start to finish | `playbooks/orchestrate.md` |
| 15 | Model per role | Workers | Each role names its model and effort; the choice is configuration | `skills/setup-pstack` |
| 16 | Start with one unit | Workers | Take one unit through the whole pipeline before fanning out | `playbooks/orchestrate.md` |
| 17 | Fan out and aggregate | Workers | Partition or race N workers, then return one report | `skills/swarm` |
| 18 | Compete, pick a base, graft | Workers | Several candidates for one hard artifact; best parts merged into one | `skills/arena`, `skills/architect` |
| 19 | Prove it on the real thing | Proof | Check the actual artifact, never a proxy or a self-report | `skills/principle-prove-it-works` |
| 20 | Verifier is not the author | Proof | A different agent, ideally a different model family, gives the verdict | `playbooks/orchestrate.md`, `shipping.md` |
| 21 | Adversarial review, run-proven | Proof | Reviewers try to break it; only findings a rerun confirms survive | `skills/interrogate` |
| 22 | Three verdicts | Proof | Verified, not verified, or inconclusive; inconclusive is not a pass | `skills/figure-it-out` |
| 23 | Verifiable units in sequence | Proof | Small units, each ending in a check; do not advance on red | `skills/principle-sequence-verifiable-units` |
| 24 | Build the lever | Proof | Write the script that does or checks the work; the script is the proof | `skills/principle-build-the-lever` |
| 25 | Explain the number | Proof | Before trusting a measurement, rule out what else it could be measuring | `skills/principle-explain-the-number` |
| 26 | Blinded evaluation | Proof | Test a prompt change with candidates and a judge who cannot tell what is tested | `playbooks/eval.md` |
| 27 | One change, measure, keep or revert | Learning | Improve one metric with a frozen harness and a log of every attempt | `playbooks/hillclimb.md` |
| 28 | Decision trail | Learning | One append-only row per decision: what, why, evidence, result | `skills/show-me-your-work` |
| 29 | Reflect after the run | Learning | Mine the transcript for lessons and route each to a concrete edit | `skills/reflect` |
| 30 | Encode lessons in structure | Learning | A repeated instruction becomes a check in code, not more text | `skills/principle-encode-lessons-in-structure`, `skills/correct` |
| 31 | Attack the premise | Learning | When two fixes on one belief fail, test the belief | `skills/principle-attack-the-premise` |
| 32 | Clean pause and pickup | Learning | A stop leaves a note a cold-start agent can resume from | `playbooks/pause-safely.md`, `session-pickup.md` |
| 33 | Idempotent steps | Control | Every step is safe to run twice and after a crash | `skills/principle-make-operations-idempotent` |

---

## 1. Entry: turning a request into a defined job

### 1. Router and playbooks

```
   request ──► ROUTER ──► picks one PLAYBOOK ──► numbered steps ──► fixed reply format
                          (bug fix, feature, investigation, …)
```

**What.** One entry point classifies the request and selects a procedure written for that type of task. A playbook is short: an ownership line ("you own the answer"), five to eight numbered steps, and the exact contents of the final reply.

**When.** The system handles several distinct kinds of task, and quality depends on doing the right steps in the right order.

**How to build it.** Write one file per task type. Keep the router's file as an index: one line per playbook saying when it applies. The agent, or your code, opens only the chosen one. Give every playbook a "Reply" line that lists what the final answer must contain.

**Limits.** The router is only as good as the "when it applies" lines. Overlapping playbooks need an explicit tie-break (pstack states, for example, that a status request routes to its own playbook and not to a similarly named built-in).

### 2. Restate the goal first

**What.** The agent's first output is the user's goal, the problem being solved, and the smallest change expected to meet it, in its own words. It does not wait for confirmation. The same restatement opens every brief given to a worker and every final report.

**When.** Always, except for a fully specified one-line change.

**How to build it.** Make it the first required field of the first step. Pass that text, unchanged, into every worker brief.

**Limits.** If the evidence rules out what was asked, the rule is to show the evidence and stop, not to proceed on the restated goal.

### 3. Sharpen the request

**What.** Before running a vague ask, rewrite it. Four questions: what would a top professional do here that was not asked for; what is the rawest material to start from; which specific methods and tools; and what, other than the agent or the user, would show the result is right.

**When.** The request is broad ("make it better") or the user is unsure what good looks like.

**Limits.** It deepens a task; it must not widen it. Product and preference choices stay with the human.

---

## 2. Control: who decides what happens next

### 4. Steps copied verbatim

**What.** On choosing a playbook, the agent opens a task list whose first items are the playbook's steps, copied word for word. A step it decides not to do stays in the list with `skip: <reason>`.

**Why it works.** The procedure cannot silently lose a step, and a reviewer can see what was skipped and why.

**How to build it.** If your system has a task-list tool, require it. If the control flow is in code, this is simply your state machine: the steps are states, and skipping requires an explicit transition with a reason.

### 5. Small rules, loaded on demand

```
   index (one line each)  ──►  trigger fires  ──►  read that one small file in full
   "Fix Root Causes. Debugging."                    10 to 25 lines
```

**What.** About thirty principle files of 10 to 25 lines each. The main file holds only an index: name plus the situation in which it applies. The agent reads a leaf file in full only when it applies it, and may cite only principles whose file it read in that session.

**When.** You have more guidance than fits comfortably in one prompt, and most of it is irrelevant to any single step.

**How to build it.** Split guidance by trigger, not by topic. Keep the always-loaded part to the index. Where your code knows the current state, it can select the file itself instead of trusting the model to open it.

**Limits.** Loaded text stays in the conversation history, so on a long run the history still grows. This pattern relies on the model choosing to read the right file; weaker models may not. Whether a short prompt beats a long one is an empirical question for your model: measure it (patterns 26 and 27) before assuming.

### 6. Trigger then action

**What.** Every rule has the shape "situation → action": "Code crossing a function boundary → run the design step first." "About to ask the user a 'which approach' question → classify it first."

**Why it works.** The model does not have to infer when a rule applies. A rule without a trigger tends to be applied everywhere or nowhere.

**How to build it.** Rewrite each guideline until it begins with a detectable situation. Add, where judgment is needed, one line of "you skipped this when…" describing the visible sign of the failure.

### 7. Design a procedure when none fits

**What.** For work no playbook covers, the first deliverable is the workflow: a falsifiable definition of done, the scope in rough units, a rigor level, and a list of phases. The verification harness is built before the work, with the baseline captured from the unchanged state.

**When.** Large, novel, or unattended work.

**Limits.** One checkpoint with the human is earned before a multi-hour run; after that it proceeds.

### 8. Exit condition as a predicate

**What.** "Done" is stated before the first step as something that passes or fails: tests green, the reproduction no longer fires, all N items merged, pixel difference zero. For improvement loops it pairs a target with a minimum number of attempts, so an early lucky result cannot end the run.

**Rules that go with it.** A plateau is not a stop. Never relax the predicate to declare success. Surface a genuine dead end instead of spinning.

**How to build it.** Make the predicate a function your code can evaluate, not a sentence the model judges.

### 9. Reversible or not

```
   reversible   (write, edit, split, retry)        → proceed, then present
   irreversible (delete data, deploy, message a    → stop and ask
                 customer, force-push)
```

**What.** The human supervises asynchronously. The agent does not ask "should I do X?" on reversible work; it does X and explains. It always stops for irreversible actions and for product direction.

**When.** Throughput matters and the work is reviewable after the fact.

**Limits.** This is a policy for work that can be undone. Where the human's input is the product (teaching, interviewing, anything conversational), the opposite holds: asking is the work.

### 10. Experiment instead of asking

**What.** Before asking the human a "which approach" question, classify it. If the answer is a fact that can be observed by running something (behavior, timing, output), build a throwaway sketch and let the result decide. Reserve questions for preference calls no experiment can settle.

**How to build it.** Give the agent a scratch area separate from production, where code quality does not matter and nothing ships.

### 33. Idempotent steps

**What.** Every state-changing step answers two questions: what happens if this runs twice, and what happens if the previous run crashed halfway. A step derives what to do from the state that exists, not from what the previous run intended. Anything a run leaves behind (a lock, a half-written record) must be recognizable as stale by the next run.

**When.** Any loop, retry, or long run. In agent systems, retries and restarts are normal.

---

## 3. Workers: splitting, isolating, handing over

### 11. Fresh worker, consolidated brief

```
   new work ──► NEW worker  +  one brief:  the goal · every later directive ·
                                           the prior worker's report · where its output is
```

**What.** New work, including a fix round, a follow-up, or a retry, goes to a fresh worker. The brief consolidates everything: the original task, all later instructions, and the previous worker's report. An existing worker is reused only when the new work needs state that lives in it and is costly to move (a checkout, uncommitted changes, a running process).

**Why it works.** A long-running worker carries a growing, partly stale context. A fresh one sees only what is true now.

**How to build it.** Treat a role (owner, reviewer) as separate from the agent instance that fills it. When the instance returns, a new instance takes the role's next message.

**Limits.** A fresh start has a cost: the worker must rebuild its bearings from the brief. This pays off when a unit of work is large (minutes). For very small, frequent steps it can be slower and less reliable than continuing, because the history itself serves as worked examples of the expected format. Measure before applying it to short turns.

### 12. Guard the context window

**What.** Large outputs, long files, repeated reads and broad searches are routed to workers. The lead keeps summaries. Briefs carry file pointers, not pasted content. Phases are sized: a limit on files per phase and on turns.

**Why it works.** An overfull context degrades reasoning and eventually forces lossy compression.

### 13. Separate before serializing

**What.** When several actors might write the same thing, first ask whether they need the same object. Usually they do not: give each its own file, key, branch or directory, and merge only at the reading boundary. Only when one shared target is a real requirement, serialize access structurally (single writer, lock, sequential phases).

**Rule.** Instructions and conventions are not concurrency control.

### 14. One owner per unit

**What.** Each unit of output has exactly one writer for its whole life. The coordinator never edits the work; it decides who does each piece and checks what comes back. Conflicts and fixes go to the owner.

**How to build it.** In a multi-agent system, write down for every piece of shared state which single agent may write it. Everyone else reads.

### 15. Model per role

**What.** Each role (lead, code worker, reviewer, judge, verifier) has a line in one configuration file naming its model and effort level. Skills read that line and fall back to a default. The hardest work goes to the strongest model; routine checks go to a fast one. A second opinion is the same prompt against a different model, and agreement between different models is treated as strong signal.

**How to build it.** Never hard-code a model in a prompt. Name roles, and map roles to models in configuration.

### 16. Start with one unit

**What.** Before fanning out, take a single unit through the complete pipeline: brief, owner, verification, acceptance. A flaw in the brief then costs one worker instead of fifty.

### 17. Fan out and aggregate

```
   FRAME      the done predicate and the report to return
   FAN OUT    N workers in parallel, each with a brief that stands alone
   AGGREGATE  every required slice needs a result; a missing one is a gap, not a pass
   REPORT     one consolidated result, never raw worker dumps
```

**What.** Partition work into slices, or race several workers on identical briefs, with the selection rule (first pass, rank all, best of) declared before spawning. Worker reports use a fixed vocabulary: pass, issues, or blocked, with evidence.

**When.** Coverage checks, independent audits, competing experiments.

**Limits.** Parallelize only across real seams. Do not fan out what a script can do in one pass (pattern 24).

### 18. Compete, pick a base, graft

```
   same brief ──► candidate A ┐
                  candidate B ├─► judge from another model family ─► pick a base ─► graft the
                  candidate C ┘     scores against a rubric             best parts of the others
```

**What.** For one important artifact, several candidates are produced from the same prompt, each in its own location. A rubric of three to six concrete criteria is written for the picker only. A judge from a different model family scores them. One candidate becomes the base; one or two things from each of the others are folded in by hand.

**Readings of the outcome.** Candidates converge: strong agreement, ship it. Candidates diverge wildly: the brief was under-specified; reframe and rerun instead of averaging.

**When.** A single attempt would lock in the first shape the model thought of: a design, a schema, a plan.

**Limits.** Costly. Reserve it for one-way decisions. A second round over a settled design is over-engineering.

---

## 4. Proof: what counts as done

### 19. Prove it on the real thing

**What.** Verify each output by checking the actual artifact. Not a proxy, not "it compiled", not the worker's summary. When a check fails, suspect the observation method before the system. When something passes too easily, suspect the check.

**How to build it.** For every task type, define the surface the real user touches, and a scripted way to drive it and capture evidence.

### 20. Verifier is not the author

**What.** The agent that judges a piece of work is not the one that produced it, and preferably runs on a different model family. A verdict covers one exact version of the work; any later change needs a new verdict.

### 21. Adversarial review, run-proven

**What.** Reviewers are told to break the work and to prove each finding with a run: a failing test, a reproduction script, command output. Anything not run is left out, which removes style opinions and speculative risks. The lead reruns each command and keeps only findings that fail as claimed. "No findings" is a valid result. The report lists what was dropped and why.

**When.** Before shipping a contested design or change.

**Limits.** Reviewing an abstract plan with nothing built invents risks that never happen. Settle open questions with a prototype first, then review what exists.

### 22. Three verdicts

**What.** Every check ends in verified, not verified, or inconclusive. Inconclusive is not a pass, and a negative result is never hidden.

### 23. Verifiable units in sequence

**What.** Order work as small units that each end in a checkable state, and do not start the next until the current one passes. Each unit is a bracket: known-good state, one change, run the check.

**Why it works.** A failure found at the unit that caused it is cheap to locate. One found after a batch is buried under later work.

### 24. Build the lever

**What.** When the work is not trivial, build the tool that does it or checks it: a script, a generator, a rerunnable check. Do the first unit by hand to learn the recipe, then build the tool and prove it by rerunning it on that unit. The tool is the artifact a reviewer reads and reruns.

**Rule.** A deterministic tool beats fan-out. If a script can process every unit in one pass, do not send workers to do it by hand.

### 25. Explain the number

**What.** Before measuring, write down which result would change a decision and what the noise level is. Then ask why the number is not twice as good: name what limits it. List what else the number could be measuring (errors, skipped or cached work, code that never ran, one side left untuned, noise) and rule each out with evidence. Keep the run count and the spread with the number.

**When.** Any reported speedup, score, pass rate or evaluation result.

### 26. Blinded evaluation

**What.** To test whether a change to a prompt, a rule or a structure improves agent behavior:

- The candidate sees an ordinary-looking request. No word in its prompt, file names or directories reveals that it is being tested or what is measured.
- The candidate is not asked which rules it followed. Adherence is graded from what it actually did and which files it actually opened.
- Several candidates run on different models, each in its own clean location, unaware of the others.
- One judge on a different model family scores all outputs on one scale, seeing them by neutral label only.
- The lead reads every output and compares with the judge. Disagreement means a biased model or an ambiguous rubric.

**When.** Before promoting any change to instructions that many future runs will follow.

---

## 5. Learning: getting better after each run

### 27. One change, measure, keep or revert

```
   freeze the harness ──► hypothesis ──► ONE change ──► measure before/after ──► keep or revert
                              ▲                                                      │
                              └──────────────── log the row either way ◄─────────────┘
```

**What.** Sustained improvement of one metric. Ground the workload first and confirm a case reproduces the complaint. Build the measurement harness, prove it can tell good from bad, then freeze it. Each iteration tests one hypothesis that names a mechanism, makes one change, measures, and either keeps it (one commit) or reverts it in full. A tweak that "might help" is not kept. On a stall, change category or combine near-misses before concluding.

**Rules.** Never stack untested changes. Never claim a win from inspection. Correctness and simplicity outrank the number.

### 28. Decision trail

**What.** One append-only table, one row per decision: time, phase, decision, why, evidence, result. Evidence is a pointer (a version, a path, an artifact), never a paragraph. A wrong call gets a new row that supersedes it; history is not edited. Rows are written for decision points, not every action. At the end, the trail is audited against the actual transcript.

**When.** Long, unattended or multi-phase work that a human will review afterward.

**How to build it.** Where your system records events anyway, build the trail from those records in code so the agent does not have to remember to write it.

### 29. Reflect after the run

**What.** After a session, several reviewers read the transcript in parallel, each with a different lens (judgment, tooling, a divergent view). A synthesizer sorts their findings into accepted, rejected and backlog. Anything a check in code would enforce more reliably is moved out of the instruction list. Accepted edits wait for human approval, because a changed instruction affects every later run.

**Rule.** One-offs are not lessons. A mistake class counts once it has happened twice.

### 30. Encode lessons in structure

**What.** When the same instruction is written a second time, encode it: a type, a validation, a lint whose message names the fix, a test, a runtime check. The order of preference is architecture, then types, then a check, then a test, and documentation last. If a structural fix exists, use only that.

**Principle.** The instruction is the symptom.

**How to build it.** Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that works. Design so that a change that looks right from one place is right for the whole system. Prove each new check fails on a real past mistake.

### 31. Attack the premise

**What.** When two or more fixes that share one belief have failed the same check, write that belief down as one sentence and test it directly before attempting a third fix. Look at how the failures are distributed, not only how large they are. If the evidence contradicts the belief, the cause is elsewhere.

### 32. Clean pause and pickup

**What.** A pause finishes or backs out of the current atomic step, makes the work durable, and writes a resume note outside the conversation: intent, progress, what is verified, current state, next steps, gotchas. A pickup reads that trail as authoritative, reconstructs state, names the resume point, and does not redo completed work, while still verifying inherited claims against the original goal.

---

## KPIs: what to measure in an agent layer

pstack does not publish a KPI list. It does fix the vocabulary that makes KPIs possible: a pass-or-fail exit condition, three verdicts, a kept-or-reverted log, a fixed report vocabulary for workers. The indicators below are derived from those, one group per layer. Each one names what to count and where the count comes from, so it can be computed by code from records the system already keeps.

### The rule before any KPI

Apply pattern 25 to every indicator before trusting it: state which value would change a decision, the run-to-run spread, and what else the number could be measuring. A KPI nobody would act on is not worth collecting.

### Outcome KPIs (did it work)

| KPI | How to count it | Pattern it comes from |
|---|---|---|
| Task success rate | Runs whose exit predicate passed ÷ all runs | 8 |
| Verified rate | Outputs with verdict "verified" ÷ outputs produced. Report "inconclusive" separately; never fold it into success | 19, 22 |
| False-done rate | Runs the agent reported as done that an independent check failed ÷ runs reported done | 19, 20 |
| First-pass acceptance | Units accepted by the verifier on the first submission ÷ units submitted | 20 |
| Escaped defects | Problems found after acceptance (by a user, or a later run) per accepted unit | 21 |

### Control KPIs (did it follow the procedure)

| KPI | How to count it | Pattern |
|---|---|---|
| Routing accuracy | Requests sent to the playbook a reviewer would have chosen ÷ sampled requests | 1 |
| Step completion | Playbook steps done ÷ steps in the playbook; list skipped steps with their reasons | 4 |
| Invalid-action rate | Tool calls rejected by validation or by a rule ÷ all tool calls | 6, 30 |
| Retries per step | Extra attempts needed before a step's call was accepted | 30 |
| Unnecessary questions | Questions asked of the human that an experiment or a lookup could have answered ÷ questions asked | 9, 10 |
| Termination | Share of runs that end by the predicate, by budget, by dead end, or by timeout | 8 |

### Worker KPIs (did delegation pay off)

| KPI | How to count it | Pattern |
|---|---|---|
| Worker result mix | Share of worker reports that are pass, issues, blocked, or missing | 17 |
| Dropout and respawn rate | Workers that returned nothing or an unusable result ÷ workers spawned | 17 |
| Rework rate | Units sent back to their owner ÷ units submitted | 14, 20 |
| Context per call | Tokens sent to the model per call, tracked over the length of a run | 11, 12 |
| Write conflicts | Times two workers touched the same target | 13 |
| Candidate agreement | How often independent candidates converge on the same shape | 18 |

### Proof KPIs (can the checks be trusted)

| KPI | How to count it | Pattern |
|---|---|---|
| Check sensitivity | Known-bad inputs the check fails ÷ known-bad inputs tried | 24, 27 |
| Reviewer precision | Review findings confirmed by a rerun ÷ findings filed | 21 |
| Judge agreement | Share of evaluations where the judge and the lead's own reading agree | 26 |
| Verdict freshness | Accepted units whose verdict was given on the exact version that shipped ÷ accepted units | 20 |
| Noise floor | Spread of the main metric across repeated identical runs | 25 |

### Learning KPIs (is it getting better)

| KPI | How to count it | Pattern |
|---|---|---|
| Kept-to-reverted ratio | Changes kept ÷ changes tried, from the decision log | 27 |
| Metric trend | The main metric, baseline to current, with the number of iterations | 27 |
| Repeat-mistake rate | Mistake classes that occurred again after being "fixed" ÷ classes fixed | 29, 30 |
| Structural share | Lessons fixed by a check in code ÷ lessons captured | 30 |
| Instruction size | Tokens of always-loaded instructions, tracked over time. Growth without a measured gain is a warning | 5, 30 |
| Resume cost | Work redone after a pause or a handover ÷ work completed before it | 32 |

### Cost and experience KPIs

| KPI | How to count it |
|---|---|
| Cost per successful task | Total model cost ÷ runs whose predicate passed (not ÷ all runs) |
| Latency per turn | Median and 90th percentile time from input to the agent's reply; split model time from waiting time |
| Human turns per task | Messages the human had to send to reach a passed predicate |
| Human corrections | Times the human had to correct the agent, per task |

### A minimal set to start with

Five numbers cover most of what goes wrong:

```
   1  task success rate          did it reach the predicate
   2  false-done rate            did it claim success it had not earned
   3  invalid-action rate        how often did rules have to stop it
   4  latency per turn           what the person actually waits
   5  repeat-mistake rate        are lessons sticking
```

Add others only when a decision depends on them.

### Reading KPIs without fooling yourself

- **Count from records, not from the agent's reports.** A success rate built on self-reported "done" measures confidence, not outcome.
- **Keep the denominator honest.** Report inconclusive, cancelled and timed-out runs as their own categories.
- **Compare like with like.** Same task set, same model, same settings. A change in any of them resets the baseline.
- **Sample size before conclusions.** A handful of runs shows large effects only. State the run count beside every figure.
- **One number moving alone is suspicious.** A higher success rate with a higher false-done rate is a worse system.

## Common pitfalls named in pstack's guide

- Listing which steps to use in the request. State the goal and constraints; the procedure already sequences the steps.
- A vague finish condition. "Make it better" gives a loop nothing to check.
- Leading with your theory of the cause. The agent searches where you pointed. Ask it to restate the problem first.
- Taking the first design. One attempt locks in the first shape.
- Polishing an abstract plan before anything is built.
- Several agents writing in one place.
- Looping before the loop can verify its own work. That only makes unchecked work faster.
- Trusting an unvetted number.
- Correcting the same mistake by hand, in chat, more than once.
- Reporting success because a build passed.

## Choosing patterns for a new agent layer

Start smaller than seems necessary. pstack's own advice is to prompt plainly, watch where the agent fails, and add a rule or a check when the same failure appears twice.

A reasonable order of adoption:

```
   first    8  exit condition as a predicate
            19 prove it on the real thing
            30 encode lessons in structure
   then     1  router and playbooks        (once there are several task types)
            23 verifiable units in sequence
            28 decision trail
   then     26 blinded evaluation  +  27 one change, measure, keep or revert
            (before investing further in prompts)
   later    11 to 18  worker patterns      (only when one agent is not enough)
```

Two cautions when carrying these to a different kind of system:

- The worker patterns (11 to 18) assume strong models and units of work that take minutes. With small models or very short turns, the cost of a fresh start can exceed its benefit. Test on your own model.
- The autonomy patterns (9, 10) assume reviewable, reversible output. Where talking with the human is the product, they do not apply.
