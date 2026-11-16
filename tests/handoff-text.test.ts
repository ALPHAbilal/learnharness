/**
 * The handoff templates (coach-planner design §4.6/§4.7, contracts/
 * handoff.ts) — exact layouts:
 *
 *  - roadRecord: one entry per node before the given one, passed flag and
 *    the facts that drew a wrong or "I don't know" answer;
 *  - nodeHandoffText: START and CONTINUE, every optional section and its
 *    omission;
 *  - plannerBriefText and coachCardText: full and minimal layouts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceEvent, PlanTree } from "../src/core/contracts.ts";
import { coachCardText, nodeHandoffText, plannerBriefText, roadRecord } from "../src/core/contracts.ts";
import { nodeHandoffText as fromPlanPath } from "../src/core/contracts/plan.ts";
import type { FactKnowledge } from "../src/core/knowledge.ts";

const state = (p: number, misconception = false): FactKnowledge => ({ p, attempts: 2, lastCorrect: !misconception, misconception });

/** a → b, (a, b) → c. */
const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "Modules", facts: [
			{ id: "fa1", graphId: "n_a1", statement: "A module is a file." },
			{ id: "fa2", graphId: "n_a2", statement: "Import runs a module once." },
		] },
		{ id: "b", title: "Packages", facts: [{ id: "fb1", graphId: "n_b1", statement: "A package is a folder." }] },
		{ id: "c", title: "Apps", facts: [
			{ id: "fc1", graphId: "n_c1", statement: "An app imports its package." },
			{ id: "fc2", graphId: "n_c2", statement: "The app runs from its root." },
		] },
	],
	edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "c" }],
	arrows: [
		{ premises: ["fa1", "fa2"], conclusion: "fb1" },
		{ premises: ["fb1"], conclusion: "fc1" },
		{ premises: ["fa1", "fc1"], conclusion: "fc2" },
	],
	version: 3,
};

const KNOWLEDGE = new Map([
	["n_a1", state(0.9)],
	["n_a2", state(0.884)],
	["n_b1", state(0.6)],
	["n_c2", state(0.724, true)],
]);

const ev = (nodeId: string, correct: boolean, extra: Partial<EvidenceEvent> = {}): EvidenceEvent =>
	({ nodeId, chatId: "c1", messageId: "", at: "2026-11-15T00:00:00.000Z", source: "quiz", correct, guess: 0.25, ...extra });

const EVENTS: EvidenceEvent[] = [
	ev("n_a1", false),
	ev("n_a1", true),
	ev("n_a2", true),
	ev("n_b1", false, { dontKnow: true }),
	ev("n_elsewhere", false),
];

describe("roadRecord", () => {
	it("lists every node before the given one, in tree order, with passed and the hard facts", () => {
		assert.deepEqual(roadRecord(TREE, EVENTS, KNOWLEDGE, "c"), [
			{ nodeId: "a", title: "Modules", passed: true, hardFacts: ["A module is a file."] },
			{ nodeId: "b", title: "Packages", passed: false, hardFacts: ["A package is a folder."] },
		]);
	});

	it("counts an \"I don't know\" as hard even when marked correct, and ignores events about other facts", () => {
		const road = roadRecord(TREE, [ev("n_a2", true, { dontKnow: true }), ev("n_c1", false)], new Map(), "b");
		assert.deepEqual(road, [{ nodeId: "a", title: "Modules", passed: false, hardFacts: ["Import runs a module once."] }]);
	});

	it("is empty for the first node and for a node not in the tree", () => {
		assert.deepEqual(roadRecord(TREE, EVENTS, KNOWLEDGE, "a"), []);
		assert.deepEqual(roadRecord(TREE, EVENTS, KNOWLEDGE, "gone"), []);
	});
});

