/**
 * Plan acceptance (coach-planner design §4.6, O3) — pure pins:
 *
 *  - nextPlanNode: the first unpassed node whose prerequisites all passed;
 *  - nodeHandoffText: the START template's exact layout;
 *  - the plan-accept input: parse, the node-handoff marker it appends, and
 *    every rejection (wrong kind, wrong phase, no plan, open question);
 *  - the node-handoff / planner-wake markers: model-facing (flattened to a
 *    user message), hidden from the transcript view, classified causes;
 *  - isLegacyTeachRecord: a record holding a plan_init call.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceEvent, PlanTree } from "../src/core/contracts.ts";
import { nodeHandoffText, roadRecord } from "../src/core/contracts.ts";
import { nextPlanNode } from "../src/core/plan-progress.ts";
import { KNOWLEDGE_PRIOR, type FactKnowledge } from "../src/core/knowledge.ts";
import { ChatInputError, inputAppends, parseChatInput } from "../src/core/input-events.ts";
import {
	isLegacyTeachRecord,
	nativeInputCause,
	newCoachCardMessage,
	newNodeHandoffMessage,
	newPlannerWakeMessage,
	newUserMessage,
	toLlmMessages,
	type LhMarkerMessage,
	type LhMessage,
	type NodeHandoffDetails,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

const known = (p: number): FactKnowledge => ({ p, attempts: 3, lastCorrect: true, misconception: false });

/** a → b, a → c, (b, c) → d; facts per node. */
const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "Modules", facts: [{ id: "fa1", graphId: "n_a1", statement: "A module is a file." }, { id: "fa2", graphId: "n_a2", statement: "Import runs a module once." }] },
		{ id: "b", title: "Packages", facts: [{ id: "fb1", graphId: "n_b1", statement: "A package is a folder of modules." }] },
		{ id: "c", title: "Paths", facts: [{ id: "fc1", graphId: "n_c1", statement: "sys.path lists import roots." }] },
		{ id: "d", title: "Apps", facts: [{ id: "fd1", graphId: "n_d1", statement: "An app imports its own package." }] },
	],
	edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }],
	arrows: [
		{ premises: ["fa1", "fa2"], conclusion: "fb1" },
		{ premises: ["fa1"], conclusion: "fa2" },
		{ premises: ["fb1"], conclusion: "fd1" },
	],
	version: 1,
};

describe("nextPlanNode", () => {
	it("is the first node in order with every prerequisite passed and itself unpassed", () => {
		assert.equal(nextPlanNode(TREE, new Map())?.id, "a", "nothing known: the root");
		const aPassed = new Map([["n_a1", known(0.9)], ["n_a2", known(0.86)]]);
		assert.equal(nextPlanNode(TREE, aPassed)?.id, "b");
		const abPassed = new Map([...aPassed, ["n_b1", known(0.95)]]);
		assert.equal(nextPlanNode(TREE, abPassed)?.id, "c", "d still waits for c");
		const abcPassed = new Map([...abPassed, ["n_c1", known(0.99)]]);
		assert.equal(nextPlanNode(TREE, abcPassed)?.id, "d");
		assert.equal(nextPlanNode(TREE, new Map([...abcPassed, ["n_d1", known(0.9)]])), null, "everything passed");
	});

	it("skips an already-passed node and never starts a node with an unpassed prerequisite", () => {
		// a is known from earlier sessions except one fact: a is next.
		assert.equal(nextPlanNode(TREE, new Map([["n_a1", known(0.9)]]))?.id, "a");
		// b passed but a did not: a comes first; c and d wait.
		assert.equal(nextPlanNode(TREE, new Map([["n_b1", known(0.9)]]))?.id, "a");
		// A node without facts never passes, so its dependants wait.
		const factless: PlanTree = { nodes: [{ id: "x", title: "X" }, { id: "y", title: "Y", facts: [{ id: "f", graphId: "n_f", statement: "F." }] }], edges: [{ from: "x", to: "y" }], version: 1 };
		assert.equal(nextPlanNode(factless, new Map())?.id, "x");
		assert.equal(nextPlanNode({ nodes: [], edges: [], version: 1 }, new Map()), null);
	});
});

