/**
 * Applying the mentor's review (coach-planner design §4.5): every rule of
 * core/mentor-apply.ts applyReview, and the handoff to a node the review
 * inserted before the current one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceEvent, PlanTree } from "../src/core/contracts.ts";
import type { MentorReview } from "../src/core/contracts/mentor.ts";
import type { AnsweredQuestion } from "../src/core/evidence.ts";
import { applyReview, insertedNodeHandoff } from "../src/core/mentor-apply.ts";
import type { NodeHandoffDetails } from "../src/core/native-messages.ts";

const review = (over: Partial<MentorReview> = {}): MentorReview => ({
	notes: [], judged: [], addFacts: [], addArrows: [], addNodes: [], askLearner: null, ...over,
});

const answered = (tool: string, facts: string[]): AnsweredQuestion => ({
	messageId: "r1", tool, input: { question: "q", facts },
	answer: { kind: tool === "quiz" ? "quiz" : "explain", questionText: "q", dontKnow: false, answers: [], answeredAt: "2026-11-15T00:00:00.000Z" },
});

const TREE: PlanTree = {
	nodes: [
		{ id: "modules", title: "Modules", facts: [{ id: "module-file", graphId: "n_mod", statement: "A module is a file." }], batch: 1, origin: "planner" },
		{ id: "routes", title: "Routes", facts: [{ id: "route-maps", graphId: "n_route", statement: "A route maps a URL." }], batch: 1, origin: "planner" },
	],
	edges: [{ from: "modules", to: "routes" }],
	arrows: [{ premises: ["module-file"], conclusion: "route-maps" }],
	version: 3,
};

const IDS = { "url-parts": "n_url", "url-node-fact": "n_unf", "path-fact": "n_path" };

describe("applyReview — verdicts", () => {
	it("no review: nothing changes", () => {
		const plan = applyReview({ phase: "teach", review: null, tree: TREE, probeFacts: undefined, currentNodeId: "routes", latest: answered("explain", ["route-maps"]) });
		assert.deepEqual([plan.judged, plan.plannedFacts, plan.plannedArrows, plan.problem], [[], [], [], null]);
		assert.deepEqual(plan.build({}), { insertedNodeIds: [] });
	});

	it("judged counts for own-words answers only, for tagged facts only, once per fact", () => {
		const r = review({ judged: [{ factId: "route-maps", correct: true }, { factId: "module-file", correct: true }, { factId: "route-maps", correct: false }] });
		for (const tool of ["explain", "recall"]) {
			assert.deepEqual(applyReview({ phase: "teach", review: r, tree: TREE, probeFacts: undefined, currentNodeId: "routes", latest: answered(tool, ["route-maps"]) }).judged, [{ factId: "route-maps", correct: true }]);
		}
		assert.deepEqual(applyReview({ phase: "teach", review: r, tree: TREE, probeFacts: undefined, currentNodeId: "routes", latest: answered("quiz", ["route-maps"]) }).judged, [], "an app-graded answer keeps the app's verdict");
		assert.deepEqual(applyReview({ phase: "teach", review: r, tree: TREE, probeFacts: undefined, currentNodeId: "routes", latest: null }).judged, []);
	});
});

describe("applyReview — the probe", () => {
	const probeFacts = { facts: [{ id: "py-functions", graphId: "n_fn", statement: "A function returns a value." }], arrows: [] };

	it("added facts and arrows join the probe list; arrows are deduplicated; nodes are ignored", () => {
		const r = review({
			addFacts: [{ id: "url-parts", name: "URL parts", statement: "A URL has a path." }, { id: "path-fact", name: "Paths", statement: "A path names a resource.", existing: "n_existing" }],
			addArrows: [{ premises: ["py-functions"], conclusion: "url-parts" }, { premises: ["py-functions"], conclusion: "url-parts" }, { premises: ["url-parts"], conclusion: "path-fact" }],
			addNodes: [{ id: "ignored", title: "Ignored", facts: [{ id: "x", name: "X", statement: "X." }] }],
		});
		const plan = applyReview({ phase: "probe", review: r, tree: undefined, probeFacts, currentNodeId: null, latest: answered("ask_user_question", []) });
		assert.equal(plan.problem, null);
		assert.deepEqual(plan.plannedFacts, [
			{ id: "url-parts", name: "URL parts", statement: "A URL has a path." },
			{ id: "path-fact", name: "Paths", statement: "A path names a resource.", existing: "n_existing" },
		]);
		assert.deepEqual(plan.plannedArrows, [{ premises: ["n_fn"], conclusion: "url-parts" }, { premises: ["url-parts"], conclusion: "path-fact" }], "known facts by graph id, new ones by slug");
		const built = plan.build({ "url-parts": "n_url", "path-fact": "n_existing" });
		assert.equal(built.tree, undefined);
		assert.deepEqual(built.insertedNodeIds, []);
		assert.deepEqual(built.probeFacts, {
			facts: [
				{ id: "py-functions", graphId: "n_fn", statement: "A function returns a value." },
				{ id: "url-parts", graphId: "n_url", statement: "A URL has a path.", minted: true },
				{ id: "path-fact", graphId: "n_existing", statement: "A path names a resource.", minted: false },
			],
			arrows: [{ premises: ["py-functions"], conclusion: "url-parts" }, { premises: ["url-parts"], conclusion: "path-fact" }],
		});
	});

	it("starts the probe list when there is none; an arrow already on the list adds nothing", () => {
		const first = applyReview({ phase: "probe", review: review({ addFacts: [{ id: "a", name: "A", statement: "A." }] }), tree: undefined, probeFacts: undefined, currentNodeId: null, latest: null });
		assert.deepEqual(first.build({ a: "n_a" }).probeFacts, { facts: [{ id: "a", graphId: "n_a", statement: "A.", minted: true }], arrows: [] });
		const withArrow = { facts: [{ id: "a", graphId: "n_a", statement: "A." }, { id: "b", graphId: "n_b", statement: "B." }], arrows: [{ premises: ["a"], conclusion: "b" }] };
		const same = applyReview({ phase: "probe", review: review({ addArrows: [{ premises: ["a"], conclusion: "b" }] }), tree: undefined, probeFacts: withArrow, currentNodeId: null, latest: null });
		assert.deepEqual([same.plannedFacts, same.plannedArrows], [[], []]);
		assert.deepEqual(same.build({}), { insertedNodeIds: [] });
	});

	it("an invalid probe list (a cycle) drops the additions but keeps the verdicts", () => {
		const list = { facts: [{ id: "a", graphId: "n_a", statement: "A." }, { id: "b", graphId: "n_b", statement: "B." }], arrows: [{ premises: ["a"], conclusion: "b" }] };
		const plan = applyReview({ phase: "probe", review: review({ judged: [{ factId: "a", correct: true }], addArrows: [{ premises: ["b"], conclusion: "a" }] }), tree: undefined, probeFacts: list, currentNodeId: null, latest: answered("recall", ["a"]) });
		assert.match(plan.problem!, /would create a cycle/);
		assert.deepEqual([plan.plannedFacts, plan.plannedArrows], [[], []]);
		assert.deepEqual(plan.judged, [{ factId: "a", correct: true }]);
		assert.deepEqual(plan.build({}), { insertedNodeIds: [] });
	});
});

describe("applyReview — a node", () => {
	it("added facts join the CURRENT node and added arrows the tree; the version ticks", () => {
		const r = review({
			addFacts: [{ id: "url-parts", name: "URL parts", statement: "A URL has a path." }],
			addArrows: [{ premises: ["url-parts"], conclusion: "route-maps" }, { premises: ["module-file"], conclusion: "route-maps" }],
		});
		const plan = applyReview({ phase: "teach", review: r, tree: TREE, probeFacts: undefined, currentNodeId: "routes", latest: answered("quiz", ["route-maps"]) });
		assert.equal(plan.problem, null);
		assert.deepEqual(plan.plannedArrows, [{ premises: ["url-parts"], conclusion: "n_route" }], "the arrow already in the tree is not rewritten");
		const { tree, insertedNodeIds } = plan.build(IDS);
		assert.deepEqual(insertedNodeIds, []);
		assert.equal(tree!.version, 4);
		assert.deepEqual(tree!.nodes[1]!.facts, [
			{ id: "route-maps", graphId: "n_route", statement: "A route maps a URL." },
			{ id: "url-parts", graphId: "n_url", statement: "A URL has a path.", minted: true },
		]);
		assert.deepEqual(tree!.nodes[0], TREE.nodes[0], "other nodes are untouched");
		assert.deepEqual(tree!.arrows, [...TREE.arrows!, { premises: ["url-parts"], conclusion: "route-maps" }]);
	});

	it("added nodes are inserted before the current node with origin coach and an edge into it", () => {
		const r = review({
			addNodes: [{ id: "urls", title: "URLs", facts: [{ id: "url-node-fact", name: "URL", statement: "A URL names a page." }] }],
			addArrows: [{ premises: ["url-node-fact"], conclusion: "route-maps" }],
		});
		const plan = applyReview({ phase: "teach", review: r, tree: TREE, probeFacts: undefined, currentNodeId: "routes", latest: null });
		assert.deepEqual(plan.plannedFacts, [{ id: "url-node-fact", name: "URL", statement: "A URL names a page." }]);
		const { tree, insertedNodeIds } = plan.build(IDS);
		assert.deepEqual(insertedNodeIds, ["urls"]);
		assert.deepEqual(tree!.nodes.map((n) => [n.id, n.origin, n.batch]), [["modules", "planner", 1], ["urls", "coach", 1], ["routes", "planner", 1]]);
		assert.deepEqual(tree!.edges, [{ from: "modules", to: "routes" }, { from: "urls", to: "routes" }]);
		assert.deepEqual(tree!.nodes[1]!.facts, [{ id: "url-node-fact", graphId: "n_unf", statement: "A URL names a page.", minted: true }]);
		assert.equal(tree!.version, 4);
	});

	it("a tree that fails validation drops every structural addition; verdicts, notes and askLearner stand", () => {
		const r = review({
			notes: ["kept"], askLearner: "kept?",
			judged: [{ factId: "route-maps", correct: false }],
			addFacts: [{ id: "url-parts", name: "URL parts", statement: "A URL has a path." }],
			addArrows: [{ premises: ["route-maps"], conclusion: "module-file" }],
		});
		const plan = applyReview({ phase: "teach", review: r, tree: TREE, probeFacts: undefined, currentNodeId: "routes", latest: answered("explain", ["route-maps"]) });
		assert.match(plan.problem!, /would create a cycle/);
		assert.deepEqual([plan.plannedFacts, plan.plannedArrows], [[], []]);
		assert.deepEqual(plan.judged, [{ factId: "route-maps", correct: false }]);
		assert.deepEqual(plan.build(IDS), { insertedNodeIds: [] });
	});

	it("without a current node the structural additions are dropped", () => {
		const plan = applyReview({ phase: "teach", review: review({ addFacts: [{ id: "x", name: "X", statement: "X." }] }), tree: TREE, probeFacts: undefined, currentNodeId: null, latest: null });
		assert.equal(plan.problem, "there is no current plan node to add to");
		assert.deepEqual(plan.plannedFacts, []);
	});
});

describe("insertedNodeHandoff", () => {
	const inserted: PlanTree = {
		...TREE,
		nodes: [TREE.nodes[0]!, { id: "urls", title: "URLs", facts: [{ id: "url-node-fact", graphId: "n_unf", statement: "A URL names a page." }], origin: "coach", batch: 1 }, TREE.nodes[1]!],
		edges: [...TREE.edges, { from: "urls", to: "routes" }],
	};
	const right = (nodeId: string, i: number): EvidenceEvent => ({ nodeId, chatId: "c", messageId: `m${nodeId}${i}`, at: `2026-11-15T00:00:0${i}.000Z`, source: "quiz", correct: true, guess: 1 / 3 });
	const modulesPassed = [1, 2, 3].map((i) => right("n_mod", i));

	it("hands off to the inserted node, carrying the card", () => {
		const handoff = insertedNodeHandoff({ tree: inserted, events: modulesPassed, currentNodeId: "routes", lastCard: "[Coach card] CARD" })!;
		assert.equal((handoff.details as NodeHandoffDetails).nodeId, "urls");
		assert.match(handoff.content, /You are starting the next node of the plan\./);
		assert.match(handoff.content, /- urls: URLs  ← you are here/);
		assert.match(handoff.content, /The coach's last card:\n\[Coach card\] CARD/);
	});

	it("null when the node to teach is still the current one (the inserted node already passed)", () => {
		const events = [...modulesPassed, ...[4, 5, 6].map((i) => right("n_unf", i))];
		assert.equal(insertedNodeHandoff({ tree: inserted, events, currentNodeId: "routes", lastCard: null }), null);
	});
});
