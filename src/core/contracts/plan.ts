/**
 * Plan-tree contracts — the session-scoped dependency tree
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/archive/vision.md.
 */
// ─── Plan tree (vision §2 "formal plan tree") ────────────────────────────────
// A session-scoped dependency tree authored by the teacher via plan tools.
// One substrate with the global graph: tree nodes fold into graph nodes.

export interface PlanNode {
	/** Opaque, agent-chosen slug, stable across edits: "chain-rule-intuition". */
	id: string;
	/** Short label for the tree panel. */
	title: string;
	/** 1-2 sentences: what this node covers. */
	summary?: string;
	/** The facts the learner must show to pass this node (coach-planner
	 *  design §4.2). Optional: trees saved before facts existed still parse. */
	facts?: PlanFact[];
	/** Who added the node: the planner's batches or the coach's
	 *  insertions. Absent on older trees. */
	origin?: "planner" | "coach";
	/** The planner batch the node belongs to (1, 2, …). A node without a
	 *  batch counts as batch 0. */
	batch?: number;
}

/** One fact of a plan node: a knowledge-graph proposition the learner
 *  must show they know. */
export interface PlanFact {
	/** Session-scoped slug the model writes ("f7"), same slug grammar as
	 *  node ids; unique across the whole tree. Arrows reference it. */
	id: string;
	/** The knowledge-graph node id ("n_…") the fact is stored under. */
	graphId: string;
	/** The fact, stated as one true proposition. */
	statement: string;
	/** True when this plan minted the graph node (the planner gave no
	 *  `existing` id); false or absent when the fact links to a node that
	 *  already existed. A replaced, not-yet-accepted plan removes the
	 *  minted nodes that carry no evidence. */
	minted?: boolean;
}

/** An argument between facts: the premises jointly entail the conclusion
 *  (the plan-side image of a graph chain). Endpoints are PlanFact ids. */
export interface PlanArrow {
	premises: string[];
	conclusion: string;
}

export interface PlanEdge {
	/** Prerequisite node id. */
	from: string;
	/** Node that depends on `from`. */
	to: string;
}

export interface PlanTree {
	nodes: PlanNode[];
	edges: PlanEdge[];
	/** Arguments between the nodes' facts. Optional: older trees have none. */
	arrows?: PlanArrow[];
	/** Increments on every mutation — lets the UI animate/react to changes. */
	version: number;
}

// NOTE (2026-09-11 pivot, docs/archive/probe-teach-split.md): the tree once carried
// `currentNodeId` / `doneNodeIds` — progress fields. They are GONE by
// design: the tree carries structure ONLY; position and visited-ness derive
// from the transcript at render time (derivePlanStatuses below). There is no
// done ledger of any kind. No backwards compatibility for old records.

/** Derived, never stored: status of a node for the panel (vision §2). */
export type PlanNodeStatus = "current" | "visited" | "upcoming";

// ─── derived statuses: position from CALLS, never from results ─────────────
//
// (2026-09-11 pivot — docs/archive/probe-teach-split.md §3.) The teacher AUTHORS the
// map (plan_init, mermaid — re-callable rewrite) and never tracks progress.
// The quiz `nodeId` means "this question is ABOUT this node" — a position
// signal, never a completion signal. Derivation reads CALLS only:
//   current — the node of the most RECENT tagged quiz call (any state)
//   visited — every node referenced by an EARLIER tagged call
// Consequences: a node spans multiple turns/checks naturally (several
// questions may tag the same node — the map holds still); moving to a new
// node is the teacher's judgment the previous one is finished, regardless of
// check outcomes (a failed check then a move-on is still visited); results
// feed nothing; there is NO fallback current (before the first tagged check
// nothing is current). Untagged checks no longer exist (nodeId is required
// on the teach quiz, owner ruling 2026-09-26). NodeIds missing from the
// current tree are ignored (a rewrite may have dropped the node).

/** Minimal structural message slice — anything with typed parts (mirrors
 * phases.ts: pure, no runtime deps, safe on server, client, and in tests). */
interface PartsCarrier {
	parts: Array<{ type: string; state?: string; input?: unknown; output?: unknown; pluginQuestion?: unknown }>;
}

export interface DerivedPlanStatuses {
	/** The node the most recent tagged quiz call is about; null before any. */
	current: string | null;
	/** Nodes referenced by earlier tagged calls — been there, monotonic. */
	visited: ReadonlySet<string>;
}