describe("nodeHandoffText", () => {
	it("CONTINUE: every section, in order", () => {
		const text = nodeHandoffText({
			tree: TREE,
			nodeId: "c",
			knowledge: KNOWLEDGE,
			first: false,
			road: roadRecord(TREE, EVENTS, KNOWLEDGE, "c"),
			lastCard: "[Coach card] — written by the app from the coach's review, not the learner speaking.\n\nNotes:\n- Go slower.",
		});
		assert.equal(text, [
			"[Node handoff] — written by the app, not the learner speaking.",
			"",
			"You are starting the next node of the plan.",
			"",
			"The map:",
			"- a: Modules  ✓ passed",
			"- b: Packages (after: a)",
			"- c: Apps (after: a, b)  ← you are here",
			"",
			"This node's facts (id — statement — how sure the app is that the learner knows it):",
			"- [fc1] An app imports its package. — 30%",
			"- [fc2] The app runs from its root. — 72%  ⚠ answered wrong with high confidence",
			"",
			"Arrows into these facts (premises ⇒ conclusion):",
			"- A package is a folder. ⇒ An app imports its package.",
			"- A module is a file. + An app imports its package. ⇒ The app runs from its root.",
			"",
			"What the learner already holds underneath (facts these stand on, from other nodes):",
			"- A module is a file. — 90%",
			"- A package is a folder. — 60%",
			"",
			"The road so far:",
			"- Modules: passed; needed more than one try: A module is a file.",
			"- Packages: not passed; needed more than one try: A package is a folder.",
			"",
			"The coach's last card:",
			"[Coach card] — written by the app from the coach's review, not the learner speaking.",
			"",
			"Notes:",
			"- Go slower.",
		].join("\n"));
	});

	it("START never shows the road or the card, even when given", () => {
		const text = nodeHandoffText({ tree: TREE, nodeId: "b", knowledge: KNOWLEDGE, first: true, road: roadRecord(TREE, EVENTS, KNOWLEDGE, "b"), lastCard: "[Coach card] x" });
		assert.equal(text, [
			"[Node handoff] — written by the app, not the learner speaking.",
			"",
			"You are starting the first node of the plan.",
			"",
			"The map:",
			"- a: Modules  ✓ passed",
			"- b: Packages (after: a)  ← you are here",
			"- c: Apps (after: a, b)",
			"",
			"This node's facts (id — statement — how sure the app is that the learner knows it):",
			"- [fb1] A package is a folder. — 60%",
			"",
			"Arrows into these facts (premises ⇒ conclusion):",
			"- A module is a file. + Import runs a module once. ⇒ A package is a folder.",
			"",
			"What the learner already holds underneath (facts these stand on, from other nodes):",
			"- A module is a file. — 90%",
			"- Import runs a module once. — 88%",
		].join("\n"));
	});

	it("omits every empty section, heading included", () => {
		const bare: PlanTree = { nodes: [{ id: "x", title: "X" }], edges: [], version: 1 };
		const expected = [
			"[Node handoff] — written by the app, not the learner speaking.",
			"",
			"You are starting the next node of the plan.",
			"",
			"The map:",
			"- x: X  ← you are here",
		].join("\n");
		assert.equal(nodeHandoffText({ tree: bare, nodeId: "x", knowledge: new Map(), first: false, road: [], lastCard: null }), expected);
		assert.equal(nodeHandoffText({ tree: bare, nodeId: "x", knowledge: new Map(), first: false, road: [], lastCard: "" }), expected, "an empty card is no card");
		// Facts whose arrows have only own premises: no "underneath" section.
		const a = nodeHandoffText({ tree: { ...TREE, arrows: [{ premises: ["fa1"], conclusion: "fa2" }] }, nodeId: "a", knowledge: new Map(), first: true, road: [], lastCard: null });
		assert.ok(a.endsWith("Arrows into these facts (premises ⇒ conclusion):\n- A module is a file. ⇒ Import runs a module once."));
		assert.ok(!a.includes("underneath"));
	});

	it("is still importable from the plan contract's path", () => {
		assert.equal(fromPlanPath, nodeHandoffText);
	});
});

