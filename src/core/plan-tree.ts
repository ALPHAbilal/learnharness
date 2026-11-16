import type { PlanArrow, PlanEdge, PlanFact, PlanNode, PlanTree } from "./contracts.ts";

/**
 * Pure, validated plan-tree operations (vision §2 "the formal plan tree").
 *
 * Every function takes a tree and returns a NEW tree — never mutates its
 * input. All validation throws PlanTreeError with a message written for the
 * agent (it flows straight back as a tool-result error), stating exactly what
 * is wrong and which id/edge is at fault.
 *
 * Invariants enforced everywhere:
 * - Node ids are unique and non-empty; every edge endpoint references an
 *   existing node.
 * - The structure is a DAG: no self-loops, no duplicate edges, no cycles.
 * - Facts (optional, coach-planner design §4.2): fact ids are unique across
 *   the whole tree; every arrow has at least one premise, references known
 *   fact ids only, never lists its conclusion among its premises, and the
 *   arrow relation has no cycle. A tree without facts or arrows validates
 *   exactly as before.
 * - `version` increments on every successful STATE-CHANGING op. True no-ops
 *   (setCurrent to the already-current node, markDone of an already-done
 *   node) return the input tree unchanged — version drives UI re-animation,
 *   so a non-change must not tick it. createTree always starts at version 1.
 */

/** Error thrown by every op on invalid input. Message is agent-readable. */
export class PlanTreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanTreeError";
	}
}

/** An empty, never-stored tree used as the seed before plan_init runs. */
export function emptyTree(): PlanTree {
	return { nodes: [], edges: [], version: 0 };
}

// ─── validation helpers ──────────────────────────────────────────────────────

function assertValidNode(node: PlanNode): void {
	if (!node || typeof node.id !== "string" || node.id.trim() === "") {
		throw new PlanTreeError("Every node needs a non-empty `id` (a stable slug like 'chain-rule-intuition').");
	}
	if (typeof node.title !== "string" || node.title.trim() === "") {
		throw new PlanTreeError(`Node "${node.id}" needs a non-empty \`title\`.`);
	}
}

function nodeMap(nodes: PlanNode[]): Map<string, PlanNode> {
	const map = new Map<string, PlanNode>();
	for (const node of nodes) {
		assertValidNode(node);
		if (map.has(node.id)) {
			throw new PlanTreeError(`Duplicate node id "${node.id}" — node ids must be unique.`);
		}
		map.set(node.id, node);
	}
	return map;
}

function requireNode(map: Map<string, PlanNode>, id: string, what: string): void {
	if (!map.has(id)) {
		throw new PlanTreeError(`${what} references unknown node id "${id}" — it is not in the tree.`);
	}
}

function edgeKey(from: string, to: string): string {
	return `${from}\u0000${to}`;
}

/**
 * Would adding edge from→to create a cycle? Walk forward from `to` along
 * existing edges; if we can reach `from`, the new edge closes a loop.
 */
function createsCycle(edges: PlanEdge[], from: string, to: string): boolean {
	const adjacency = new Map<string, string[]>();
	for (const e of edges) {
		const list = adjacency.get(e.from);
		if (list) list.push(e.to);
		else adjacency.set(e.from, [e.to]);
	}
	const stack = [to];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current === from) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		for (const next of adjacency.get(current) ?? []) stack.push(next);
	}
	return false;
}

/** Full edge validation against existing nodes/edges: endpoints exist, no self-loop, no duplicate, acyclic. */
function assertValidEdge(from: string, to: string, nodes: PlanNode[], existingEdges: PlanEdge[]): void {
	const map = nodeMap(nodes); // also re-validates nodes on createTree
	requireNode(map, from, "Edge `from`");
	requireNode(map, to, "Edge `to`");
	if (from === to) {
		throw new PlanTreeError(`Edge "${from}" → "${to}" is a self-loop — a node can't require itself.`);
	}
	if (existingEdges.some((e) => e.from === from && e.to === to)) {
		throw new PlanTreeError(`Edge "${from}" → "${to}" already exists — duplicate edges are not allowed.`);
	}
	if (createsCycle(existingEdges, from, to)) {
		throw new PlanTreeError(
			`Edge "${from}" → "${to}" would create a cycle: "${to}" already leads (directly or transitively) back to "${from}". ` +
				`"from" must be understood before "to" — the tree is a DAG.`,
		);
	}
}

// ─── fact + arrow validation (coach-planner design §4.2) ─────────────────────

