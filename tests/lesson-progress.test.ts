/**
 * The lesson progress payload (coach-planner design §4.10) — pure pins of
 * lessonProgress (every field, legacy, practice/build), hidesCoverage and
 * usesLessonStatuses, plus the view seam it travels with: the coach's
 * plan-update marker projects to a non-rendered part, and the other hidden
 * markers project to nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceEvent, PlanTree } from "../src/core/contracts.ts";
import { hidesCoverage, lessonProgress, usesLessonStatuses, type LessonProgress } from "../src/core/lesson-progress.ts";
import { KNOWLEDGE_PRIOR } from "../src/core/knowledge.ts";
import {
	newCoachCardMessage,
	newNodeHandoffMessage,
	newPlannerWakeMessage,
	newPlanUpdateMessage,
	newUserMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "Modules", facts: [{ id: "fa1", graphId: "n_a1", statement: "A module is a file." }, { id: "fa2", graphId: "n_a2", statement: "Import runs a module once." }] },
		{ id: "b", title: "Packages", facts: [{ id: "fb1", graphId: "n_b1", statement: "A package is a folder of modules." }] },
	],
	edges: [{ from: "a", to: "b" }],
	version: 1,
};

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
/** One passed code question: 0.30 → 0.89 (design §4.3). */
const pass = (nodeId: string, at: string): EvidenceEvent => ({ nodeId, chatId: "c", messageId: "", at, source: "code", correct: true, guess: 0.05 });
const confidentlyWrong = (nodeId: string, at: string): EvidenceEvent => ({ nodeId, chatId: "c", messageId: "", at, source: "quiz", correct: false, guess: 0.25, confidence: 95 });

describe("lessonProgress", () => {
	it("practice and build sessions carry no lesson: agentKind null, nothing else", () => {
		for (const kind of ["practice", "build"] as const) {
			assert.deepEqual(lessonProgress({ kind, messages: planned(), tree: TREE }, [pass("n_a1", "1")]), {
				agentKind: null, legacy: false, canAcceptPlan: false, currentNodeId: null, nodes: {}, facts: {},
			});
		}
	});

	it("the probe: prober, nothing to accept, no plan", () => {
		const p = lessonProgress({ messages: [newUserMessage("teach me flask") as LhMessage] }, []);
		assert.equal(p.agentKind, "prober");
		assert.equal(p.legacy, false);
		assert.equal(p.canAcceptPlan, false);
		assert.equal(p.currentNodeId, null);
		assert.deepEqual(p.nodes, {});
	});

	it("a presented plan: planner, Start offered; every node and fact with its number", () => {
		const events = [pass("n_a1", "2026-01-01"), confidentlyWrong("n_b1", "2026-01-02")];
		const p = lessonProgress({ kind: "teach", messages: planned(), tree: TREE }, events);
		assert.equal(p.agentKind, "planner");
		assert.equal(p.canAcceptPlan, true);
		assert.equal(p.currentNodeId, null);
		assert.deepEqual(p.nodes, { a: { passed: false, progress: 0.5 }, b: { passed: false, progress: 0 } });
		assert.ok(Math.abs(p.facts.fa1!.p - 0.885) < 0.001, "one passed code question");
		assert.equal(p.facts.fa1!.attempts, 1);
		assert.deepEqual(p.facts.fa2, { p: KNOWLEDGE_PRIOR, attempts: 0, misconception: false }, "no evidence reads the prior");
		assert.equal(p.facts.fb1!.misconception, true, "wrong with confidence ≥ 90");
	});

	it("Start is withheld while a turn runs, a question is open, the plan is accepted, or nothing is left", () => {
		const record = { messages: planned(), tree: TREE };
		assert.equal(lessonProgress(record, [], { turnRunning: true }).canAcceptPlan, false);
		const open = [...planned(), assistantCall("q", "ask_user_question", { question: "Which?", options: [{ label: "A" }, { label: "B" }] })];
		assert.equal(lessonProgress({ messages: open, tree: TREE }, []).canAcceptPlan, false);
		assert.equal(lessonProgress({ messages: probeDone() }, []).canAcceptPlan, false, "no stored plan");
		const everything = [pass("n_a1", "1"), pass("n_a2", "2"), pass("n_b1", "3")];
		assert.equal(lessonProgress(record, everything).canAcceptPlan, false, "every node passed");
		const accepted = [...planned(), newNodeHandoffMessage("a", "[Node handoff] a") as LhMessage];
		const teaching = lessonProgress({ messages: accepted, tree: TREE }, [pass("n_a1", "1"), pass("n_a2", "2")]);
		assert.equal(teaching.agentKind, "teacher");
		assert.equal(teaching.canAcceptPlan, false);
		assert.equal(teaching.currentNodeId, "a", "the latest node-handoff");
		assert.deepEqual(teaching.nodes.a, { passed: true, progress: 1 });
	});

	it("after a planner-wake the next batch waits for Start again", () => {
		const messages = [...planned(), newNodeHandoffMessage("a", "[Node handoff] a") as LhMessage, newPlannerWakeMessage("[Planner brief]") as LhMessage];
		const p = lessonProgress({ messages, tree: TREE }, [pass("n_a1", "1"), pass("n_a2", "2")]);
		assert.equal(p.agentKind, "planner");
		assert.equal(p.canAcceptPlan, true);
		assert.equal(p.currentNodeId, "a");
	});

	it("legacy: a record holding a plan_init call is flagged and never offers Start", () => {
		const messages = [...probeDone(), assistantCall("old", "plan_init", { mermaid: "graph TD" }), toolResult("oldr", "call_old", "plan_init", { ok: true, tree: TREE })];
		const p = lessonProgress({ kind: "teach", messages, tree: TREE }, []);
		assert.equal(p.legacy, true);
		assert.equal(p.canAcceptPlan, false);
	});
});