describe("nodeHandoffText: the START layout", () => {
	it("map with prerequisites and position, facts with rounded numbers, arrows into this node's facts", () => {
		const knowledge = new Map([["n_a1", known(0.904)], ["n_b1", known(0.5)]]);
		assert.equal(
			nodeHandoffText({ tree: TREE, nodeId: "a", knowledge, first: true, road: [], lastCard: null }),
			[
				"[Node handoff] — written by the app, not the learner speaking.",
				"",
				"You are starting the first node of the plan.",
				"",
				"The map:",
				"- a: Modules  ← you are here",
				"- b: Packages (after: a)",
				"- c: Paths (after: a)",
				"- d: Apps (after: b, c)",
				"",
				"This node's facts (id — statement — how sure the app is that the learner knows it):",
				"- [fa1] A module is a file. — 90%",
				`- [fa2] Import runs a module once. — ${Math.round(KNOWLEDGE_PRIOR * 100)}%`,
				"",
				"Arrows into these facts (premises ⇒ conclusion):",
				"- A module is a file. ⇒ Import runs a module once.",
			].join("\n"),
		);
	});

	it("joins several premises with ' + ' and omits the arrows section when none point in", () => {
		const start = (nodeId: string) => nodeHandoffText({ tree: TREE, nodeId, knowledge: new Map(), first: true, road: [], lastCard: null });
		const b = start("b");
		assert.ok(b.includes("- b: Packages (after: a)  ← you are here"));
		assert.ok(b.includes("- A module is a file. + Import runs a module once. ⇒ A package is a folder of modules."));
		const c = start("c");
		assert.ok(!c.includes("Arrows into these facts"));
		assert.ok(c.endsWith("- [fc1] sys.path lists import roots. — 30%"));
	});
});

// ─── the plan-accept input ───────────────────────────────────────────────────

function assistantCall(id: string, name: string, args: unknown): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args as never }],
		api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1,
	} as never;
}

function toolResult(id: string, callId: string, name: string, details: unknown): LhMessage {
	return { id, role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: 2 } as never;
}

const probeDone = (): LhMessage[] => [
	assistantCall("p", "probe_done", { assessment: { strands: [], summary: "s" } }),
	toolResult("pr", "call_p", "probe_done", { ok: true }),
];

const planned = (): LhMessage[] => [
	...probeDone(),
	assistantCall("plan", "plan_batch", { nodes: [] }),
	toolResult("planr", "call_plan", "plan_batch", { ok: true, tree: TREE }),
];

function rejects(fn: () => unknown, needle: RegExp): void {
	assert.throws(fn, (err: unknown) => err instanceof ChatInputError && needle.test(err.message));
}

