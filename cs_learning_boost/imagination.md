# Two-Agent Learning Loop

The student starts by asking about a topic. Two agents run the session:
the **Tutor** teaches, the **Shadow** keeps score behind it.

## Agents overview

```
┌─ TUTOR ─────────────────────────────┐
│ talks to the student                │
│ + first-principles thinking         │
│ + sets the scope                    │
│ + task before theory (hands dirty)  │
│ + watches where the student breaks  │
│ + explains only the missing piece   │
│ + shows the map, current position   │
│ - never does bookkeeping            │
└─────────────────────────────────────┘

┌─ SHADOW ────────────────────────────┐
│ reads everything, says nothing      │
│ + logs answers, errors, hints       │
│ + builds and reorders the map       │
│ + tags the root cause               │
│ + updates KPIs every attempt        │
│ + decides repeat / next / review    │
│ - never talks to the student        │
└─────────────────────────────────────┘
```

## Loop

`──>` Tutor reports to Shadow. `<──` Shadow tells Tutor what to do.

### Phase 1: find every weakness (once per topic)

```
 TUTOR                SHADOW

 you: "I want to understand X"
        │
        v
┌─ 1 ────────────┐   ┌────────────────┐
│SET SCOPE       │──>│OPEN SESSION    │
│edges of X,     │   │topic, scope,   │
│park the rest   │   │empty map       │
└────────────────┘   └────────────────┘
        │
 you: answer quick tasks
        │
        v
┌─ 2 ────────────┐   ┌────────────────┐
│SCAN TOPIC      │──>│SCORE EACH PART │
│probe every     │   │solid, shaky    │
│part of X       │   │or missing      │
└────────────────┘   └────────────────┘
        │
        v
┌─ 3 ────────────┐   ┌────────────────┐
│SHOW THE MAP    │<──│BUILD MAP       │
│"you are here"  │   │order gaps by   │
│[x][>][ ][ ][ ] │   │dependency      │
└────────────────┘   └────────────────┘
```

### Phase 2: fix them, hands dirty (repeats per weakness)

```
 TUTOR                SHADOW

┌─ 4 ────────────┐   ┌────────────────┐
│TASK FIRST      │──>│START COUNTERS  │
│build, break,   │   │attempts, time, │
│debug. no theory│   │hints           │
└────────────────┘   └────────────────┘
        │
 you: try, get stuck
        │
        v
┌─ 5 ────────────┐   ┌────────────────┐
│WATCH THE BREAK │──>│TAG ROOT CAUSE  │
│stay quiet,     │   │new gap? add    │
│let you struggle│   │it to the map   │
└────────────────┘   └────────────────┘
        │
        v
┌─ 6 ────────────┐   ┌────────────────┐
│EXPLAIN GAP ONLY│──>│LOG THE HELP    │
│first principles│   │hint size,      │
│smallest hint   │   │depth of "why"  │
└────────────────┘   └────────────────┘
        │
 you: retry on a new task
        │
        v
┌─ 7 ────────────┐   ┌────────────────┐
│ACT ON VERDICT  │<──│DECIDE NEXT     │
│update the map  │   │repeat, next,   │
│on screen       │   │or review       │
└────────────────┘   └────────────────┘
        │
        v
 not passed ─> back to 4, new task
 passed     ─> mark [x], next gap
 review due ─> re-test an old gap
```

### Phase 3: prove it holds (when the whole map is [x])

```
 TUTOR                SHADOW

 you: build 1 project, all of X
        │
        v
┌─ 8 ────────────┐   ┌────────────────┐
│FINAL BUILD     │──>│TRANSFER SCORE  │
│unseen problem, │   │understood or   │
│whole topic     │   │memorised?      │
└────────────────┘   └────────────────┘
        │
        v
┌─ 9 ────────────┐   ┌────────────────┐
│RE-TEST         │<──│SCHEDULE CHECKS │
│days later,     │   │fail = gap back │
│no notes        │   │on the map      │
└────────────────┘   └────────────────┘
```

## The map the student always sees

```
 [x]──[x]──[>]──[ ]──[ ]──[ ]
  1    2    3    4    5    6
            ^
            you are here
```

## KPIs the Shadow tracks

```
┌─ KPI ─────────────────────┬─ STEP ─┐
│ weaknesses found/fixed    │ 2 5 7  │
│ attempts per weakness     │ 4      │
│ hints per task            │ 6      │
│ depth of "why"            │ 6      │
│ map progress              │ 7      │
│ transfer score            │ 8      │
│ retention                 │ 9      │
└───────────────────────────┴────────┘
```