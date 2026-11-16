import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { PlanArrow, PlanEdge, PlanFact, PlanNode, PlanToolResult, PlanTree } from "../../core/contracts.ts";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
import { mergePlanBatch, PlanTreeError } from "../../core/plan-tree.ts";
import { writePlannedFacts, type PlannedArrow, type PlannedFact } from "../../core/graph.ts";
import { deleteNodeTraces } from "../../core/graph-deletion.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { hasNodeHandoff } from "../../core/native-messages.ts";
import { SLUG_RE } from "./mermaid-plan.ts";

/** The binding-id reminder riding plan_batch's slim content: the node and
 *  fact ids become load-bearing the moment they are saved — every later
 *  plan_batch arrow and requires, and every later question, references
 *  them. The reminder lands at the turn's tail, where discipline slips. */
const PLAN_BATCH_IDS_REMINDER =
	"These are the plan's node ids and fact ids — the only valid node and fact ids for every later call. Reference them exactly.";

/** What the plan tools close over (the plan-tree half of the tool context). */
export interface PlanToolContext {
	chatId: string;
	/** The storage port plan tools persist through. */
	chatStore: ChatStore;
}

/** plan_batch's context: the plan tree plus the knowledge graph its facts
 *  and arrows are written to. */
export interface PlanBatchContext extends PlanToolContext {
	graphStore: GraphStore;
}

// ─── the input schema ────────────────────────────────────────────────────────
// Required fields lead (the drop-order lesson: fields generated first get
// dropped least); the description ends with a complete example call.

const SLUG_RULE = "a permanent lowercase slug (a-z, 0-9, joined by hyphens or underscores)";

const factInput = Type.Object({
	id: Type.String({
		minLength: 1,
		description: `Fact id: ${SLUG_RULE}, unique across the whole plan. Arrows and questions reference it.`,
	}),
	name: Type.String({ minLength: 1, description: "A 2–5 word label for the fact." }),
	statement: Type.String({ minLength: 1, description: "The fact as one plain, true sentence." }),
	existing: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"The knowledge-graph id (n_…) of a fact the learner already holds, or the id of a fact already tested in the probe: the fact links to that node instead of creating a new one.",
		}),
	),
});

const nodeInput = Type.Object({
	id: Type.String({ minLength: 1, description: `Node id: ${SLUG_RULE}, unique across the whole plan.` }),
	title: Type.String({ minLength: 1, description: "A short title for the plan map." }),
	facts: Type.Array(factInput, { minItems: 1, maxItems: 8, description: "The facts the learner must show to pass this node (1–8)." }),
	requires: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Ids of the nodes that must come before this one — nodes earlier in this call or already in the plan.",
		}),
	),
});

const arrowInput = Type.Object({
	premises: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description: "Fact ids the conclusion stands on (from this call or already in the plan).",
	}),
	conclusion: Type.String({ minLength: 1, description: "The fact id that follows from the premises." }),
});

export const planBatchInput = Type.Object({
	nodes: Type.Array(nodeInput, { minItems: 1, maxItems: 4, description: "1–4 nodes, in teachable order (prerequisites first)." }),
	arrows: Type.Optional(Type.Array(arrowInput, { description: "Arguments between facts: premises ⇒ conclusion." })),
});

type PlanBatchInput = Static<typeof planBatchInput>;

/** The canonical example call (the quiz tools' convention: the description
 *  ends with a complete example). Exported for the description pin. */
export const planBatchExample: PlanBatchInput = {
	nodes: [
		{
			id: "exceptions",
			title: "Raising and catching errors",
			facts: [
				{
					id: "function-returns",
					name: "Functions return values",
					statement: "A function call evaluates to the value its `return` statement gives back.",
					existing: "n_3f9a1c2b7d4e",
				},
				{
					id: "raise-stops",
					name: "Raise stops a function",
					statement: "A `raise` statement stops the current function and passes an exception to its caller instead of a return value.",
				},
				{
					id: "try-catches",
					name: "Try catches raises",
					statement: "A `try` block runs its `except` block only when a line inside it raises.",
				},
			],
		},
		{
			id: "flask-errors",
			title: "Error responses in Flask",
			requires: ["exceptions"],
			facts: [
				{
					id: "abort-raises",
					name: "abort raises an exception",
					statement: "Flask's `abort(404)` raises an exception that Flask turns into a 404 response.",
				},
			],
		},
	],
	arrows: [
		{ premises: ["function-returns"], conclusion: "raise-stops" },
		{ premises: ["raise-stops"], conclusion: "try-catches" },
		{ premises: ["raise-stops"], conclusion: "abort-raises" },
	],
};