describe("the plan-accept input", () => {
	it("parses with no fields", () => {
		assert.deepEqual(parseChatInput({ type: "plan-accept" }), { type: "plan-accept" });
	});

	it("appends ONE node-handoff marker for the first node to teach, filled from the evidence", () => {
		const knowledge = new Map([["n_a1", known(0.9)], ["n_a2", known(0.9)]]);
		const appends = inputAppends({ messages: planned(), tree: TREE }, { type: "plan-accept" }, { knowledge });
		assert.equal(appends.length, 1);
		const marker = appends[0] as LhMarkerMessage;
		assert.equal(marker.role, "custom");
		assert.equal(marker.customType, "node-handoff");
		assert.equal(marker.display, false);
		assert.deepEqual(marker.details as NodeHandoffDetails, { nodeId: "b", firstKeptMessageId: null }, "a passed root is skipped");
		assert.equal(marker.content, nodeHandoffText({ tree: TREE, nodeId: "b", knowledge, first: true, road: [], lastCard: null }));
		// No knowledge given: every fact reads the prior — the root starts.
		const fresh = inputAppends({ messages: planned(), kind: "teach", tree: TREE }, { type: "plan-accept" })[0] as LhMarkerMessage;
		assert.equal((fresh.details as NodeHandoffDetails).nodeId, "a");
	});

	it("is rejected outside a waiting plan: other kinds, the probe, an accepted plan, no plan, an open question", () => {
		const input = { type: "plan-accept" } as const;
		rejects(() => inputAppends({ messages: planned(), kind: "practice", tree: TREE }, input), /teaching-session affordance/);
		rejects(() => inputAppends({ messages: planned(), kind: "build", tree: TREE }, input), /teaching-session affordance/);
		rejects(() => inputAppends({ messages: [], tree: TREE }, input), /plan waiting for acceptance/);
		const accepted = [...planned(), newNodeHandoffMessage("a", "[Node handoff] x") as LhMessage];
		rejects(() => inputAppends({ messages: accepted, tree: TREE }, input), /plan waiting for acceptance/);
		rejects(() => inputAppends({ messages: probeDone() }, input), /requires a stored plan/);
		rejects(() => inputAppends({ messages: probeDone(), tree: { nodes: [], edges: [], version: 1 } }, input), /requires a stored plan/);
		const openQuestion = [...planned(), assistantCall("q", "ask_user_question", { question: "Which part?", options: [{ label: "A" }, { label: "B" }] })];
		rejects(() => inputAppends({ messages: openQuestion, tree: TREE }, input), /no open question/);
	});
});

describe("the plan-accept input mid-lesson (after a planner-wake)", () => {
	const ev = (nodeId: string, correct: boolean, at: string): EvidenceEvent => ({ nodeId, chatId: "c", messageId: "", at, source: "quiz", correct, guess: 0.25 });
	const card = (text: string) => newCoachCardMessage(text, { phase: "teach", nodeId: "a", notes: [], askLearner: null }) as LhMessage;

	it("appends the CONTINUE handoff: the road record and the coach's latest card since the previous handoff", () => {
		const knowledge = new Map([["n_a1", known(0.9)], ["n_a2", known(0.9)]]);
		const events = [ev("n_a1", false, "2026-01-01"), ev("n_a1", true, "2026-01-02"), ev("n_a2", true, "2026-01-03")];
		const messages = [
			...planned(),
			card("[Coach card] from the probe"),
			newNodeHandoffMessage("a", "[Node handoff] a") as LhMessage,
			card("[Coach card] older"),
			card("[Coach card] newest"),
			newPlannerWakeMessage("[Planner brief] next stretch") as LhMessage,
		];
		const appends = inputAppends({ messages, kind: "teach", tree: TREE }, { type: "plan-accept" }, { knowledge, events });
		assert.equal(appends.length, 1);
		const marker = appends[0] as LhMarkerMessage;
		assert.equal(marker.customType, "node-handoff");
		assert.deepEqual(marker.details, { nodeId: "b", firstKeptMessageId: null });
		assert.equal(marker.content, nodeHandoffText({
			tree: TREE, nodeId: "b", knowledge, first: false,
			road: roadRecord(TREE, events, knowledge, "b"), lastCard: "[Coach card] newest",
		}));
		assert.ok(marker.content.includes("You are starting the next node of the plan."));
		assert.ok(marker.content.includes("The road so far:\n- Modules: passed; needed more than one try: A module is a file."));
		assert.ok(marker.content.endsWith("The coach's last card:\n[Coach card] newest"));
	});

	it("carries no card from before the previous handoff, and an empty road reads as no section", () => {
		const messages = [...planned(), card("[Coach card] stale"), newNodeHandoffMessage("a", "[Node handoff] a") as LhMessage, newPlannerWakeMessage("[Planner brief]") as LhMessage];
		const marker = inputAppends({ messages, tree: TREE }, { type: "plan-accept" })[0] as LhMarkerMessage;
		assert.equal((marker.details as NodeHandoffDetails).nodeId, "a", "nothing passed: the root again");
		assert.ok(marker.content.includes("the next node of the plan."));
		assert.ok(!marker.content.includes("The coach's last card"));
		assert.ok(!marker.content.includes("The road so far"), "the road before the root is empty");
	});

	it("is rejected when no node is left to teach", () => {
		const all = new Map(["n_a1", "n_a2", "n_b1", "n_c1", "n_d1"].map((id) => [id, known(0.95)]));
		const messages = [...planned(), newNodeHandoffMessage("d", "[Node handoff] d") as LhMessage, newPlannerWakeMessage("[Planner brief]") as LhMessage];
		rejects(() => inputAppends({ messages, tree: TREE }, { type: "plan-accept" }, { knowledge: all }), /no plan node left to teach/);
	});
});