function assertValidFact(fact: PlanFact, nodeId: string): void {
	if (!fact || typeof fact.id !== "string" || fact.id.trim() === "") {
		throw new PlanTreeError(`Every fact of node "${nodeId}" needs a non-empty \`id\` (a slug like 'f7').`);
	}
	if (typeof fact.graphId !== "string" || fact.graphId.trim() === "") {
		throw new PlanTreeError(`Fact "${fact.id}" of node "${nodeId}" needs a non-empty \`graphId\` (the knowledge-graph node id).`);
	}
	if (typeof fact.statement !== "string" || fact.statement.trim() === "") {
		throw new PlanTreeError(`Fact "${fact.id}" of node "${nodeId}" needs a non-empty \`statement\`.`);
	}
}

/** Fact id → owning node id, validating fact shapes and tree-wide uniqueness. */
function factOwners(nodes: PlanNode[]): Map<string, string> {
	const owners = new Map<string, string>();
	for (const node of nodes) {
		if (node.facts === undefined) continue;
		if (!Array.isArray(node.facts)) {
			throw new PlanTreeError(`Node "${node.id}" has \`facts\` that is not a list.`);
		}
		for (const fact of node.facts) {
			assertValidFact(fact, node.id);
			const owner = owners.get(fact.id);
			if (owner !== undefined) {
				throw new PlanTreeError(
					owner === node.id
						? `Duplicate fact id "${fact.id}" on node "${node.id}" — fact ids must be unique across the whole plan.`
						: `Duplicate fact id "${fact.id}" — it is on node "${owner}" and on node "${node.id}"; fact ids must be unique across the whole plan.`,
				);
			}
			owners.set(fact.id, node.id);
		}
	}
	return owners;
}

function arrowLabel(arrow: PlanArrow): string {
	const premises = Array.isArray(arrow.premises) ? arrow.premises.map((p) => `"${p}"`).join(", ") : "?";
	return `[${premises}] → "${arrow.conclusion}"`;
}

/** Order-insensitive identity of an arrow: sorted premises + conclusion. */
function arrowKey(arrow: PlanArrow): string {
	return `${[...arrow.premises].sort().join("\u0000")}\u0001${arrow.conclusion}`;
}

/** Validate arrows against the known fact ids; each arrow is checked
 *  against the ones already accepted, so a violation names the culprit. */
function validArrows(arrows: PlanArrow[], facts: ReadonlyMap<string, string>): PlanArrow[] {
	const accepted: PlanArrow[] = [];
	const pairs: PlanEdge[] = []; // premise → conclusion, the arrow relation
	for (const arrow of arrows) {
		if (!arrow || !Array.isArray(arrow.premises) || arrow.premises.length === 0) {
			throw new PlanTreeError(`Arrow ${arrow ? arrowLabel(arrow) : "(empty)"} needs at least one premise.`);
		}
		for (const premise of arrow.premises) {
			if (!facts.has(premise)) {
				throw new PlanTreeError(`Arrow ${arrowLabel(arrow)} references unknown fact id "${premise}" — it is not a fact of any node.`);
			}
		}
		if (!facts.has(arrow.conclusion)) {
			throw new PlanTreeError(`Arrow ${arrowLabel(arrow)} references unknown fact id "${arrow.conclusion}" — it is not a fact of any node.`);
		}
		if (arrow.premises.includes(arrow.conclusion)) {
			throw new PlanTreeError(`Arrow ${arrowLabel(arrow)} lists its conclusion "${arrow.conclusion}" among its premises — a fact can't support itself.`);
		}
		for (const premise of arrow.premises) {
			if (createsCycle(pairs, premise, arrow.conclusion)) {
				throw new PlanTreeError(
					`Arrow ${arrowLabel(arrow)} would create a cycle: "${arrow.conclusion}" already leads (directly or transitively) back to "${premise}".`,
				);
			}
		}
		for (const premise of arrow.premises) pairs.push({ from: premise, to: arrow.conclusion });
		accepted.push({ premises: [...arrow.premises], conclusion: arrow.conclusion });
	}
	return accepted;
}

function copyNode(node: PlanNode): PlanNode {
	return node.facts === undefined ? { ...node } : { ...node, facts: node.facts.map((f) => ({ ...f })) };
}

function edgeUnion(...lists: PlanEdge[][]): PlanEdge[] {
	const seen = new Set<string>();
	const out: PlanEdge[] = [];
	for (const list of lists) {
		for (const e of list) {
			const key = edgeKey(e.from, e.to);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ from: e.from, to: e.to });
		}
	}
	return out;
}

function arrowUnion(...lists: PlanArrow[][]): PlanArrow[] {
	const seen = new Set<string>();
	const out: PlanArrow[] = [];
	for (const list of lists) {
		for (const arrow of list) {
			// Malformed arrows pass through untouched so validation names them.
			if (!arrow || !Array.isArray(arrow.premises)) {
				out.push(arrow);
				continue;
			}
			const key = arrowKey(arrow);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(arrow);
		}
	}
	return out;
}