const PLAN_BATCH_DESCRIPTION =
	"Write the session's plan: 1–4 nodes, each made of facts the learner must show, plus arrows between facts. " +
	"Until the learner accepts the plan (presses Start), every call REPLACES the whole plan. Once teaching has begun, every call " +
	"APPENDS its nodes; existing nodes and facts cannot be changed. " +
	"List nodes in teachable order: `requires` may name only nodes earlier in this call or already in the plan. " +
	"Arrow endpoints are fact ids from this call or already in the plan. " +
	`Node and fact ids are ${SLUG_RULE}, unique across the plan. ` +
	"A fact the learner already holds that a new fact stands on can be listed with `existing` set to its knowledge-graph id " +
	"or to the id of a fact already tested in the probe, " +
	"so arrows can use it as a premise. " +
	"A fact tested in the probe keeps its number when the plan reuses its fact id: it links to the same knowledge-graph node without `existing`. " +
	"Everything is checked before anything is written: on any problem nothing changes and every problem is listed." +
	"\nExample arguments (the `existing` id is illustrative — use a real n_ id or leave the field out):\n```json\n" +
	JSON.stringify(planBatchExample, null, 2) +
	"\n```";

// ─── argument healing ────────────────────────────────────────────────────────

/** A JSON-encoded array stays an array; any other string becomes a
 *  one-element list (a bare id where a list belongs). */
export function asList(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed;
		if (typeof parsed === "string") return [parsed];
	} catch {
		// not JSON — a bare id
	}
	return [value];
}

/** A JSON-encoded array stays an array; anything unparseable passes
 *  through for validation to report. */
export function parsedArray(value: unknown): unknown {
	if (typeof value !== "string" || value.trim() === "") return value;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : value;
	} catch {
		return value;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A node id from a title: lowercase, every run of other characters a
 *  hyphen, trimmed, cut to 40 characters; `-2`, `-3`, … until it is not
 *  in `taken` ("node" when the title leaves nothing). */
function nodeIdFromTitle(title: string, taken: ReadonlySet<string>): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
	if (slug !== "" && !taken.has(slug)) return slug;
	const stem = slug === "" ? "node" : slug;
	let n = 2;
	while (taken.has(`${stem}-${n}`)) n++;
	return `${stem}-${n}`;
}

/** The nested-array heal (healStringifiedArrays' kin): `nodes`, `arrows`
 *  and each node's `facts`/`requires` arriving as JSON strings are parsed;
 *  a bare string in `requires`/`premises` is wrapped into a list; a node
 *  with a `title` but no `id` gets an id from its title, unique among this
 *  call's node ids and `storedNodeIds` (the stored plan's). Runs at pi's
 *  prepareArguments seam, before schema validation; well-formed arguments
 *  pass through unchanged. */
export function preparePlanBatchArguments(args: unknown, storedNodeIds: Iterable<string> = []): unknown {
	if (!isRecord(args)) return args;
	const out: Record<string, unknown> = { ...args };
	const nodes = parsedArray(out.nodes);
	if (Array.isArray(nodes)) {
		const hasId = (node: Record<string, unknown>) => typeof node.id === "string" && node.id !== "";
		const taken = new Set<string>(storedNodeIds);
		for (const node of nodes) if (isRecord(node) && hasId(node)) taken.add(node.id as string);
		out.nodes = nodes.map((node) => {
			if (!isRecord(node)) return node;
			const healed: Record<string, unknown> = { ...node };
			if (!hasId(healed) && typeof healed.title === "string" && healed.title.trim() !== "") {
				healed.id = nodeIdFromTitle(healed.title, taken);
				taken.add(healed.id as string);
			}
			if ("facts" in healed) healed.facts = parsedArray(healed.facts);
			if ("requires" in healed) healed.requires = asList(healed.requires);
			return healed;
		});
	} else out.nodes = nodes;
	if ("arrows" in out) {
		const arrows = parsedArray(out.arrows);
		out.arrows = Array.isArray(arrows)
			? arrows.map((arrow) => (isRecord(arrow) && "premises" in arrow ? { ...arrow, premises: asList(arrow.premises) } : arrow))
			: arrows;
	}
	return out;
}