describe("the node-handoff and planner-wake markers", () => {
	it("flatten to user-role model text and stay out of the learner's transcript", () => {
		const handoff = newNodeHandoffMessage("a", "[Node handoff] the text") as LhMessage;
		const wake = newPlannerWakeMessage("[Planner wake] the text") as LhMessage;
		const user = newUserMessage("hello") as LhMessage;
		const llm = toLlmMessages([user, handoff, wake] as never);
		assert.deepEqual(llm.map((m) => m.role), ["user", "user", "user"]);
		assert.deepEqual((llm[1]!.content as Array<{ text: string }>)[0]!.text, "[Node handoff] the text");
		assert.deepEqual((llm[2]!.content as Array<{ text: string }>)[0]!.text, "[Planner wake] the text");
		const view = projectView([user, handoff, wake]);
		assert.deepEqual(view.map((m) => m.id), [user.id], "no transcript card for either marker");
		assert.equal((wake as LhMarkerMessage).display, false);
	});

	it("classify as a learner cause (the handoff) and neutral (the wake) — never unrecognizable", () => {
		assert.equal(nativeInputCause(newNodeHandoffMessage("a", "x") as never, []), "learner");
		assert.equal(nativeInputCause(newPlannerWakeMessage("x") as never, []), "neutral");
	});
});

describe("the coach-card marker", () => {
	it("is hidden from the learner, flattens to user-role model text, and classifies neutral", () => {
		const details = { phase: "teach" as const, nodeId: "a", notes: ["Slow down."], askLearner: null };
		const marker = newCoachCardMessage("[Coach card] the text", details);
		assert.equal(marker.role, "custom");
		assert.equal(marker.customType, "coach-card");
		assert.equal(marker.display, false);
		assert.deepEqual(marker.details, details);
		const user = newUserMessage("hello") as LhMessage;
		const llm = toLlmMessages([user, marker] as never);
		assert.deepEqual(llm.map((m) => m.role), ["user", "user"]);
		assert.equal((llm[1]!.content as Array<{ text: string }>)[0]!.text, "[Coach card] the text");
		assert.deepEqual(projectView([user, marker as LhMessage]).map((m) => m.id), [user.id]);
		assert.equal(nativeInputCause(marker as never, []), "neutral");
	});
});

describe("isLegacyTeachRecord", () => {
	it("is true exactly when the transcript holds a plan_init tool call", () => {
		assert.equal(isLegacyTeachRecord([]), false);
		assert.equal(isLegacyTeachRecord(planned()), false, "plan_batch records are current");
		assert.equal(isLegacyTeachRecord([...probeDone(), assistantCall("old", "plan_init", { mermaid: "graph TD\n a[A]" })]), true);
		assert.equal(isLegacyTeachRecord([newUserMessage("plan_init") as LhMessage]), false, "prose naming the tool is not a call");
	});
});
