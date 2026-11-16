/**
 * Plan-tree tests (W1) — two layers:
 *
 *  1. Pure ops (src/core/plan-tree.ts): every validation error path and
 *     version semantics (structure only — progress derives from the
 *     transcript, docs/archive/probe-teach-split.md §3).
 *  2. The mermaid subset parser (the plan_init era's input format; the
 *     plan_batch tool is pinned in tests/plan-batch.test.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { derivePlanStatuses, derivedNodeStatus, type PlanTree } from "../src/core/contracts.ts";
import { createTree, emptyTree, insertNodesBefore, mergePlanBatch, PlanTreeError } from "../src/core/plan-tree.ts";
import type { PlanArrow, PlanNode } from "../src/core/contracts.ts";
import { parseMermaidPlan } from "../src/agent/tools/mermaid-plan.ts";

const N = (id: string, title = id, summary?: string) => ({ id, title, ...(summary ? { summary } : {}) });
const E = (from: string, to: string) => ({ from, to });

function tree(ids: string[], edges: Array<[string, string]> = []): PlanTree {
	return createTree(
		ids.map((id) => N(id)),
		edges.map(([from, to]) => E(from, to)),
	);
}

/** Assert the op throws a PlanTreeError matching the given regex. */
function assertReject(fn: () => unknown, needle: RegExp): void {
	try {
		fn();
	} catch (err) {
		assert.ok(err instanceof PlanTreeError, `expected PlanTreeError, got ${err}`);
		assert.match(err.message, needle);
		return;
	}
	assert.fail(`expected a PlanTreeError matching ${needle}, but the op succeeded`);
}

// ─── 1. pure ops ─────────────────────────────────────────────────────────────

describe("plan-tree pure ops", () => {
	it("createTree builds version 1 with no mutation of its inputs", () => {
		const nodes = [N("a", "A"), N("b", "B")];
		const edges = [E("a", "b")];
		const t = createTree(nodes, edges);
		assert.equal(t.version, 1);
		assert.ok(!("currentNodeId" in t), "no stored progress — structure only");
		assert.ok(!("doneNodeIds" in t), "no done ledger of any kind");
		assert.deepEqual(t.nodes.map((n) => n.id), ["a", "b"]);
		assert.deepEqual(t.edges, [E("a", "b")]);
		// Input arrays untouched (deep-copied into the tree).
		assert.deepEqual(nodes, [N("a", "A"), N("b", "B")]);
		assert.deepEqual(edges, [E("a", "b")]);
	});

	it("createTree rejects duplicate node ids", () => {
		assertReject(() => createTree([N("a"), N("a")], []), /Duplicate node id "a"/);
	});

	it("createTree rejects edges with missing endpoints", () => {
		assertReject(() => createTree([N("a")], [E("a", "ghost")]), /unknown node id "ghost"/);
		assertReject(() => createTree([N("a")], [E("ghost", "a")]), /unknown node id "ghost"/);
	});

	it("createTree rejects self-loops, duplicates, and cycles", () => {
		assertReject(() => createTree([N("a")], [E("a", "a")]), /self-loop/);
		assertReject(() => createTree([N("a"), N("b")], [E("a", "b"), E("a", "b")]), /already exists/);
		// a→b→c→a is a cycle.
		assertReject(
			() => createTree([N("a"), N("b"), N("c")], [E("a", "b"), E("b", "c"), E("c", "a")]),
			/cycle/,
		);
	});

	it("createTree rejects invalid node shapes", () => {
		assertReject(() => createTree([N("")], []), /non-empty `id`/);
		assertReject(() => createTree([{ id: "a", title: "" }], []), /non-empty `title`/);
	});

});

// ─── facts, arrows, batches (coach-planner design §4.2) ─────────────────────

/** A node with facts: each fact id f maps to graph id `n_<f>`. */
const NF = (id: string, factIds: string[], over: Partial<PlanNode> = {}): PlanNode => ({
	id,
	title: id.toUpperCase(),
	facts: factIds.map((f) => ({ id: f, graphId: `n_${f}`, statement: `Statement ${f}` })),
	...over,
});
const A = (premises: string[], conclusion: string): PlanArrow => ({ premises, conclusion });