// ─── the lenient `existing` ──────────────────────────────────────────────────

/** A fact whose `existing` is not a live graph node id but is the id of a
 *  probe fact or a stored plan fact gets that fact's graph id instead (the
 *  small model writes the fact id where the n_ id belongs); one whose
 *  `existing` is merely its own id, with no such fact, drops it (a new
 *  fact). Anything else is left for validation to report. Applied before
 *  withProbeLinks, so the `existing` rules run on the resolved value. */
function withResolvedExisting(input: PlanBatchInput, knownFacts: readonly PlanFact[], liveGraphIds: ReadonlySet<string>): PlanBatchInput {
	const graphIdOf = new Map<string, string>();
	for (const f of knownFacts) if (!graphIdOf.has(f.id)) graphIdOf.set(f.id, f.graphId);
	return {
		...input,
		nodes: input.nodes.map((node) => ({
			...node,
			facts: node.facts.map((fact) => {
				if (fact.existing === undefined || liveGraphIds.has(fact.existing)) return fact;
				const graphId = graphIdOf.get(fact.existing);
				if (graphId !== undefined) return { ...fact, existing: graphId };
				if (fact.existing !== fact.id) return fact;
				const { existing: _ownId, ...rest } = fact;
				return rest;
			}),
		})),
	};
}

// ─── the implied probe link ──────────────────────────────────────────────────

/** A fact with no `existing` whose id is a probe fact's id gets `existing`
 *  set to that probe fact's graph id, so the evidence the probe gathered
 *  counts toward the plan fact. Applied before validation: every `existing`
 *  rule then runs on the implied link unchanged. A probe fact whose graph
 *  node is gone implies nothing (the fact is minted); an explicit
 *  `existing` wins. */
function withProbeLinks(input: PlanBatchInput, probeFacts: readonly PlanFact[], liveGraphIds: ReadonlySet<string>): PlanBatchInput {
	const probeGraphIds = new Map(probeFacts.map((f) => [f.id, f.graphId]));
	return {
		...input,
		nodes: input.nodes.map((node) => ({
			...node,
			facts: node.facts.map((fact) => {
				if (fact.existing !== undefined) return fact;
				const graphId = probeGraphIds.get(fact.id);
				return graphId !== undefined && liveGraphIds.has(graphId) ? { ...fact, existing: graphId } : fact;
			}),
		})),
	};
}

// ─── validation (all problems, before anything is written) ──────────────────

