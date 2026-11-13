# Observer notes: learner behaviour (read after the simulation)

Purpose: answer the open questions in `../decisions.md` from what the learner
actually does, not from guesses.

What I'm watching for:
- Q5 struggle: when do you ask for help? after how many failed runs? how long?
- Q6 force teaching: do you say "teach me" / ask for explanation unprompted?
- Q7 passed: what makes you feel a gap is done?
- Q8 scan length: signs of fatigue during the scan (skipping, short replies, complaints)
- Q9 screen: do you look at / ask for the map or KPIs?
- Disagreement zone: how you answer flags; do you use Stop; final word
- Anything else: tone, pace, what you skip

## Log

- Sim start. Learner chose the topic "Python: data structures" from a list of four.
- Scan issued: 6 tasks in one file.
- First reply to the scan: "i even don't even from where to start". Wrote no code;
  didn't say which part blocks them (setup? Python itself? the tasks?).
  - Q5: asked for help immediately, before any attempt. Help is wanted from the
    very first moment, not only after failed runs.
  - Q8: the scan (6 functions in one file) was too big a first step: it stalled
    at zero instead of tiring them later. The scan's first task needs to be
    much smaller, or the scan needs a step 0 that finds the level.
  - Decision 3 (always code in VS Code) is under pressure here: a learner who
    can't start writing produces no evidence at all.
- Answered "c" plus context: knows a little Python, but "i'm not writing code by
  my hand, that's why i want to learn". Honest, unprompted self-report.
  - Key learner profile: can READ code (likely AI-assisted) but hasn't built the
    habit of PRODUCING it from a blank file. The real gap is "how to start",
    not any single data structure.
  - Design implication: the scan assumes the learner can produce code. For this
    learner, step 2 must start from a blank-page micro-task, and the map
    probably needs a root node like "turn an example into code" below all the
    data-structure nodes.
  - Q5: wanted help the moment the blank page appeared. A "stay quiet" rule
    would have left them with nothing to struggle on.
- Second help request: "i still don't know please help me". File untouched;
  nothing typed. Didn't say which word or step blocked them.
  - Q5: two help requests in a row, zero attempts. For a beginner, "stay quiet
    and let you struggle" doesn't apply until there is something to struggle WITH.
  - Q6: asks for help but not for "teaching" by that name; the request is
    "help me", i.e. show me. Forced-teaching may need to be the default early on.
  - Hint ladder: an instruction ("replace pass with a line that returns...")
    was still too abstract. Next rung: show the same move on a tiny, different
    function (R4).
- After the R4 hint (same move shown on a tiny different function), wrote
  `return [[0,0,0],[0,0,0]]` correctly on the first try and said "check it".
  - Hint ladder: R4 was the rung that unlocked them; R1-R3 style instructions
    didn't. For a beginner, "show the move on something else" works better than
    describing the move.
  - Hands the checking to the Tutor ("check it") rather than reporting their own
    run output. Fits the design: the agent runs the code.
- Next micro-step (one row of `cols` zeros): "i don't get it". File unchanged,
  no attempt. Short message, no detail on what wasn't understood.
  - Pattern: open questions ("tell me what you tried") get no detail back;
    the lettered a/b/c question earlier DID get a precise answer. Lettered
    choices work better than open "what's unclear?" for this learner.
  - Good moment to try the disagreement zone: Tutor and Shadow have two honest,
    different diagnoses.
- Disagreement zone, Shadow's flag: answered "5", with the reason ("the second
  number is column wise and the first is rows"). Correct, and explained
  unprompted. Didn't use Stop. Engaged with the zone without complaint.
  - The lettered flag question again got a precise answer, this time with reasoning.
  - Open question 2 (can an agent pass on a private answer?): in the sim the
    Shadow shares its CONCLUSION ("inputs are understood") without quoting the
    answer. Check with the learner whether that's acceptable.
- Tutor's flag: "no i don't know, i know list but that's it". Clear answer to a
  lettered question.
  - Both flags answered quickly and honestly; the zone found the gap in 2
    rounds with 2 learner inputs. Without the zone, the Tutor would have
    re-explained the task (its wrong diagnosis).
- Final word: "ok". Used the final word as a plain acknowledgement; nothing added.
  - Open question 1 (what the final word does): for this learner it's mostly a
    confirmation. Maybe it should be optional and skippable, not a required step.

## Design feedback from the learner (stepped out of the sim)

- After the Tutor's step-6 explanation ("multiplying a list repeats it", shown
  on examples), the learner flagged a "massive gap": the Tutor handed over a
  rule to memorise instead of building understanding from first principles.
  They want the learner to reach each fact by understanding, not memory.
  - The Tutor's step 6 broke the existing teacher method (teacher/05-method.md,
    Principle ii "how could I have discovered this?"): it decreed a fact.