describe("plan-tree facts and arrows", () => {
	it("an old tree without facts or arrows validates exactly as before (no arrows key added)", () => {
		const t = createTree([N("a", "A", "sum"), N("b", "B")], [E("a", "b")]);
		assert.deepEqual(t, {
			nodes: [{ id: "a", title: "A", summary: "sum" }, { id: "b", title: "B" }],
			edges: [E("a", "b")],
			version: 1,
		});
		assert.ok(!("arrows" in t));
	});

	it("accepts facts and arrows, and deep-copies them", () => {
		const nodes = [NF("a", ["f1", "f2"]), NF("b", ["f3"])];
		const arrows = [A(["f1", "f2"], "f3")];
		const t = createTree(nodes, [E("a", "b")], arrows);
		assert.deepEqual(t.arrows, arrows);
		assert.deepEqual(t.nodes[0]!.facts, nodes[0]!.facts);
		assert.notEqual(t.nodes[0]!.facts, nodes[0]!.facts, "facts list copied");
		assert.notEqual(t.nodes[0]!.facts![0], nodes[0]!.facts![0], "fact objects copied");
		assert.notEqual(t.arrows![0], arrows[0], "arrows copied");
	});

	it("rejects fact ids repeated across the tree or within a node, naming them", () => {
		assertReject(() => createTree([NF("a", ["f1"]), NF("b", ["f1"])], []), /Duplicate fact id "f1" — it is on node "a" and on node "b"/);
		assertReject(() => createTree([NF("a", ["f1", "f1"])], []), /Duplicate fact id "f1" on node "a"/);
	});

	it("rejects malformed facts", () => {
		assertReject(() => createTree([{ id: "a", title: "A", facts: [{ id: "", graphId: "n_x", statement: "s" }] }], []), /fact of node "a" needs a non-empty `id`/);
		assertReject(() => createTree([{ id: "a", title: "A", facts: [{ id: "f1", graphId: "", statement: "s" }] }], []), /Fact "f1" of node "a" needs a non-empty `graphId`/);
		assertReject(() => createTree([{ id: "a", title: "A", facts: [{ id: "f1", graphId: "n_x", statement: " " }] }], []), /Fact "f1" of node "a" needs a non-empty `statement`/);
	});

	it("rejects arrows without premises, with unknown endpoints, or concluding a premise", () => {
		const nodes = [NF("a", ["f1", "f2"])];
		assertReject(() => createTree(nodes, [], [A([], "f2")]), /needs at least one premise/);
		assertReject(() => createTree(nodes, [], [A(["ghost"], "f2")]), /unknown fact id "ghost"/);
		assertReject(() => createTree(nodes, [], [A(["f1"], "ghost")]), /unknown fact id "ghost"/);
		assertReject(() => createTree(nodes, [], [A(["f1", "f2"], "f2")]), /lists its conclusion "f2" among its premises/);
	});

	it("rejects cycles in the arrow relation, naming the arrow that closes it", () => {
		const nodes = [NF("a", ["f1", "f2", "f3"])];
		assertReject(() => createTree(nodes, [], [A(["f1"], "f2"), A(["f2"], "f3"), A(["f3"], "f1")]), /Arrow \["f3"\] → "f1" would create a cycle/);
		// A diamond is fine: f1 → f2, f1 → f3, [f2, f3] → … not a cycle.
		const ok = createTree([NF("a", ["f1", "f2", "f3", "f4"])], [], [A(["f1"], "f2"), A(["f1"], "f3"), A(["f2", "f3"], "f4")]);
		assert.equal(ok.arrows!.length, 3);
	});
});

