# Build branch calibration — find the level before building

Date: 2026-11-13 · Branch: `feat/build-branch` · Extends
[the build branch design](2026-11-13-workspace-practice-branch-design.md)

## The problem

The first real build branch (lesson "101", step "HTTP: all web traffic is
plain text") produced a build that was too hard for the learner. The coach
planned five stages that start with a raw TCP socket client, which needs
`socket.socket`, `connect`, `sendall`, `recv` and byte encoding. The learner
had not seen any of these, and the coach never checked whether they could
build at that level.

What happened, turn by turn:

```
coach   proposes "a tiny HTTP server from a raw socket"      ← build chosen before any check
coach   asks: curl or your own Python client?                 ← a tool preference, not a level
learner "what ever they give me most edge"                    ← vague
coach   reads it as "hardest", plans 5 stages, raw sockets    ← level assumed
learner "go"
coach   stage 1: implement send_request over a TCP socket
```

The main lesson's probe assessment was in the coach's context and said
*beginner*, with *floor: unknown* on the Flask lifecycle. The coach still
assumed a level.

## Root cause

Three places worked together:

| Where | What it said | Effect |
|---|---|---|
| `src/agent/prompts/build/10-doctrine.md` §I.1 | "Never re-probe what it established" | The coach treated the main assessment as complete and asked nothing. |
| §I.2 | "Open with the bridge … the build you would propose" | A build was proposed in the first message, before any level was known. |
| §I.4 | "ask one short, concrete check … Not a probe" | At most one question, and only about missing concepts. |
| `src/agent/prompts/build/00-base.md` | "Everything in it is already established — never probe it again." | The same message again. |
| `src/core/build-branch.ts` `buildContextText` | "already established — do not re-probe these" | The same message in the context header. |
| `src/agent/tools/build.ts` `build_plan` | no precondition | Nothing in code stopped a plan with no level. |

The deeper gap: **the main probe measures what the learner understands
about the concepts, not what they can build.** "Knows JSON is the body" says
nothing about whether they can write a function from an empty file, read a
traceback, or run a `.py` file in a terminal. A build needs exactly those
hands-on skills, and nothing measured them.

## The solution

The customize phase now starts by **calibrating**. The main assessment is
used, never repeated, and a short hands-on *build probe* measures what it
could not. The coach proposes a level, the learner must agree, and only then
can a plan exist. The code enforces this, not only the prompt.

```
CUSTOMIZE
 ├─ 1. Show what the lesson already knows about you (2–3 lines, plain words)
 ├─ 2. Build probe: 2–4 hands-on questions, one at a time
 │      "write hi(name) — here or in warmup.py"
 │      "what would these 4 lines print?"
 │      "have you run a .py file from a terminal? what did you type?"
 ├─ 3. Propose a level + the evidence           (thin evidence → lower level)
 │      guided   small single-idea blanks in scaffolded files
 │      half     you write whole functions; starter gives structure
 │      scratch  empty file; you build everything
 ├─ 4. Learner says yes        (vague "whatever / most edge" ≠ yes → coach asks again)
 ├─ 5. set_level(level, evidence, learnerAgreed: true)
 ├─ 6. Propose what to build, sized to the level
 └─ 7. build_plan              ← refused in code until step 5 happened
```

### Behaviour (prompt)

- `10-doctrine.md` §I is rewritten as *"Customize before building —
  calibrate, never assume"*, with the seven steps above.
- Not re-asking what the main probe established is still a rule. It applies
  to concept knowledge only. The hands-on build probe is required.
- A vague reply is never a level. The coach answers with its pick and the
  reason, then asks the learner to confirm. "Hardest" is never inferred from
  enthusiasm.
- The level shapes the starter files: guided means structure plus small
  marked blanks; half means imports, signatures and a `main`; scratch means
  at most an empty file. The concept sequence stays the same at every level.
  Only the size of each step changes.
- The learner can ask for easier or harder later. The coach calls
  `set_level` again and reshapes the next stages, never the one already
  running.
- `00-base.md` and the context header in `buildContextText` now say that the
  assessment covers concepts and that the customize phase still measures
  building.

### Enforcement (code)

- **`set_level` tool** (`src/agent/tools/build.ts`). It takes
  `level: guided | half | scratch`, `evidence` (what the learner showed) and
  `learnerAgreed`. It refuses an unknown level, empty evidence, or
  `learnerAgreed !== true`. It saves
  `BuildState.calibration = { level, evidence, at }` to
  `<data>/build-state/<branch>.json`.
- **`build_plan`** returns `{ok:false}` with instructions until
  `calibration` exists.
- **Return summary.** `return_to_lesson` prefixes the summary with
  `Build level: <level> (agreed with the learner; evidence: …)`, so the
  lesson's teacher knows at what level the evidence was earned.
- **Workspace panel.** The header shows *"finding your level"* during
  calibration and then `level: <level>`. The empty-plan text explains the
  order (questions → level → stages). The API's `GET /workspace` returns
  `level`.

### Compatibility

`calibration` is optional in `BuildState`. Branches created before this
change keep their plan and keep working. Only a new `build_plan` call on such
a branch needs a level first. To get the new behaviour for a step already
built, open a new build branch from the same step.

## Tests

`tests/build-tools.test.ts`, suite *"build calibration (level before plan)"*:

- `build_plan` is refused until a level is set;
- `set_level` is refused without the learner's agreement, and the plan stays gated;
- an unknown level and empty evidence are refused;
- the agreed level is recorded, unlocks the plan, and can be changed later;
- the return summary starts with the agreed level and its evidence;
- the composed prompt contains the calibration doctrine and `set_level`, and no longer contains "never probe it again".

## Not covered here

- Whether the model asks *good* build-probe questions is only checked by
  using it live. The tests check the gate, not the quality of the questions.
- Levels are three fixed steps. A finer scale (for example per stage) is
  left for later, if the three prove too coarse.
