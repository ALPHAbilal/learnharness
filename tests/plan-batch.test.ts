/**
 * plan_batch — the planner's plan tool (coach-planner design §4.2), executed
 * against the real chat and graph stores under an isolated LH_DATA_DIR.
 *
 * Pins: the full tree in `details` and the slim id list in content; the
 * graph write (minted vs `existing`-linked facts, arrows as chains) and the
 * graph ids stored on the facts; REPLACE before the plan is accepted
 * (including graph cleanup of minted, evidence-free nodes); APPEND after a
 * node-handoff; all-or-nothing validation listing every problem; the
 * nested-array argument heal; the description's example call.
 *
 * Successor of plan-tree.test.ts's plan_init block (the plan_init tool left
 * every registry with the coach update).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import type { PlanToolResult, PlanTree } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plan-batch-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { planBatchTool, planBatchExample, planBatchInput, preparePlanBatchArguments } = await import("../src/agent/tools/plan.ts");
const { writePlannedFacts, getGraph } = await import("../src/core/graph.ts");
const { newNodeHandoffMessage } = await import("../src/core/native-messages.ts");
const { healToolRecord } = await import("../src/agent/tools/heal.ts");
const { deleteNodeTraces } = await import("../src/core/graph-deletion.ts");
const { knowledgeOf, knowledgeFor, KNOWLEDGE_PRIOR } = await import("../src/core/knowledge.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function newChat(title: string): string {
	return chatStore.createChat(title).id;
}

async function run(chatId: string, input: unknown): Promise<{ details: PlanToolResult; content: string }> {
	const tool = planBatchTool({ chatId, chatStore, graphStore });
	const result = await tool.execute("call-test", input as never);
	const text = result.content.find((c) => c.type === "text");
	return { details: result.details as PlanToolResult, content: text && text.type === "text" ? text.text : "" };
}

const liveIds = () => new Set(graphStore.readNodes().map((n) => n.id));

const BATCH_ONE = {
	nodes: [
		{
			id: "modules",
			title: "Modules",
			facts: [
				{ id: "module-file", name: "A module is a file", statement: "A Python module is a file of definitions other files can import." },
				{ id: "import-runs", name: "Import runs once", statement: "An import statement runs a module once and binds its name." },
			],
		},
		{
			id: "packages",
			title: "Packages",
			requires: ["modules"],
			facts: [{ id: "package-dir", name: "A package is a folder", statement: "A package is a folder of modules imported by dotted names." }],
		},
	],
	arrows: [
		{ premises: ["module-file"], conclusion: "import-runs" },
		{ premises: ["module-file", "import-runs"], conclusion: "package-dir" },
	],
};

describe("plan_batch: write the plan (before acceptance)", () => {
	it("builds the tree, writes facts and arrows to the graph, stores graph ids, returns the full tree", async () => {
		const chatId = newChat("Plan batch: first");
		const { details, content } = await run(chatId, BATCH_ONE);
		assert.equal(details.ok, true, details.error);
		const tree = details.tree!;
		assert.deepEqual(tree.nodes.map((n) => n.id), ["modules", "packages"]);
		assert.deepEqual(tree.edges, [{ from: "modules", to: "packages" }]);
		assert.deepEqual(tree.arrows, BATCH_ONE.arrows);
		assert.equal(tree.version, 1);
		for (const node of tree.nodes) {
			assert.equal(node.origin, "planner");
			assert.equal(node.batch, 1);
		}
		const facts = tree.nodes.flatMap((n) => n.facts ?? []);
		assert.deepEqual(facts.map((f) => f.id), ["module-file", "import-runs", "package-dir"]);
		const live = liveIds();
		for (const fact of facts) {
			assert.match(fact.graphId, /^n_/);
			assert.ok(live.has(fact.graphId), "the fact's graph node exists");
			assert.equal(fact.minted, true);
		}
		// Arrows became chains over the graph ids.
		const graph = getGraph(graphStore);
		const byId = new Map(facts.map((f) => [f.id, f.graphId]));
		const chain = graph.chains.find((c) => c.conclusion === byId.get("package-dir"));
		assert.ok(chain, "the arrow into package-dir is a chain");
		assert.deepEqual([...chain.premises].sort(), [byId.get("module-file"), byId.get("import-runs")].sort());
		// The saved tree IS the details tree.
		assert.deepEqual(chatStore.getChat(chatId)!.tree, tree);
		// Content is slim: node and fact ids plus the binding reminder — no tree.
		const slim = JSON.parse(content) as { ok: boolean; nodes: unknown; reminder: string; tree?: unknown };
		assert.equal(slim.ok, true);
		assert.deepEqual(slim.nodes, [
			{ id: "modules", facts: ["module-file", "import-runs"] },
			{ id: "packages", facts: ["package-dir"] },
		]);
		assert.match(slim.reminder, /only valid node and fact ids/);
		assert.equal(slim.tree, undefined);
	});

	it("a fact with `existing` links to that graph node (minted false); no node is minted for it", async () => {
		const known = writePlannedFacts("chat_other", [{ id: "f", name: "Functions return", statement: "A function call evaluates to its return value." }], [], { chatStore, graphStore }).ids.f!;
		const chatId = newChat("Plan batch: existing");
		const before = liveIds().size;
		const { details } = await run(chatId, {
			nodes: [{ id: "errors", title: "Errors", facts: [
				{ id: "returns", name: "Functions return", statement: "A function call evaluates to its return value.", existing: known },
				{ id: "raise-stops", name: "Raise stops", statement: "A raise statement stops the function instead of returning." },
			] }],
			arrows: [{ premises: ["returns"], conclusion: "raise-stops" }],
		});
		assert.equal(details.ok, true, details.error);
		const [returns, raise] = details.tree!.nodes[0]!.facts!;
		assert.equal(returns!.graphId, known);
		assert.equal(returns!.minted, false);
		assert.equal(raise!.minted, true);
		assert.equal(liveIds().size, before + 1, "only the new fact minted a node");
	});

	it("REPLACES the plan until it is accepted; the old minted, evidence-free nodes leave the graph", async () => {
		const known = writePlannedFacts("chat_other", [{ id: "f", name: "Loops repeat", statement: "A for loop runs its body once per item." }], [], { chatStore, graphStore }).ids.f!;
		const chatId = newChat("Plan batch: replace");
		const first = await run(chatId, {
			nodes: [{ id: "old", title: "Old", facts: [
				{ id: "gone", name: "Gone fact", statement: "This fact is replaced and has no evidence." },
				{ id: "proven", name: "Proven fact", statement: "This fact is replaced but the learner answered on it." },
				{ id: "linked", name: "Loops repeat", statement: "A for loop runs its body once per item.", existing: known },
			] }],
		});
		assert.equal(first.details.ok, true, first.details.error);
		const old = new Map(first.details.tree!.nodes[0]!.facts!.map((f) => [f.id, f.graphId]));
		graphStore.appendEvidence({ nodeId: old.get("proven")!, chatId, messageId: "m1", at: new Date().toISOString(), source: "probe", correct: true, guess: 0.33 });

		const second = await run(chatId, BATCH_ONE);
		assert.equal(second.details.ok, true, second.details.error);
		const tree = second.details.tree!;
		assert.deepEqual(tree.nodes.map((n) => n.id), ["modules", "packages"], "the old node is gone — replaced, not appended");
		assert.equal(tree.version, 2, "a replacement still ticks the version");
		assert.equal(tree.nodes[0]!.batch, 1);
		const live = liveIds();
		assert.equal(live.has(old.get("gone")!), false, "minted + no evidence → removed from the graph");
		assert.equal(live.has(old.get("proven")!), true, "minted but with evidence → kept");
		assert.equal(live.has(known), true, "an existing-linked node is never removed");
	});

	it("keeps a replaced minted node the new batch links to with `existing`", async () => {
		const chatId = newChat("Plan batch: relink");
		const first = await run(chatId, { nodes: [{ id: "a", title: "A", facts: [{ id: "fa", name: "Fact A", statement: "Fact A holds." }] }] });
		const minted = first.details.tree!.nodes[0]!.facts![0]!.graphId;
		const second = await run(chatId, { nodes: [{ id: "b", title: "B", facts: [{ id: "fb", name: "Fact A", statement: "Fact A holds.", existing: minted }] }] });
		assert.equal(second.details.ok, true, second.details.error);
		assert.equal(liveIds().has(minted), true);
		assert.equal(second.details.tree!.nodes[0]!.facts![0]!.graphId, minted);
	});
});

describe("plan_batch: after acceptance it APPENDS", () => {
	it("merges a new batch after a node-handoff: existing nodes stay, requires/arrows may use stored ids", async () => {
		const chatId = newChat("Plan batch: append");
		const first = await run(chatId, BATCH_ONE);
		assert.equal(first.details.ok, true, first.details.error);
		chatStore.saveMessages(chatId, [newNodeHandoffMessage("modules", "[Node handoff] test") as LhMessage]);
		const stored = first.details.tree!;
		const packageDir = stored.nodes[1]!.facts![0]!.graphId;

		const res = await run(chatId, {
			nodes: [{ id: "venv", title: "Virtual environments", requires: ["packages"], facts: [
				{ id: "venv-isolates", name: "venv isolates packages", statement: "A virtual environment keeps its own installed packages." },
			] }],
			arrows: [{ premises: ["package-dir"], conclusion: "venv-isolates" }],
		});
		assert.equal(res.details.ok, true, res.details.error);
		const tree = res.details.tree!;
		assert.deepEqual(tree.nodes.map((n) => n.id), ["modules", "packages", "venv"]);
		assert.deepEqual(tree.nodes.slice(0, 2), stored.nodes, "stored nodes untouched");
		assert.equal(tree.nodes[2]!.batch, 2);
		assert.equal(tree.nodes[2]!.origin, "planner");
		assert.deepEqual(tree.edges, [{ from: "modules", to: "packages" }, { from: "packages", to: "venv" }]);
		assert.equal(tree.arrows!.length, 3);
		assert.equal(tree.version, stored.version + 1);
		const venv = tree.nodes[2]!.facts![0]!.graphId;
		const chain = getGraph(graphStore).chains.find((c) => c.conclusion === venv);
		assert.ok(chain);
		assert.deepEqual(chain.premises, [packageDir], "a stored fact id resolves to its graph id");
		assert.deepEqual(chatStore.getChat(chatId)!.tree, tree);
		const slim = JSON.parse(res.content) as { nodes: Array<{ id: string }> };
		assert.deepEqual(slim.nodes.map((n) => n.id), ["modules", "packages", "venv"], "content lists every valid node id");
	});

	it("rejects stored node and fact ids reused as new ones", async () => {
		const chatId = newChat("Plan batch: append clash");
		await run(chatId, BATCH_ONE);
		chatStore.saveMessages(chatId, [newNodeHandoffMessage("modules", "[Node handoff] test") as LhMessage]);
		const res = await run(chatId, { nodes: [{ id: "modules", title: "Again", facts: [{ id: "import-runs", name: "Dup", statement: "Dup." }] }] });
		assert.equal(res.details.ok, false);
		assert.match(res.details.error!, /Node "modules" is already in the plan/);
		assert.match(res.details.error!, /Fact id "import-runs" is already in the plan/);
	});
});

describe("plan_batch: a probe fact's id links to the probe fact's graph node", () => {
	const PROBE = [
		{ id: "py-functions", name: "Functions return", statement: "A Python function call evaluates to its return value." },
		{ id: "py-imports", name: "Imports run once", statement: "An import runs a module once and binds its name." },
	];
	/** The coach's probe fact list, as the mentor writes it: graph nodes
	 *  minted for the chat, the list saved on the record. */
	function seedProbe(chatId: string): Record<string, string> {
		const ids = writePlannedFacts(chatId, PROBE, [], { chatStore, graphStore }).ids;
		chatStore.saveProbeFacts(chatId, { facts: PROBE.map((f) => ({ id: f.id, graphId: ids[f.id]!, statement: f.statement, minted: true })), arrows: [] });
		return ids;
	}
	const FUNCTIONS_NODE = {
		id: "functions",
		title: "Functions",
		facts: [
			{ id: "py-functions", name: "Functions return values", statement: "Calling a function gives back the value its return statement names." },
			{ id: "raise-stops", name: "Raise stops", statement: "A raise statement stops the function instead of returning." },
		],
	};

	it("links without `existing` (minted false), mints no node for it, and the probe's evidence counts toward the plan fact", async () => {
		const chatId = newChat("Plan batch: probe link");
		const probe = seedProbe(chatId);
		graphStore.appendEvidence({ nodeId: probe["py-functions"]!, chatId, messageId: "m-probe", at: new Date().toISOString(), source: "probe", correct: true, guess: 0.33 });
		const before = liveIds().size;
		const { details } = await run(chatId, { nodes: [FUNCTIONS_NODE], arrows: [{ premises: ["py-functions"], conclusion: "raise-stops" }] });
		assert.equal(details.ok, true, details.error);
		const [linked, fresh] = details.tree!.nodes[0]!.facts!;
		assert.equal(linked!.graphId, probe["py-functions"], "the plan fact is the probe fact's graph node");
		assert.equal(linked!.minted, false);
		assert.equal(linked!.statement, FUNCTIONS_NODE.facts[0]!.statement, "the plan keeps the statement of this call");
		assert.equal(fresh!.minted, true);
		assert.equal(liveIds().size, before + 1, "only the new fact minted a node");
		const k = knowledgeFor(knowledgeOf(graphStore.readEvidence()), linked!.graphId);
		assert.equal(k.attempts, 1, "the probe answer is the plan fact's evidence");
		assert.ok(k.p > KNOWLEDGE_PRIOR, "the plan fact starts from what the probe showed");
		const chain = getGraph(graphStore).chains.find((c) => c.conclusion === fresh!.graphId);
		assert.deepEqual(chain?.premises, [probe["py-functions"]], "arrows resolve to the probe fact's node");
	});

	it("an explicit `existing` wins over the implied link", async () => {
		const known = writePlannedFacts("chat_other", [{ id: "f", name: "Calls return", statement: "A call evaluates to the returned value." }], [], { chatStore, graphStore }).ids.f!;
		const chatId = newChat("Plan batch: probe link, explicit");
		const probe = seedProbe(chatId);
		const { details } = await run(chatId, { nodes: [{ ...FUNCTIONS_NODE, facts: [{ ...FUNCTIONS_NODE.facts[0]!, existing: known }, FUNCTIONS_NODE.facts[1]!] }] });
		assert.equal(details.ok, true, details.error);
		const fact = details.tree!.nodes[0]!.facts![0]!;
		assert.equal(fact.graphId, known);
		assert.notEqual(fact.graphId, probe["py-functions"]);
		assert.equal(fact.minted, false);
	});

	it("a probe fact whose graph node is gone implies nothing: the fact is minted", async () => {
		const chatId = newChat("Plan batch: probe link, deleted");
		const probe = seedProbe(chatId);
		deleteNodeTraces(graphStore, probe["py-functions"]!);
		assert.equal(liveIds().has(probe["py-functions"]!), false);
		const before = liveIds().size;
		const { details } = await run(chatId, { nodes: [FUNCTIONS_NODE] });
		assert.equal(details.ok, true, details.error);
		const fact = details.tree!.nodes[0]!.facts![0]!;
		assert.equal(fact.minted, true);
		assert.notEqual(fact.graphId, probe["py-functions"]);
		assert.ok(liveIds().has(fact.graphId));
		assert.equal(liveIds().size, before + 2, "both facts minted a node");
	});

	it("replacing a plan never deletes a probe fact's graph node, even one an earlier plan marked minted", async () => {
		const chatId = newChat("Plan batch: probe link, replace");
		const probe = seedProbe(chatId);
		// A stored, not-yet-accepted plan claiming to have minted both probe nodes.
		chatStore.saveTree(chatId, {
			nodes: [{ id: "old", title: "Old", facts: PROBE.map((f) => ({ id: f.id, graphId: probe[f.id]!, statement: f.statement, minted: true })), batch: 1, origin: "planner" }],
			edges: [],
			version: 1,
		});
		const { details } = await run(chatId, BATCH_ONE);
		assert.equal(details.ok, true, details.error);
		assert.deepEqual(details.tree!.nodes.map((n) => n.id), ["modules", "packages"], "replaced");
		const live = liveIds();
		for (const f of PROBE) assert.equal(live.has(probe[f.id]!), true, `probe fact "${f.id}" keeps its graph node`);
	});

	it("reusing a probe fact id that is already a plan fact in a later APPEND call is the duplicate-id error", async () => {
		const chatId = newChat("Plan batch: probe link, append");
		const probe = seedProbe(chatId);
		const first = await run(chatId, { nodes: [FUNCTIONS_NODE] });
		assert.equal(first.details.ok, true, first.details.error);
		assert.equal(first.details.tree!.nodes[0]!.facts![0]!.graphId, probe["py-functions"]);
		chatStore.saveMessages(chatId, [newNodeHandoffMessage("functions", "[Node handoff] test") as LhMessage]);
		const graphBefore = graphStore.readNodes().length;
		const res = await run(chatId, { nodes: [{ id: "more", title: "More", facts: [{ id: "py-functions", name: "Again", statement: "A function call evaluates to its return value." }] }] });
		assert.equal(res.details.ok, false);
		assert.match(res.details.error!, /Fact id "py-functions" is already in the plan — new facts need new ids\./);
		assert.deepEqual(chatStore.getChat(chatId)!.tree, first.details.tree, "the plan is unchanged");
		assert.equal(graphStore.readNodes().length, graphBefore, "nothing written to the graph");
	});
});

