# Shadow log (read after the simulation)

Topic: Python data structures
Started: 2026-11-12

## Step 1: session opened (app code)

Scope, in:
- A. lists: building, mutating, aliasing (one object, two names)
- B. dicts: counting, building, merging without mutating inputs
- C. sets: fast membership, de-duplication
- D. tuples / frozensets: immutability and hashability (what can be a dict key / set member)
- E. stack: last-in-first-out with a list
- F. choosing the right structure for speed (O(1) lookup vs O(n) scan)

Parked: trees, graphs, heaps, sorting algorithms, collections module beyond basics, numpy/pandas, typing.

Map: empty.

## Step 2: scan tasks issued (01_scan.py)

| Task | Probes |
|---|---|
| 1 make_grid | A (aliasing: `[[0]*c]*r`) |
| 2 word_counts | B |
| 3 merge_inventory | B + A (copy vs same object) |
| 4 first_duplicate | C + F (1M items under 1s) |
| 5 count_unique_pairs | D + C + F |
| 6 is_balanced | E |

Counters: attempts 0, hints 0, started on issue.

## Step 2: first learner response

Learner: "don't know where to start". No code written.
Score: none possible yet; no evidence per part.
Root cause candidates (unconfirmed): (a) setup / tooling, (b) Python basics
(writing a function), (c) the tasks themselves.
Advice to Tutor: localize before scoring. Ask which of a/b/c; drop the level
until something gets written.
Counters: attempts 0, help requests 1.

## Step 2: localized

Learner picked (c) and added: doesn't write code by hand, wants to learn to.
Root cause (confirmed by learner): production from a blank file. Recognition
of code > recall. Not a data-structure gap yet.
New gap added to map, below everything: "start a task: example → code".
Advice to Tutor: step down. One micro-task only (task 1, first row). Give a
starting routine, not a solution. Re-scan the rest after it works.
Counters: attempts 0, help requests 2.

## Step 2: still blocked

File untouched. Help requests 3 (incl. the first). Attempts 0.
Root cause refined: not just "how to start" but the mechanics of writing a
function body (where to type, what `return` does), or the vocabulary of the
instruction. Unconfirmed which.
Advice to Tutor: R4. Show the same move on a different tiny function, then
have them copy the move onto make_grid. Ask which word was unclear.

## Attempt 1: make_grid, hard-coded step

Ran: python3 01_scan.py -> [[0, 0, 0], [0, 0, 0]]. make_grid(3, 2) -> same (hard-coded).
Result: micro-step passed with R4 help. Node "start a task: example -> code":
shaky (needed R4).
Advice to Tutor: next micro-step: generalize ONE row on `cols`. Let them try first.
Counters: attempts 1, hints R4 x1, help requests 3.

## Attempt 2: one row of `cols` zeros: blocked

File unchanged. "i don't get it". Help requests 4.
Shadow diagnosis: the gap is PARAMETERS. The learner may not see that `cols`
is a name holding whatever number the caller passed (5 in make_grid(2, 5)).
Without that, "a list of cols zeros" has no meaning.
Tutor diagnosis (reported): the instruction was overloaded (two moves plus a
test line plus "general"), so the TASK wasn't understood, not Python.
-> DISAGREEMENT. Zone opened. Shadow flags the learner.

## Zone round 2

Learner (to Shadow only): cols = 5, by position. Correct, with a reason.
Shadow diagnosis revised: parameters are understood. Gap is NOT what `cols` is.
New candidate: HOW to build a list whose length comes from a variable
(repetition: `[0] * n` or a loop). Learner knows the "what", lacks the "how".
Not yet agreed with Tutor.

## Zone round 3: AGREED

Learner (to Tutor only): no way known to make a list of n items; knows list literals only.
Agreed diagnosis (Tutor + Shadow): learner can write list literals and understands
parameters; missing piece is building a list whose length comes from a variable.
Map update: new node "list of n items from a variable" between
"start a task: example -> code" and "A. lists: building, mutating, aliasing".
Counters: attempts 1, hints R4 x1, help requests 4, zone rounds 3, flags 2.
Final word: "ok" (no change). Step 6: Tutor explains the gap only, using R4
(same idea shown on a different value first).