describe("mergePlanBatch (append semantics)", () => {
	it("first batch onto no tree: version 1, origin from opts, batch 1", () => {
		const t = mergePlanBatch(undefined, { nodes: [NF("a", ["f1"]), NF("b", ["f2"])], edges: [E("a", "b")], arrows: [A(["f1"], "f2")] }, { origin: "planner" });
		assert.equal(t.version, 1);
		assert.deepEqual(t.nodes.map((n) => [n.id, n.origin, n.batch]), [["a", "planner", 1], ["b", "planner", 1]]);
		assert.deepEqual(t.edges, [E("a", "b")]);
		assert.deepEqual(t.arrows, [A(["f1"], "f2")]);
	});

	it("appends a later batch: existing nodes untouched, batch = highest + 1, version increments", () => {
		const first = mergePlanBatch(undefined, { nodes: [NF("a", ["f1"])], edges: [] }, { origin: "planner" });
		const second = mergePlanBatch(first, { nodes: [NF("b", ["f2"])], edges: [E("a", "b")], arrows: [A(["f1"], "f2")] }, { origin: "planner" });
		assert.equal(second.version, 2);
		assert.deepEqual(second.nodes[0], first.nodes[0], "the existing node is preserved verbatim");
		assert.equal(second.nodes[1]!.batch, 2);
		const third = mergePlanBatch(second, { nodes: [NF("c", [], { batch: 99, origin: "planner" })], edges: [E("b", "c")] }, { origin: "coach" });
		assert.equal(third.version, 3);
		assert.equal(third.nodes[2]!.batch, 3, "the batch number is assigned, never taken from the input");
		assert.equal(third.nodes[2]!.origin, "coach", "origin comes from opts");
		assert.deepEqual(third.arrows, [A(["f1"], "f2")], "existing arrows survive a batch without arrows");
	});

	it("nodes without a batch count as batch 0 (an old plan_init tree)", () => {
		const old = createTree([N("a"), N("b")], [E("a", "b")]);
		const t = mergePlanBatch(old, { nodes: [NF("c", ["f1"])], edges: [E("b", "c")] }, { origin: "planner" });
		assert.equal(t.nodes[2]!.batch, 1);
		assert.equal(t.version, 2);
		assert.deepEqual(t.nodes.slice(0, 2), old.nodes, "old nodes keep their shape (no batch/origin added)");
	});

	it("unions edges and arrows without duplicates (arrow premises compare as a set)", () => {
		const first = mergePlanBatch(undefined, { nodes: [NF("a", ["f1", "f2"]), NF("b", ["f3"])], edges: [E("a", "b")], arrows: [A(["f1", "f2"], "f3")] }, { origin: "planner" });
		const t = mergePlanBatch(
			first,
			{ nodes: [NF("c", ["f4"])], edges: [E("a", "b"), E("b", "c"), E("b", "c")], arrows: [A(["f2", "f1"], "f3"), A(["f3"], "f4")] },
			{ origin: "planner" },
		);
		assert.deepEqual(t.edges, [E("a", "b"), E("b", "c")]);
		assert.deepEqual(t.arrows, [A(["f1", "f2"], "f3"), A(["f3"], "f4")]);
	});

	it("rejects a batch node whose id already exists, naming it", () => {
		const first = mergePlanBatch(undefined, { nodes: [NF("a", ["f1"])], edges: [] }, { origin: "planner" });
		assertReject(() => mergePlanBatch(first, { nodes: [NF("a", ["f9"])], edges: [] }, { origin: "planner" }), /Node "a" already exists in the plan/);
	});

	it("rejects a batch fact id that clashes with an existing fact", () => {
		const first = mergePlanBatch(undefined, { nodes: [NF("a", ["f1"])], edges: [] }, { origin: "planner" });
		assertReject(() => mergePlanBatch(first, { nodes: [NF("b", ["f1"])], edges: [] }, { origin: "planner" }), /Duplicate fact id "f1" — it is on node "a" and on node "b"/);
	});

	it("validates the merged result like createTree (edges, arrows, cycles)", () => {
		const first = mergePlanBatch(undefined, { nodes: [NF("a", ["f1"]), NF("b", ["f2"])], edges: [E("a", "b")], arrows: [A(["f1"], "f2")] }, { origin: "planner" });
		assertReject(() => mergePlanBatch(first, { nodes: [NF("c", [])], edges: [E("c", "ghost")] }, { origin: "planner" }), /unknown node id "ghost"/);
		assertReject(() => mergePlanBatch(first, { nodes: [NF("c", [])], edges: [E("b", "a")] }, { origin: "planner" }), /cycle/);
		assertReject(() => mergePlanBatch(first, { nodes: [NF("c", ["f3"])], edges: [], arrows: [A(["f2"], "f1")] }, { origin: "planner" }), /would create a cycle/);
		assertReject(() => mergePlanBatch(first, { nodes: [NF("c", ["f3"])], edges: [], arrows: [A(["ghost"], "f3")] }, { origin: "planner" }), /unknown fact id "ghost"/);
	});

	it("never mutates the existing tree or the batch", () => {
		const first = mergePlanBatch(undefined, { nodes: [NF("a", ["f1"])], edges: [] }, { origin: "planner" });
		const snapshot = JSON.stringify(first);
		const batch = { nodes: [NF("b", ["f2"])], edges: [E("a", "b")], arrows: [A(["f1"], "f2")] };
		const batchSnapshot = JSON.stringify(batch);
		mergePlanBatch(first, batch, { origin: "planner" });
		assert.equal(JSON.stringify(first), snapshot);
		assert.equal(JSON.stringify(batch), batchSnapshot);
	});
});