function batchProblems(input: PlanBatchInput, base: PlanTree | undefined, liveGraphIds: ReadonlySet<string>): string[] {
	const problems: string[] = [];
	const baseNodes = new Set((base?.nodes ?? []).map((n) => n.id));
	const baseFacts = new Map<string, PlanFact>();
	for (const n of base?.nodes ?? []) for (const f of n.facts ?? []) baseFacts.set(f.id, f);
	const baseGraphIds = new Map<string, string>([...baseFacts.values()].map((f) => [f.graphId, f.id]));

	const callNodes = input.nodes.map((n) => n.id);
	const seenNodes = new Set<string>();
	const callFacts = new Set<string>();
	const existingSeen = new Map<string, string>();
	for (const [index, node] of input.nodes.entries()) {
		if (!SLUG_RE.test(node.id)) problems.push(`Node id "${node.id}" must be ${SLUG_RULE}.`);
		if (seenNodes.has(node.id)) problems.push(`Node id "${node.id}" appears twice in this call — node ids must be unique.`);
		else if (baseNodes.has(node.id)) problems.push(`Node "${node.id}" is already in the plan — new nodes need new ids; existing nodes cannot be changed.`);
		for (const required of node.requires ?? []) {
			if (required === node.id) problems.push(`Node "${node.id}" requires itself.`);
			else if (seenNodes.has(required) || baseNodes.has(required)) continue;
			else if (callNodes.indexOf(required, index + 1) > index) {
				problems.push(`Node "${node.id}" requires "${required}", which is listed after it — list the nodes in teachable order, prerequisites first.`);
			} else problems.push(`Node "${node.id}" requires unknown node "${required}" — it is neither earlier in this call nor in the plan.`);
		}
		seenNodes.add(node.id);
		for (const fact of node.facts) {
			if (!SLUG_RE.test(fact.id)) problems.push(`Fact id "${fact.id}" (node "${node.id}") must be ${SLUG_RULE}.`);
			if (callFacts.has(fact.id)) problems.push(`Fact id "${fact.id}" appears twice in this call — fact ids must be unique across the plan.`);
			else if (baseFacts.has(fact.id)) problems.push(`Fact id "${fact.id}" is already in the plan — new facts need new ids.`);
			callFacts.add(fact.id);
			if (fact.existing !== undefined) {
				if (!liveGraphIds.has(fact.existing)) {
					problems.push(`Fact "${fact.id}" names existing node "${fact.existing}", which is not in the knowledge graph — use a real n_ id, or leave \`existing\` out to create a new fact.`);
				} else if (baseGraphIds.has(fact.existing)) {
					problems.push(`Fact "${fact.id}" names existing node "${fact.existing}", which is already fact "${baseGraphIds.get(fact.existing)}" of the plan — reference that fact id instead.`);
				} else if (existingSeen.has(fact.existing)) {
					problems.push(`Facts "${existingSeen.get(fact.existing)}" and "${fact.id}" both name existing node "${fact.existing}" — list it once.`);
				} else existingSeen.set(fact.existing, fact.id);
			}
		}
	}
	const knownFact = (id: string) => callFacts.has(id) || baseFacts.has(id);
	for (const arrow of input.arrows ?? []) {
		const label = `[${arrow.premises.map((p) => `"${p}"`).join(", ")}] → "${arrow.conclusion}"`;
		for (const endpoint of [...arrow.premises, arrow.conclusion]) {
			if (!knownFact(endpoint)) problems.push(`Arrow ${label} references unknown fact id "${endpoint}" — it is neither a fact of this call nor in the plan.`);
		}
	}
	return problems;
}

