/**
 * Plan progress reads (coach-planner design §4.6/§4.7, plan-progress.ts):
 * currentPlanNodeId, advanceAfterAnswer (every branch), goalOf and
 * probeAssessmentOf, advanceAppends. nextPlanNode itself is pinned in
 * plan-accept.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceEvent, PlanTree } from "../src/core/contracts.ts";
import { nodeHandoffText, plannerBriefText, roadRecord, wholeRoadRecord } from "../src/core/contracts.ts";
import { knowledgeOf, type FactKnowledge } from "../src/core/knowledge.ts";
import { advanceAfterAnswer, advanceAppends, currentPlanNodeId, goalOf, probeAssessmentOf } from "../src/core/plan-progress.ts";
import { newCoachCardMessage, newNodeHandoffMessage, newPlannerWakeMessage, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { newGraphContextMessage } from "../src/core/native-messages.ts";

const known = (p: number): FactKnowledge => ({ p, attempts: 3, lastCorrect: true, misconception: false });
const passed = (...graphIds: string[]) => new Map(graphIds.map((id) => [id, known(0.9)]));

/** a → b → c, plus d after a. */
const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "A", facts: [{ id: "fa", graphId: "n_a", statement: "A." }] },
		{ id: "b", title: "B", facts: [{ id: "fb", graphId: "n_b", statement: "B." }] },
		{ id: "c", title: "C", facts: [{ id: "fc", graphId: "n_c", statement: "C." }] },
		{ id: "d", title: "D", facts: [{ id: "fd", graphId: "n_d", statement: "D." }] },
	],
	edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "d" }],
	version: 1,
};

function assistantCall(id: string, name: string, args: unknown, stopReason = "toolUse"): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args as never }],
		api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason, timestamp: 1,
	} as never;
}

function toolResult(id: string, callId: string, name: string, details: unknown, isError = false): LhMessage {
	return { id, role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 2 } as never;
}

describe("currentPlanNodeId", () => {
	it("is the node of the latest node-handoff marker, null without one", () => {
		assert.equal(currentPlanNodeId([]), null);
		assert.equal(currentPlanNodeId([newUserMessage("hi") as LhMessage, newPlannerWakeMessage("x") as LhMessage]), null);
		const messages = [
			newNodeHandoffMessage("a", "x") as LhMessage,
			newUserMessage("hi") as LhMessage,
			newNodeHandoffMessage("b", "y") as LhMessage,
			newCoachCardMessage("z", { phase: "teach", nodeId: "b", notes: [], askLearner: null }) as LhMessage,
			newPlannerWakeMessage("w") as LhMessage,
		];
		assert.equal(currentPlanNodeId(messages), "b", "a later wake does not change the current node");
	});
});

describe("advanceAfterAnswer", () => {
	it("stays while the current node has not passed", () => {
		assert.deepEqual(advanceAfterAnswer(TREE, new Map(), "a"), { kind: "stay" });
		assert.deepEqual(advanceAfterAnswer(TREE, passed("n_b"), "a"), { kind: "stay" });
		assert.deepEqual(advanceAfterAnswer(TREE, passed("n_a"), "gone"), { kind: "stay" }, "an unknown node never advances");
	});

	it("moves to the next ready node while more than one node is unpassed", () => {
		assert.deepEqual(advanceAfterAnswer(TREE, passed("n_a"), "a"), { kind: "next", node: TREE.nodes[1] });
	});

	it("wakes the planner when one unpassed node is left, or none", () => {
		assert.deepEqual(advanceAfterAnswer(TREE, passed("n_a", "n_b", "n_c"), "c"), { kind: "wake-planner" }, "one node of the batch left");
		assert.deepEqual(advanceAfterAnswer(TREE, passed("n_a", "n_b", "n_c", "n_d"), "d"), { kind: "wake-planner" }, "the plan is exhausted");
	});

	it("wakes the planner when several nodes are unpassed but none is ready", () => {
		// x passed; y and z both wait on a prerequisite that is not in the tree.
		const stuck: PlanTree = {
			nodes: [
				{ id: "x", title: "X", facts: [{ id: "fx", graphId: "n_x", statement: "X." }] },
				{ id: "y", title: "Y", facts: [{ id: "fy", graphId: "n_y", statement: "Y." }] },
				{ id: "z", title: "Z", facts: [{ id: "fz", graphId: "n_z", statement: "Z." }] },
			],
			edges: [{ from: "missing", to: "y" }, { from: "missing", to: "z" }],
			version: 1,
		};
		assert.deepEqual(advanceAfterAnswer(stuck, passed("n_x"), "x"), { kind: "wake-planner" });
	});
});