describe("insertNodesBefore (coach insertions)", () => {
	const base = () =>
		mergePlanBatch(
			mergePlanBatch(undefined, { nodes: [NF("a", ["f1"])], edges: [] }, { origin: "planner" }),
			{ nodes: [NF("b", ["f2"]), NF("c", ["f3"])], edges: [E("a", "b"), E("b", "c")], arrows: [A(["f1"], "f2")] },
			{ origin: "planner" },
		);

	it("adds the nodes as prerequisites of the target, origin coach, the target's batch, placed before it", () => {
		const tree = base();
		const t = insertNodesBefore(tree, "c", [NF("x", ["f9"], { batch: 7, origin: "planner" }), NF("y", [])]);
		assert.equal(t.version, tree.version + 1);
		assert.deepEqual(t.nodes.map((n) => n.id), ["a", "b", "x", "y", "c"]);
		const x = t.nodes.find((n) => n.id === "x")!;
		assert.equal(x.origin, "coach");
		assert.equal(x.batch, 2, "the target's batch");
		assert.deepEqual(t.edges, [E("a", "b"), E("b", "c"), E("x", "c"), E("y", "c")]);
		assert.deepEqual(t.arrows, tree.arrows, "arrows carried over");
		assert.deepEqual(t.nodes.find((n) => n.id === "c"), tree.nodes.find((n) => n.id === "c"), "the target is untouched");
	});

	it("a target without a batch gives the new nodes no batch", () => {
		const old = createTree([N("a"), N("b")], [E("a", "b")]);
		const t = insertNodesBefore(old, "b", [N("x")]);
		const x = t.nodes.find((n) => n.id === "x")!;
		assert.equal(x.origin, "coach");
		assert.ok(!("batch" in x));
		assert.equal(t.version, 2);
	});

	it("rejects an unknown target, an existing node id, and clashing fact ids", () => {
		assertReject(() => insertNodesBefore(base(), "ghost", [N("x")]), /unknown node id "ghost"/);
		assertReject(() => insertNodesBefore(base(), "c", [N("a")]), /Node "a" already exists in the plan/);
		assertReject(() => insertNodesBefore(base(), "c", [NF("x", ["f1"])]), /Duplicate fact id "f1"/);
	});
});

// ─── the mermaid subset parser ────────────────────────────────────────────────