/** The batch as plan-tree nodes/edges/arrows, facts carrying `graphIdOf`. */
function batchOf(input: PlanBatchInput, graphIdOf: (factId: string) => string): { nodes: PlanNode[]; edges: PlanEdge[]; arrows?: PlanArrow[] } {
	const nodes: PlanNode[] = input.nodes.map((node) => ({
		id: node.id,
		title: node.title,
		facts: node.facts.map((fact) => ({
			id: fact.id,
			graphId: graphIdOf(fact.id),
			statement: fact.statement,
			minted: fact.existing === undefined,
		})),
	}));
	const edges: PlanEdge[] = input.nodes.flatMap((node) => (node.requires ?? []).map((from) => ({ from, to: node.id })));
	const arrows = input.arrows?.map((a) => ({ premises: [...a.premises], conclusion: a.conclusion }));
	return arrows && arrows.length > 0 ? { nodes, edges, arrows } : { nodes, edges };
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * plan_batch — the planner's plan tool (coach-planner design §4.2).
 *
 * Structured JSON, not mermaid: nodes made of facts, `requires` edges, and
 * arrows between facts. SERVER-SIDE, all-or-nothing: every problem is
 * collected before anything is written, and a rejected call changes neither
 * the plan nor the graph.
 *
 *   - Before the learner accepts the plan (no node-handoff marker yet), the
 *     call REPLACES the stored tree; the replaced tree's minted graph nodes
 *     that carry no evidence leave the graph (deleteNodeTraces). Nodes the
 *     new batch links to with `existing` are kept, and so are the probe
 *     facts' nodes.
 *   - A fact whose id is a probe fact's id (record.probeFacts) and that
 *     names no `existing` links to that probe fact's graph node
 *     (withProbeLinks), so the probe's evidence carries over.
 *   - Once teaching has begun, the call APPENDS (mergePlanBatch, origin
 *     "planner").
 *   - The batch's facts and arrows are written to the knowledge graph
 *     (writePlannedFacts, then settleGraphLayout), and each stored fact
 *     carries its graph id. This runs even when the knowledge graph is off
 *     in settings (graph.enabled false): the facts carry the evidence the
 *     coach and the pass rule read, so the switch does not gate the tool.
 *
 * Content is slim (the node and fact ids plus the binding reminder);
 * `details.tree` is ALWAYS the full stored tree — the UI reads the plan from
 * the latest plan tool result.
 */
export function planBatchTool(ctx: PlanBatchContext): AgentTool<typeof planBatchInput> {
	return {
		name: "plan_batch",
		label: "plan_batch",
		description: PLAN_BATCH_DESCRIPTION,
		parameters: planBatchInput,
		prepareArguments: ((args: unknown) =>
			preparePlanBatchArguments(args, (ctx.chatStore.getChat(ctx.chatId)?.tree?.nodes ?? []).map((n) => n.id))) as (args: unknown) => PlanBatchInput,
		execute: serverExecute("plan_batch", planBatchInput, async (args): Promise<PlanToolResult | { text: string; details: PlanToolResult }> => {
			const { chatId, chatStore, graphStore } = ctx;
			const record = chatStore.getChat(chatId);
			if (!record) return { ok: false, error: `Chat not found: ${chatId}` };
			const accepted = hasNodeHandoff(record.messages);
			const replaced = accepted ? undefined : record.tree;
			const base = accepted ? record.tree : undefined;
			const probeFacts = record.probeFacts?.facts ?? [];

			// 1. Validate everything first — a rejected call writes nothing.
			// The lenient `existing` and the implied probe links come first,
			// so they are validated as any `existing` is.
			const liveGraphIds = new Set(graphStore.readNodes().map((n) => n.id));
			const planFacts = (record.tree?.nodes ?? []).flatMap((n) => n.facts ?? []);
			const input = withProbeLinks(withResolvedExisting(args, [...probeFacts, ...planFacts], liveGraphIds), probeFacts, liveGraphIds);
			const problems = batchProblems(input, base, liveGraphIds);
			if (problems.length > 0) return { ok: false, error: problems.join("\n") };
			try {
				// Structure dry-run (cycles, arrow shape) with placeholder graph ids.
				mergePlanBatch(base, batchOf(input, () => "pending"), { origin: "planner" });
			} catch (err) {
				if (err instanceof PlanTreeError) return { ok: false, error: err.message };
				throw err;
			}

			// 2. The graph write (itself validated before any append).
			const baseGraphIds = new Map<string, string>();
			for (const node of base?.nodes ?? []) for (const fact of node.facts ?? []) baseGraphIds.set(fact.id, fact.graphId);
			const facts: PlannedFact[] = input.nodes.flatMap((node) =>
				node.facts.map((f) => ({ id: f.id, name: f.name, statement: f.statement, ...(f.existing !== undefined ? { existing: f.existing } : {}) })),
			);
			const endpoint = (id: string) => baseGraphIds.get(id) ?? id;
			const arrows: PlannedArrow[] = (input.arrows ?? []).map((a) => ({ premises: a.premises.map(endpoint), conclusion: endpoint(a.conclusion) }));
			let ids: Record<string, string>;
			try {
				ids = writePlannedFacts(chatId, facts, arrows, { chatStore, graphStore }).ids;
			} catch (err) {
				return { ok: false, error: errorText(err) };
			}

			// 3. Replace: the replaced plan's minted, evidence-free nodes leave
			// the graph (nodes this batch links to and the probe facts' nodes
			// are kept).
			if (replaced) {
				const kept = new Set([...Object.values(ids), ...probeFacts.map((f) => f.graphId)]);
				const withEvidence = new Set(graphStore.readEvidence().map((e) => e.nodeId));
				for (const node of replaced.nodes) {
					for (const fact of node.facts ?? []) {
						if (fact.minted === true && !kept.has(fact.graphId) && !withEvidence.has(fact.graphId)) deleteNodeTraces(graphStore, fact.graphId);
					}
				}
			}
			settleGraphLayout(graphStore);

			// 4. Save the tree.
			const merged = mergePlanBatch(base, batchOf(input, (factId) => ids[factId]!), { origin: "planner" });
			const tree: PlanTree = accepted ? merged : { ...merged, version: (replaced?.version ?? 0) + 1 };
			chatStore.saveTree(chatId, tree);
			return {
				text: JSON.stringify({
					ok: true,
					nodes: tree.nodes.map((n) => ({ id: n.id, facts: (n.facts ?? []).map((f) => f.id) })),
					reminder: PLAN_BATCH_IDS_REMINDER,
				}),
				details: { ok: true, tree },
			};
		}),
	};
}