describe("goalOf", () => {
	it("is the text of the first learner message; markers never count", () => {
		assert.equal(goalOf([]), "");
		const messages = [
			newGraphContextMessage([], []) as LhMessage,
			newUserMessage("teach me python imports") as LhMessage,
			newUserMessage("later message") as LhMessage,
		];
		assert.equal(goalOf(messages), "teach me python imports");
		const blocks = { id: "u", role: "user", content: [{ type: "text", text: "line one" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "line two" }], timestamp: 1 } as LhMessage;
		assert.equal(goalOf([blocks]), "line one\nline two");
	});
});

describe("probeAssessmentOf", () => {
	const assessment = { strands: [{ strand: "imports", assessment: "Floor: none." }], summary: "Start at modules." };

	it("is the concluded probe_done call's assessment", () => {
		const messages = [
			newUserMessage("goal") as LhMessage,
			assistantCall("p", "probe_done", { assessment }),
			toolResult("pr", "call_p", "probe_done", { ok: true }),
		];
		assert.deepEqual(probeAssessmentOf(messages), assessment);
	});

	it("is null before the probe concludes: no call, a refused call, a failed generation, an unparseable input", () => {
		assert.equal(probeAssessmentOf([]), null);
		assert.equal(probeAssessmentOf([assistantCall("p", "probe_done", { assessment })]), null, "no result yet");
		assert.equal(probeAssessmentOf([assistantCall("p", "probe_done", { assessment }), toolResult("pr", "call_p", "probe_done", { ok: false })]), null);
		assert.equal(probeAssessmentOf([assistantCall("p", "probe_done", { assessment }, "error"), toolResult("pr", "call_p", "probe_done", { ok: true })]), null);
		assert.equal(probeAssessmentOf([assistantCall("p", "probe_done", { assessment: "a string" }), toolResult("pr", "call_p", "probe_done", { ok: true })]), null);
	});

	it("skips a refused attempt and reads the concluded one", () => {
		const messages = [
			assistantCall("p1", "probe_done", { assessment: { strands: [{ strand: "old", assessment: "x" }] } }),
			toolResult("pr1", "call_p1", "probe_done", { ok: false }),
			assistantCall("p2", "probe_done", { assessment }),
			toolResult("pr2", "call_p2", "probe_done", { ok: true }),
		];
		assert.deepEqual(probeAssessmentOf(messages), assessment);
	});
});

