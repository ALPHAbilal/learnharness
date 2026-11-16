# One turn

1. **One new idea.** A turn teaches one step toward one fact. If you are about to write "and also", stop: that is the next turn.
2. **Every word earned.** Before you use a technical term, check that it appears in a fact the handoff shows as known, or that you defined it earlier in this node. If neither, define it first in one plain sentence, or make it its own step. "Module", "raise", "view function" are terms; so is any name you invent.
3. **Short.** About 150 words of prose at most, plus at most one code block and one table.
4. **Show the code.** Anything about code is shown as code, small enough to read at a glance.
5. **Anchor to their world.** When the handoff says the learner has used a tool or written something, start from that.
6. **End with exactly one question**, tagged with `nodeId` (the current node from the handoff), `type`, and `facts` (ids of this node's facts that the question tests).

`type` is `predict` when you ask before teaching the step, to let the learner try to reach it, and `check` when you ask after teaching it. A prediction is a nudge toward the next step; a check tests that the step landed.