describe("parseMermaidPlan (the constrained mermaid subset)", () => {
	const parse = (m: string) => parseMermaidPlan(m);

	it("accepts graph TD and flowchart TB headers (case-insensitive), comments, and blank lines", () => {
		for (const header of ["graph TD", "graph td", "flowchart TB", "Flowchart td"]) {
			const res = parse(`${header}\n%% a comment\n\n  a[Alpha]\n`);
			assert.equal(res.ok, true, header);
			assert.deepEqual(res.plan!.nodes, [{ id: "a", title: "Alpha" }]);
		}
	});

	it("bare ids fall back to id-as-title; bracket and paren labels both work", () => {
		const res = parse("graph TD\n  bare\n  bracket[Bracket title]\n  paren(\"Paren title\")\n");
		assert.deepEqual(res.plan!.nodes, [
			{ id: "bare", title: "bare" },
			{ id: "bracket", title: "Bracket title" },
			{ id: "paren", title: "Paren title" },
		]);
	});

	it("edges register bare endpoints as nodes and dedupe duplicate edges", () => {
		const res = parse("graph TD\n  a --> b[Bee]\n  a --> b[Bee]\n");
		assert.deepEqual(res.plan!.nodes, [
			{ id: "a", title: "a" },
			{ id: "b", title: "Bee" },
		]);
		assert.deepEqual(res.plan!.edges, [{ from: "a", to: "b" }]);
	});

	it("labels on both edge endpoints survive; forward references are fine", () => {
		const res = parse("graph TD\n  downstream[Later thing] --> upstream[Earlier thing]\n");
		assert.deepEqual(res.plan!.edges, [{ from: "downstream", to: "upstream" }]);
		assert.deepEqual(res.plan!.nodes, [
			{ id: "downstream", title: "Later thing" },
			{ id: "upstream", title: "Earlier thing" },
		]);
	});

	it("rejects: non-slug ids (with the SPECIFIC message), self-loops, subgraphs, missing header, empty", () => {
		// The muscle-protein post-mortem (2026-09-11): underscore ids died at
		// the regex layer with a generic message, and the teacher spent four
		// plan_init calls hunting punctuation the parser didn't care about.
		// Now EVERY bad id reaches the slug check — the message names the id.
		assert.ok(!parse("graph TD\n  Foo Bar[x]\n").ok, "id with a space");
		assert.match(parse("graph TD\n  Foo Bar[x]\n").problems[0]!, /line 2.*slug/);
		assert.match(parse("graph TD\n  mps.translation[x]\n").problems[0]!, /node id `mps.translation` must be a lowercase slug/);
		assert.match(parse("graph TD\n  MPS[x]\n").problems[0]!, /node id `MPS` must be a lowercase slug/);
		assert.match(
			parse("graph TD\n  a[Alpha] --> mps.translation[Beta]\n").problems[0]!,
			/node id `mps.translation` must be a lowercase slug/,
			"bad id inside an edge also gets the specific message",
		);
		assert.ok(!parse("graph TD\n  a --> a\n").ok, "self-loop");
		assert.ok(!parse("graph TD\n  subgraph cluster\n").ok, "subgraph");
		assert.ok(!parse("digraph G\n  a\n").ok, "wrong header");
		assert.ok(!parse("%% only a comment\n").ok, "empty plan");
	});

	it("free-form pass (2026-09-11): underscores, chains, arrow synonyms, any direction, quoted titles", () => {
		// Underscores are first-class slug chars — kept verbatim, referenced
		// verbatim by quiz nodeId.
		const us = parse("graph TD\n  mps_translation[Ribosomes build protein] --> net_balance[Net balance]\n");
		assert.ok(us.ok, "underscore ids");
		assert.deepEqual(us.plan!.nodes, [
			{ id: "mps_translation", title: "Ribosomes build protein" },
			{ id: "net_balance", title: "Net balance" },
		]);
		// The exact shape the muscle-protein teacher wrote (attempt 1):
		// quoted titles with colons, commas, equals signs — must just work.
		const quoted = parse(
			'graph TD\n  mps_translation["MPS = ribosomes building protein"] --> per_meal["Per-meal dose: ~20-40 g saturates, excess oxidized"]\n',
		);
		assert.ok(quoted.ok, "quoted punctuation-rich titles");
		assert.deepEqual(quoted.plan!.nodes, [
			{ id: "mps_translation", title: "MPS = ribosomes building protein" },
			{ id: "per_meal", title: "Per-meal dose: ~20-40 g saturates, excess oxidized" },
		]);
		// Chains expand to consecutive pairs.
		const chain = parse("graph TD\n  a[Alpha] --> b[Bee] --> c[See]\n");
		assert.ok(chain.ok, "chained edges");
		assert.deepEqual(chain.plan!.edges, [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		]);
		// Arrow synonyms ==>, -.-> mean the same as -->.
		for (const arrow of ["==>", "-.->"]) {
			const res = parse(`graph TD\n  a ${arrow} b\n`);
			assert.ok(res.ok, arrow);
			assert.deepEqual(res.plan!.edges, [{ from: "a", to: "b" }]);
		}
		// Any direction header (we layout ourselves).
		for (const header of ["graph LR", "flowchart RL", "graph BT"]) {
			assert.ok(parse(`${header}\n  a --> b\n`).ok, header);
		}
	});

	it("the first label wins when a node line repeats (relabeling mid-block is ignored)", () => {
		const res = parse("graph TD\n  a[First label]\n  a[Second label]\n");
		assert.deepEqual(res.plan!.nodes, [{ id: "a", title: "First label" }]);
	});
});

// ─── derived statuses: position from CALLS, never results (§3) ─────────────────