describe("plan_batch: all-or-nothing validation", () => {
	it("lists EVERY problem and writes nothing", async () => {
		const chatId = newChat("Plan batch: problems");
		const graphBefore = graphStore.readNodes().length;
		const res = await run(chatId, {
			nodes: [
				{ id: "Bad Id", title: "Bad", facts: [{ id: "f1", name: "One", statement: "One." }] },
				{ id: "early", title: "Early", requires: ["late", "ghost"], facts: [
					{ id: "f1", name: "Dup", statement: "Dup." },
					{ id: "f2", name: "Ghost link", statement: "Links nowhere.", existing: "n_doesnotexist" },
				] },
				{ id: "late", title: "Late", facts: [{ id: "f3", name: "Three", statement: "Three." }] },
			],
			arrows: [{ premises: ["f1", "nope"], conclusion: "f3" }],
		});
		assert.equal(res.details.ok, false);
		const error = res.details.error!;
		assert.match(error, /Node id "Bad Id" must be a permanent lowercase slug/);
		assert.match(error, /requires "late", which is listed after it/);
		assert.match(error, /requires unknown node "ghost"/);
		assert.match(error, /Fact id "f1" appears twice/);
		assert.match(error, /names existing node "n_doesnotexist", which is not in the knowledge graph/);
		assert.match(error, /unknown fact id "nope"/);
		assert.equal(res.details.tree, undefined, "no tree echo on failure");
		assert.equal(chatStore.getChat(chatId)!.tree, undefined, "nothing saved");
		assert.equal(graphStore.readNodes().length, graphBefore, "nothing written to the graph");
	});

	it("a structural problem (an arrow cycle) is rejected before any write", async () => {
		const chatId = newChat("Plan batch: cycle");
		const graphBefore = graphStore.readNodes().length;
		const res = await run(chatId, {
			nodes: [{ id: "a", title: "A", facts: [{ id: "x", name: "X", statement: "X." }, { id: "y", name: "Y", statement: "Y." }] }],
			arrows: [{ premises: ["x"], conclusion: "y" }, { premises: ["y"], conclusion: "x" }],
		});
		assert.equal(res.details.ok, false);
		assert.match(res.details.error!, /cycle/);
		assert.equal(graphStore.readNodes().length, graphBefore);
		assert.equal(chatStore.getChat(chatId)!.tree, undefined);
	});

	it("an `existing` id that is already a fact of the stored plan is rejected (append)", async () => {
		const chatId = newChat("Plan batch: dup existing");
		const first = await run(chatId, BATCH_ONE);
		chatStore.saveMessages(chatId, [newNodeHandoffMessage("modules", "[Node handoff] test") as LhMessage]);
		const graphId = first.details.tree!.nodes[0]!.facts![0]!.graphId;
		const res = await run(chatId, { nodes: [{ id: "more", title: "More", facts: [{ id: "again", name: "Again", statement: "Again.", existing: graphId }] }] });
		assert.equal(res.details.ok, false);
		assert.match(res.details.error!, /already fact "module-file" of the plan/);
	});

	it("an unknown chat returns ok:false", async () => {
		const res = await run("chat_nonexistent", BATCH_ONE);
		assert.equal(res.details.ok, false);
		assert.match(res.details.error!, /Chat not found/);
	});
});