describe("plannerBriefText", () => {
	it("every section, in order", () => {
		const text = plannerBriefText({
			goal: "teach me python imports",
			assessment: { strands: [{ strand: "imports", assessment: "Floor: none." }, { strand: "files", assessment: "Knows paths." }], summary: "Start at modules." },
			tree: TREE,
			knowledge: KNOWLEDGE,
			road: roadRecord(TREE, EVENTS, KNOWLEDGE, "c"),
			notes: ["He confuses packages with folders.", "Typed code goes well."],
		});
		assert.equal(text, [
			"[Planner brief] — written by the app, not the learner speaking.",
			"",
			"The next stretch of the road is needed. Plan at most 4 more nodes with plan_batch, continuing from the map below.",
			"",
			"Goal (the learner's own words):",
			"teach me python imports",
			"",
			"The prober's assessment:",
			"- imports: Floor: none.",
			"- files: Knows paths.",
			"Summary: Start at modules.",
			"",
			"The map so far (node — its facts with their graph id and how sure the app is):",
			"- a: Modules  ✓ passed",
			"  - [fa1] (n_a1) A module is a file. — 90%",
			"  - [fa2] (n_a2) Import runs a module once. — 88%",
			"- b: Packages (after: a)",
			"  - [fb1] (n_b1) A package is a folder. — 60%",
			"- c: Apps (after: a, b)",
			"  - [fc1] (n_c1) An app imports its package. — 30%",
			"  - [fc2] (n_c2) The app runs from its root. — 72%",
			"",
			"The road so far:",
			"- Modules: passed; needed more than one try: A module is a file.",
			"- Packages: not passed; needed more than one try: A package is a folder.",
			"",
			"The coach's notes:",
			"- He confuses packages with folders.",
			"- Typed code goes well.",
		].join("\n"));
	});

	it("omits every empty section; a summary alone keeps the assessment heading", () => {
		const base = { goal: "", assessment: null, tree: null, knowledge: new Map(), road: [], notes: [] };
		assert.equal(plannerBriefText(base), [
			"[Planner brief] — written by the app, not the learner speaking.",
			"",
			"The next stretch of the road is needed. Plan at most 4 more nodes with plan_batch, continuing from the map below.",
		].join("\n"));
		assert.ok(plannerBriefText({ ...base, assessment: { strands: [], summary: "S." } }).endsWith("The prober's assessment:\nSummary: S."));
		assert.ok(!plannerBriefText({ ...base, assessment: { strands: [] }, tree: { nodes: [], edges: [], version: 1 } }).includes("The prober's assessment"));
		assert.ok(!plannerBriefText({ ...base, tree: { nodes: [], edges: [], version: 1 } }).includes("The map so far"));
	});
});

describe("coachCardText", () => {
	it("probe: every section", () => {
		assert.equal(coachCardText({
			phase: "probe",
			facts: [
				{ id: "f1", statement: "A module is a file.", p: 0.3, misconception: false },
				{ id: "f2", statement: "Import runs once.", p: 0.115, misconception: true },
			],
			notes: ["He guesses fast."],
			askLearner: "What does `import` do the second time?",
		}), [
			"[Coach card] — written by the app from the coach's review, not the learner speaking.",
			"",
			"Facts to test (id — statement — how sure the app is that the learner knows it):",
			"- [f1] A module is a file. — 30%",
			"- [f2] Import runs once. — 12%  ⚠ answered wrong with high confidence",
			"",
			"Notes:",
			"- He guesses fast.",
			"",
			"Ask the learner: What does `import` do the second time?",
		].join("\n"));
	});

	it("teach: the node heading; empty sections and a null question are omitted", () => {
		assert.equal(coachCardText({ phase: "teach", facts: [{ id: "f1", statement: "S.", p: 0.856, misconception: false }], notes: [], askLearner: null }), [
			"[Coach card] — written by the app from the coach's review, not the learner speaking.",
			"",
			"This node's facts (id — statement — how sure the app is that the learner knows it):",
			"- [f1] S. — 86%",
		].join("\n"));
		assert.equal(coachCardText({ phase: "teach", facts: [], notes: [], askLearner: null }),
			"[Coach card] — written by the app from the coach's review, not the learner speaking.");
	});
});