/** Statuses of a node: the derived view the plan panel should render. */
export function derivedNodeStatus(statuses: DerivedPlanStatuses, nodeId: string): PlanNodeStatus {
	if (statuses.current === nodeId) return "current";
	if (statuses.visited.has(nodeId)) return "visited";
	return "upcoming";
}

export function derivePlanStatuses(tree: PlanTree, messages: readonly PartsCarrier[]): DerivedPlanStatuses {
	const ids = new Set(tree.nodes.map((n) => n.id));
	const runs: string[] = []; // distinct tagged nodes in call order, CONSECUTIVE
	// duplicates collapsed (several checks on one node = one stay on it)
	for (const m of messages) {
		for (const part of m.parts) {
			// Either quizzing tool (quiz/explain) tags position — the mechanic
			// is a settings switch; the fold recognizes both (owner 2026-09-27).
			const snapshot = posedPluginQuestionOfPart(part);
			if (part.pluginQuestion !== undefined ? snapshot?.variant !== "teach" : part.type !== "tool-quiz" && part.type !== "tool-explain") continue;
			const nodeId = ((snapshot?.input ?? part.input) as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string" || !ids.has(nodeId)) continue; // untagged/unknown — moves nothing
			if (runs.at(-1) !== nodeId) runs.push(nodeId);
		}
	}
	const current = runs.at(-1) ?? null;
	// Visited = been there in an EARLIER stay: everything before the current
	// run. A revisit (a→b→a) puts a in visited AND current — current wins at
	// render (derivedNodeStatus), visited records it has been left before.
	const visited = new Set(runs.slice(0, -1));
	return { current, visited };
}

/**
 * The plan tool result (author-once protocol, 2026-09-03): ONE server-side
 * tool, plan_init (tools/plan.ts) — a mermaid `graph TD` block canonicalized
 * into the structured tree, called once at the probe→teach seam and
 * re-callable to rewrite. The former mutation/tracking tools are gone:
 * statuses derive from check outcomes (derivePlanStatuses above), so the
 * tree carries structure, never progress. The tree panel still derives its
 * display from the LATEST plan tool output in the transcript — plus the
 * derived statuses — with no separate state channel.
 */
export interface PlanToolResult {
	ok: boolean;
	error?: string;
	/** The saved tree — SUCCESS results only (owner, context diet
	 *  2026-10-09): this is the record/UI-facing `details` value. The
	 *  agent-facing content never carries it — content is the validated
	 *  nodeIds + reminder; failures carry just the error. The plan
	 *  popup's latestTree seam reads this field. */
	tree?: PlanTree;
}

// ─── the node handoff text (coach-planner design §4.6) ───────────────────────

// Moved to contracts/handoff.ts with the other handoff templates; re-exported
// here so the old import path keeps working.
export { nodeHandoffText, type NodeHandoffInput } from "./handoff.ts";

// ─── the native fold (Wave D: derivePlanStatuses over LhMessage[]) ───────────

import type { LhMessage } from "../native-messages.ts";
import { posedPluginQuestionOfPart } from "../tool-parts.ts";
import { readPluginQuestionMessageAnnotation } from "../plugin-questions.ts";

/** The same derivation over the NATIVE record: quiz CALLS only (any state —
 *  a dangling call still moves position; results feed nothing). */
export function derivePlanStatusesLh(tree: PlanTree, messages: readonly LhMessage[]): DerivedPlanStatuses {
	const ids = new Set(tree.nodes.map((n) => n.id));
	const runs: string[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const [contentIndex, block] of (content as Array<{ type?: string; name?: string; arguments?: unknown }>).entries()) {
			const annotation = readPluginQuestionMessageAnnotation(m, contentIndex);
			if (block.type !== "toolCall") continue;
			if (annotation.status !== "absent" ? annotation.status !== "posed" || annotation.snapshot.variant !== "teach" : block.name !== "quiz" && block.name !== "explain") continue;
			const input = annotation.status === "posed" ? annotation.snapshot.input : block.arguments;
			const nodeId = (input as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string" || !ids.has(nodeId)) continue;
			if (runs.at(-1) !== nodeId) runs.push(nodeId);
		}
	}
	const current = runs.at(-1) ?? null;
	const visited = new Set(runs.slice(0, -1));
	return { current, visited };
}