describe("plan_batch: the tool surface", () => {
	it("heals nested stringified arrays and bare ids in requires/premises", () => {
		const healed = preparePlanBatchArguments({
			nodes: JSON.stringify([
				{ id: "a", title: "A", facts: JSON.stringify([{ id: "x", name: "X", statement: "X." }]) },
				{ id: "b", title: "B", requires: "a", facts: [{ id: "y", name: "Y", statement: "Y." }] },
				{ id: "c", title: "C", requires: "[\"a\",\"b\"]", facts: [{ id: "z", name: "Z", statement: "Z." }] },
			]),
			arrows: JSON.stringify([{ premises: "x", conclusion: "y" }]),
		});
		assert.deepEqual(healed, {
			nodes: [
				{ id: "a", title: "A", facts: [{ id: "x", name: "X", statement: "X." }] },
				{ id: "b", title: "B", requires: ["a"], facts: [{ id: "y", name: "Y", statement: "Y." }] },
				{ id: "c", title: "C", requires: ["a", "b"], facts: [{ id: "z", name: "Z", statement: "Z." }] },
			],
			arrows: [{ premises: ["x"], conclusion: "y" }],
		});
		assert.ok(Value.Check(planBatchInput, healed), "the healed arguments validate");
		// Well-formed arguments come through unchanged, and the registry heal
		// composes over the tool's own shim.
		const wrapped = healToolRecord({ plan_batch: planBatchTool({ chatId: "x", chatStore, graphStore }) }).plan_batch!;
		assert.deepEqual(wrapped.prepareArguments!(BATCH_ONE), BATCH_ONE);
	});

	it("required fields lead; the description ends with the complete example, which validates", () => {
		const tool = planBatchTool({ chatId: "x", chatStore, graphStore });
		assert.equal(tool.name, "plan_batch");
		assert.ok(tool.description.endsWith("```json\n" + JSON.stringify(planBatchExample, null, 2) + "\n```"));
		assert.ok(Value.Check(planBatchInput, planBatchExample));
		const schema = planBatchInput as unknown as { required: string[]; properties: { nodes: { maxItems: number; items: { required: string[]; properties: Record<string, { maxItems?: number }> } } } };
		assert.deepEqual(schema.required, ["nodes"]);
		assert.equal(schema.properties.nodes.maxItems, 4);
		assert.deepEqual(Object.keys(schema.properties.nodes.items.properties), ["id", "title", "facts", "requires"]);
		assert.deepEqual(schema.properties.nodes.items.required, ["id", "title", "facts"]);
		assert.equal(schema.properties.nodes.items.properties.facts!.maxItems, 8);
	});

	it("the tree type keeps old trees valid: minted is optional", () => {
		const legacy: PlanTree = { nodes: [{ id: "a", title: "A", facts: [{ id: "f", graphId: "n_1", statement: "S." }] }], edges: [], version: 1 };
		assert.equal(legacy.nodes[0]!.facts![0]!.minted, undefined);
	});
});