describe("hidesCoverage / usesLessonStatuses", () => {
	const base: LessonProgress = { agentKind: "teacher", legacy: false, canAcceptPlan: false, currentNodeId: null, nodes: {}, facts: {} };
	it("coverage hides for coach-design teach sessions only", () => {
		assert.equal(hidesCoverage(base), true);
		assert.equal(hidesCoverage({ ...base, agentKind: "prober" }), true);
		assert.equal(hidesCoverage({ ...base, legacy: true }), false, "legacy teach sessions keep it");
		assert.equal(hidesCoverage({ ...base, agentKind: null }), false, "practice/build/sources keep it");
		assert.equal(hidesCoverage(null), false);
		assert.equal(hidesCoverage(undefined), false);
	});
	it("lesson statuses apply with a current node or facts in the tree, never on legacy", () => {
		const bare: PlanTree = { nodes: [{ id: "x", title: "X" }], edges: [], version: 1 };
		assert.equal(usesLessonStatuses(TREE, base), true, "facts in the tree");
		assert.equal(usesLessonStatuses(bare, base), false);
		assert.equal(usesLessonStatuses(bare, { ...base, currentNodeId: "x" }), true);
		assert.equal(usesLessonStatuses(TREE, { ...base, legacy: true }), false);
		assert.equal(usesLessonStatuses(TREE, null), false);
	});
});

describe("the view seam: hidden coach markers", () => {
	it("plan-update projects to a non-rendered data-plan-update part carrying the tree, without splitting the group", () => {
		const changed: PlanTree = { ...TREE, nodes: [...TREE.nodes, { id: "c", title: "Paths", origin: "coach" }], version: 2 };
		const view = projectView([...planned(), newPlanUpdateMessage(changed) as LhMessage]);
		const assistants = view.filter((m) => m.role === "assistant");
		assert.equal(assistants.length, 1, "no new group");
		const part = assistants[0]!.parts.at(-1)!;
		assert.equal(part.type, "data-plan-update");
		assert.deepEqual((part.data as { tree: PlanTree }).tree, changed);
	});

	it("plan-update with nothing before it rides a data-only message", () => {
		const view = projectView([newPlanUpdateMessage(TREE) as LhMessage]);
		assert.equal(view.length, 1);
		assert.deepEqual(view[0]!.parts.map((p) => p.type), ["data-plan-update"]);
	});

	it("node-handoff, planner-wake and coach-card project to nothing", () => {
		const before = projectView(planned());
		const after = projectView([
			...planned(),
			newNodeHandoffMessage("a", "[Node handoff] a") as LhMessage,
			newCoachCardMessage("[Coach card] x", { phase: "teach", nodeId: "a", notes: [], askLearner: null }) as LhMessage,
			newPlannerWakeMessage("[Planner brief]") as LhMessage,
		]);
		assert.deepEqual(after, before);
	});
});