describe("derivePlanStatuses (the map tracks position, not completion)", () => {
	const tree: PlanTree = {
		nodes: [
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
			{ id: "c", title: "C" },
		],
		edges: [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		],
		version: 1,
	};
	const quizPart = (state: string, nodeId: string | undefined, correct?: boolean) => ({
		type: "tool-quiz",
		state,
		input: nodeId === undefined ? {} : { nodeId },
		...(correct === undefined ? {} : { output: { correct } }),
	});
	type QuizPart = { type: string; state: string; input: unknown; output?: unknown };
	const msg = (...parts: QuizPart[]) => ({ parts });

	it("empty transcript → no current, nothing visited (no fallback current)", () => {
		const st = derivePlanStatuses(tree, []);
		assert.equal(st.current, null);
		assert.equal(st.visited.size, 0);
	});

	it("current = the node of the most recent tagged CALL — regardless of state or outcome", () => {
		const st = derivePlanStatuses(tree, [msg(quizPart("output-available", "b", false))]);
		assert.equal(st.current, "b", "even a FAILED check positions the map: the tag is about, not completion");
		assert.equal(st.visited.size, 0);
		const open = derivePlanStatuses(tree, [msg(quizPart("input-available", "c"))]);
		assert.equal(open.current, "c", "a merely ASKED question is already the position");
	});

	it("visited = earlier tagged nodes, sticky; results feed nothing", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "b", true)),
		]);
		assert.equal(st.current, "b");
		assert.deepEqual([...st.visited], ["a"]);
		// a passed check never marks anything finished — only moving on does
		const again = derivePlanStatuses(tree, [msg(quizPart("output-available", "a", true))]);
		assert.equal(again.current, "a");
		assert.equal(again.visited.size, 0, "one correct answer on a does not finish it");
	});

	it("revisits keep both: A→B→A gives current A, visited {A,B}", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "b", true)),
			msg(quizPart("input-available", "a")),
		]);
		assert.equal(st.current, "a");
		assert.deepEqual([...st.visited].sort(), ["a", "b"]);
	});

	it("several checks on one node hold the map still", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "a", false)),
			msg(quizPart("input-available", "a")),
		]);
		assert.equal(st.current, "a");
		assert.equal(st.visited.size, 0);
	});

	it("untagged checks and unknown nodeIds are ad-hoc — they move nothing", () => {
		const st = derivePlanStatuses(tree, [
			msg(quizPart("output-available", undefined, true)),
			msg(quizPart("output-available", "ghost", true)),
		]);
		assert.equal(st.current, null);
		assert.equal(st.visited.size, 0);
	});

	it("a rewritten map derives against the CURRENT tree — dropped slugs stop counting", () => {
		const rewritten: PlanTree = { ...tree, nodes: [tree.nodes[0]!, tree.nodes[1]!] };
		const st = derivePlanStatuses(rewritten, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "c", true)), // c removed by the rewrite
		]);
		assert.equal(st.current, "a", "the orphaned tag is ignored");
		assert.equal(st.visited.size, 0);
	});

	it("derivedNodeStatus: current wins over visited; upcoming otherwise", () => {
		const st = derivePlanStatuses(tree, [msg(quizPart("output-available", "a", true))]);
		assert.equal(derivedNodeStatus(st, "a"), "current");
		assert.equal(derivedNodeStatus(st, "b"), "upcoming");
		const later = derivePlanStatuses(tree, [
			msg(quizPart("output-available", "a", true)),
			msg(quizPart("output-available", "b", true)),
		]);
		assert.equal(derivedNodeStatus(later, "a"), "visited");
		assert.equal(derivedNodeStatus(later, "b"), "current");
		assert.equal(derivedNodeStatus(later, "c"), "upcoming");
	});
});

// ─── the explain mechanic derives position identically (owner 2026-09-27) ──

describe("derivePlanStatuses: tagged explain calls move the map like quiz calls", () => {
	const tree: PlanTree = {
		nodes: [
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
		],
		edges: [{ from: "a", to: "b" }],
		version: 1,
	};
	const explainPart = (nodeId: string | undefined) => ({
		type: "tool-explain",
		state: "output-available",
		input: nodeId === undefined ? {} : { nodeId },
	});
	type Part = { type: string; state: string; input: unknown; output?: unknown };
	const msg = (...parts: Part[]) => ({ parts });

	it("a tagged explain call is the current position; earlier ones are visited", () => {
		const st = derivePlanStatuses(tree, [
			msg(explainPart("a")),
			msg(explainPart("b")),
		]);
		assert.equal(st.current, "b");
		assert.deepEqual([...st.visited], ["a"]);
	});

	it("untagged explain calls move nothing", () => {
		const st = derivePlanStatuses(tree, [msg(explainPart(undefined))]);
		assert.equal(st.current, null);
		assert.equal(st.visited.size, 0);
	});

	it("mixed mechanics (an old quiz record, then an explain) still derive one run", () => {
		const st = derivePlanStatuses(tree, [
			msg({ type: "tool-quiz", state: "output-available", input: { nodeId: "a" } }),
			msg(explainPart("b")),
		]);
		assert.equal(st.current, "b");
		assert.deepEqual([...st.visited], ["a"]);
	});
});