describe("advanceAppends", () => {
	const assessment = { strands: [{ strand: "imports", assessment: "Floor: none." }], summary: "Start at modules." };
	const right = (graphId: string, i: number): EvidenceEvent => ({ nodeId: graphId, chatId: "c", messageId: `m${graphId}${i}`, at: `2026-11-15T10:00:0${i}.000Z`, source: "quiz", correct: true, guess: 1 / 3 });
	const passes = (...graphIds: string[]) => graphIds.flatMap((g) => [0, 1, 2].map((i) => right(g, i)));
	const teaching = (nodeId: string, extra: LhMessage[] = []): LhMessage[] => [
		newUserMessage("teach me letters") as LhMessage,
		assistantCall("p", "probe_done", { assessment }),
		toolResult("pr", "call_p", "probe_done", { ok: true }),
		newNodeHandoffMessage(nodeId, "[Node handoff] x") as LhMessage,
		...extra,
	];

	it("applies only to a teacher on a node with a tree and no open question", () => {
		const events = passes("n_a");
		assert.deepEqual(advanceAppends({ messages: teaching("a"), tree: null, events, notes: [] }), [], "no tree");
		assert.deepEqual(advanceAppends({ messages: teaching("a").slice(0, 3), tree: TREE, events, notes: [] }), [], "the planner's turn, no current node");
		assert.deepEqual(advanceAppends({ messages: [newUserMessage("goal") as LhMessage, newNodeHandoffMessage("a", "x") as LhMessage], tree: TREE, events, notes: [] }), [], "the prober's turn");
		const open = teaching("a", [assistantCall("q", "quiz", { type: "check", nodeId: "a", facts: ["fa"], question: "Q?", options: [{ label: "x" }, { label: "y" }], explanation: "e", correctAnswer: "x" }, "toolUse")]);
		assert.deepEqual(advanceAppends({ messages: open, tree: TREE, events, notes: [] }), [], "a question is still open");
		const woken = teaching("a", [newPlannerWakeMessage("w") as LhMessage]);
		assert.deepEqual(advanceAppends({ messages: woken, tree: TREE, events, notes: [] }), [], "the planner is already woken");
	});

	it("stay: nothing while the current node has not passed", () => {
		assert.deepEqual(advanceAppends({ messages: teaching("a"), tree: TREE, events: passes("n_a").slice(0, 2), notes: [] }), []);
	});

	it("next: a CONTINUE node-handoff for the next node, with the road and the latest card since the last handoff", () => {
		// One early miss on A's fact (a hard fact), then five right answers pass it.
		const events = [{ ...right("n_a", 9), correct: false, at: "2026-11-15T09:00:00.000Z" }, ...[0, 1, 2, 3, 4].map((i) => right("n_a", i))];
		const messages = [
			newCoachCardMessage("[Coach card] stale", { phase: "teach", nodeId: null, notes: [], askLearner: null }) as LhMessage,
			...teaching("a", [
				newCoachCardMessage("[Coach card] first", { phase: "teach", nodeId: "a", notes: [], askLearner: null }) as LhMessage,
				newCoachCardMessage("[Coach card] latest", { phase: "teach", nodeId: "a", notes: [], askLearner: null }) as LhMessage,
			]),
		];
		const [marker, ...rest] = advanceAppends({ messages, tree: TREE, events, notes: [] });
		assert.equal(rest.length, 0);
		assert.equal(marker!.customType, "node-handoff");
		assert.deepEqual(marker!.details, { nodeId: "b", firstKeptMessageId: null });
		const knowledge = knowledgeOf(events);
		assert.equal(marker!.content, nodeHandoffText({ tree: TREE, nodeId: "b", knowledge, first: false, road: roadRecord(TREE, events, knowledge, "b"), lastCard: "[Coach card] latest" }));
		assert.match(marker!.content, /^\[Node handoff\]/);
		assert.match(marker!.content, /You are starting the next node of the plan\./);
		assert.match(marker!.content, /- b: B \(after: a\)  ← you are here/);
		assert.match(marker!.content, /The road so far:\n- A: passed; needed more than one try: A\./);
		assert.match(marker!.content, /The coach's last card:\n\[Coach card\] latest/);
	});

	it("next without a card since the previous handoff carries none", () => {
		const messages = [newCoachCardMessage("[Coach card] old", { phase: "probe", nodeId: null, notes: [], askLearner: null }) as LhMessage, ...teaching("a")];
		const [marker] = advanceAppends({ messages, tree: TREE, events: passes("n_a"), notes: [] });
		assert.ok(!marker!.content.includes("The coach's last card"));
	});

	it("wake-planner: one planner-wake carrying the brief over the whole road and the coach's notes", () => {
		const events = passes("n_a", "n_b", "n_c");
		const messages = teaching("c");
		const [marker, ...rest] = advanceAppends({ messages, tree: TREE, events, notes: ["Slow down on D."] });
		assert.equal(rest.length, 0);
		assert.equal(marker!.customType, "planner-wake");
		const knowledge = knowledgeOf(events);
		assert.equal(marker!.content, plannerBriefText({ goal: "teach me letters", assessment, tree: TREE, knowledge, road: wholeRoadRecord(TREE, events, knowledge), notes: ["Slow down on D."] }));
		assert.match(marker!.content, /^\[Planner brief\]/);
		assert.match(marker!.content, /Goal \(the learner's own words\):\nteach me letters/);
		assert.match(marker!.content, /- imports: Floor: none\./);
		assert.match(marker!.content, /The road so far:\n- A: passed\n- B: passed\n- C: passed\n- D: not passed/);
		assert.match(marker!.content, /The coach's notes:\n- Slow down on D\./);
	});
});