/** The highest batch number in the tree; nodes without one count as 0. */
function highestBatch(nodes: readonly PlanNode[]): number {
	return nodes.reduce((max, node) => Math.max(max, node.batch ?? 0), 0);
}

function assertNewNodeIds(existing: readonly PlanNode[], added: readonly PlanNode[]): void {
	const ids = new Set(existing.map((n) => n.id));
	for (const node of added) {
		if (node && ids.has(node.id)) {
			throw new PlanTreeError(`Node "${node.id}" already exists in the plan — new nodes need new ids; existing nodes cannot be changed.`);
		}
	}
}

// ─── ops ─────────────────────────────────────────────────────────────────────

/** Build a fresh tree (version 1) from node, edge and (optional) arrow
 *  lists, validating all invariants. `arrows` is carried on the result
 *  only when given. */
export function createTree(nodes: PlanNode[], edges: PlanEdge[], arrows?: PlanArrow[]): PlanTree {
	const map = nodeMap(nodes);
	for (const e of edges) {
		requireNode(map, e.from, "Edge `from`");
		requireNode(map, e.to, "Edge `to`");
	}
	const accepted: PlanEdge[] = [];
	for (const e of edges) {
		// Each edge is checked against the ones already accepted, so any
		// violation names the culprit edge.
		assertValidEdge(e.from, e.to, nodes, accepted);
		accepted.push({ from: e.from, to: e.to });
	}
	const facts = factOwners(nodes);
	const tree: PlanTree = { nodes: nodes.map(copyNode), edges: accepted, version: 1 };
	if (arrows !== undefined) tree.arrows = validArrows(arrows, facts);
	return tree;
}

/**
 * Append one batch to the stored tree (coach-planner design §4.2, append
 * semantics). Existing nodes, facts, edges and arrows are kept untouched;
 * a batch node whose id already exists is an error. New nodes carry
 * `origin` from `opts` and `batch` = highest existing batch + 1 (nodes
 * without a batch count as 0, so the first batch is 1). Edges and arrows
 * are unioned without duplicates (arrows compare by premise set +
 * conclusion). The result is validated like createTree; `version`
 * increments from the existing tree's (1 when there is none).
 */
export function mergePlanBatch(
	existing: PlanTree | undefined,
	batch: { nodes: PlanNode[]; edges: PlanEdge[]; arrows?: PlanArrow[] },
	opts: { origin: "planner" | "coach" },
): PlanTree {
	const base = existing ?? emptyTree();
	assertNewNodeIds(base.nodes, batch.nodes);
	const batchNumber = highestBatch(base.nodes) + 1;
	const added = batch.nodes.map((node) => (node ? { ...node, origin: opts.origin, batch: batchNumber } : node));
	const arrows = arrowUnion(base.arrows ?? [], batch.arrows ?? []);
	const tree = createTree([...base.nodes, ...added], edgeUnion(base.edges, batch.edges), arrows.length > 0 ? arrows : undefined);
	return { ...tree, version: (existing?.version ?? 0) + 1 };
}

/**
 * Insert coach nodes in front of `beforeNodeId`: each new node becomes a
 * prerequisite of it (edge new → before), carries `origin: "coach"` and
 * the same `batch` as `beforeNodeId` (left absent when that node has
 * none). The new nodes are placed just before `beforeNodeId` in the node
 * list. Validated like createTree; `version` increments.
 */
export function insertNodesBefore(tree: PlanTree, beforeNodeId: string, nodes: PlanNode[]): PlanTree {
	const index = tree.nodes.findIndex((n) => n.id === beforeNodeId);
	if (index < 0) {
		throw new PlanTreeError(`Cannot insert before unknown node id "${beforeNodeId}" — it is not in the tree.`);
	}
	assertNewNodeIds(tree.nodes, nodes);
	const before = tree.nodes[index]!;
	const added = nodes.map((node) => {
		if (!node) return node;
		const { batch: _ignored, ...rest } = node;
		return before.batch === undefined ? { ...rest, origin: "coach" as const } : { ...rest, origin: "coach" as const, batch: before.batch };
	});
	const nextNodes = [...tree.nodes.slice(0, index), ...added, ...tree.nodes.slice(index)];
	const nextEdges = edgeUnion(tree.edges, added.map((node) => ({ from: node?.id, to: beforeNodeId }) as PlanEdge));
	const next = createTree(nextNodes, nextEdges, tree.arrows);
	return { ...next, version: tree.version + 1 };
}

// The per-node mutation ops (addNode/updateNode/removeNode/addEdge/removeEdge/
// setCurrent/markDone) were deleted with the author-once protocol
// (2026-09-03) and their dead exports removed with the 2026-09-11 pivot: the
// tree carries structure ONLY — no progress fields exist to mutate
// (docs/archive/probe-teach-split.md §3). Restructuring is a plan_init rewrite.
