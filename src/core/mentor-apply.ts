/**
 * Applying the mentor's review (coach-planner design §4.5): which verdicts
 * become evidence, which facts and arrows go to the knowledge graph, and
 * the new plan tree or probe fact list — planned here, purely; the server
 * writes the graph and saves the results.
 *
 *   - `judged` counts only for an own-words answer (explain / recall), and
 *     only for facts that question tagged.
 *   - Probe phase (added nodes are always ignored): added facts (at most
 *     12) and arrows join the probe fact list (ids unique, arrows
 *     deduplicated, arrows naming a dropped fact dropped). A fact whose id
 *     is already on the list, or whose statement equals a listed one
 *     (ignoring case, whitespace and punctuation), is dropped.
 *   - Teach phase: added facts join the CURRENT node; added arrows join
 *     the tree's arrows; added nodes are inserted before the current node
 *     (insertNodesBefore, origin "coach"). The result is validated like
 *     createTree; when it fails, every structural addition is dropped (the
 *     verdicts, notes and askLearner stand) and `problem` says why.
 */

import type { EvidenceEvent, PlanArrow, PlanFact, PlanNode, PlanTree } from "./contracts.ts";
import type { ProbeFacts } from "./contracts/chat.ts";
import type { MentorFact, MentorReview } from "./contracts/mentor.ts";
import { nodeHandoffText, roadRecord } from "./contracts/handoff.ts";
import type { AnsweredQuestion } from "./evidence.ts";
import type { PlannedArrow, PlannedFact } from "./graph.ts";
import { knowledgeOf } from "./knowledge.ts";
import { taggedFactIds } from "./mentor-input.ts";
import { newNodeHandoffMessage, type LhMarkerMessage } from "./native-messages.ts";
import { nextPlanNode } from "./plan-progress.ts";
import { createTree, insertNodesBefore, PlanTreeError } from "./plan-tree.ts";

/** The tools whose answers are in the learner's own words. */
const OWN_WORDS_TOOLS = new Set(["explain", "recall"]);

/** What applying a review changes. */
export interface ReviewApplication {
	/** Verdicts to turn into evidence (fact ids, not graph ids). */
	judged: { factId: string; correct: boolean }[];
	/** Facts to write to the knowledge graph (writePlannedFacts). */
	plannedFacts: PlannedFact[];
	/** Arrows to write; endpoints are new fact slugs or the graph ids of
	 *  facts already in the plan or probe list. */
	plannedArrows: PlannedArrow[];
	/** Why the structural additions were dropped, or null. */
	problem: string | null;
	/** The new tree (teach) or probe fact list (probe), given the slug →
	 *  graph id mapping writePlannedFacts returned. A field is present only
	 *  when it changed. */
	build(ids: Record<string, string>): { tree?: PlanTree; probeFacts?: ProbeFacts; insertedNodeIds: string[] };
}

function arrowKey(arrow: PlanArrow): string {
	return `${[...arrow.premises].sort().join("\u0000")}\u0001${arrow.conclusion}`;
}

/** The arrows of `added` whose key is in neither `base` nor earlier in `added`. */
function newArrows(base: readonly PlanArrow[], added: readonly PlanArrow[]): PlanArrow[] {
	const seen = new Set(base.map(arrowKey));
	const out: PlanArrow[] = [];
	for (const arrow of added) {
		const key = arrowKey(arrow);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ premises: [...arrow.premises], conclusion: arrow.conclusion });
	}
	return out;
}

function planFact(fact: MentorFact, graphIdOf: (id: string) => string): PlanFact {
	return { id: fact.id, graphId: graphIdOf(fact.id), statement: fact.statement, minted: fact.existing === undefined };
}

function plannedFact(fact: MentorFact): PlannedFact {
	return { id: fact.id, name: fact.name, statement: fact.statement, ...(fact.existing !== undefined ? { existing: fact.existing } : {}) };
}

const NO_CHANGE = { insertedNodeIds: [] as string[] };

/** Facts the probe list accepts from one review. */
const PROBE_MAP_FACT_CAP = 12;

/** A statement compared ignoring case, whitespace and punctuation. */
function statementKey(statement: string): string {
	return statement.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** The added facts the probe list keeps: new ids and new statements only,
 *  the first `cap` of them. */
function freshProbeFacts(base: readonly PlanFact[], added: readonly MentorFact[], cap: number): MentorFact[] {
	const ids = new Set(base.map((f) => f.id));
	const statements = new Set(base.map((f) => statementKey(f.statement)));
	const out: MentorFact[] = [];
	for (const fact of added) {
		if (out.length >= cap) break;
		const key = statementKey(fact.statement);
		if (ids.has(fact.id) || statements.has(key)) continue;
		ids.add(fact.id);
		statements.add(key);
		out.push(fact);
	}
	return out;
}

export function applyReview(args: {
	phase: "probe" | "teach";
	review: MentorReview | null;
	tree: PlanTree | null | undefined;
	probeFacts: ProbeFacts | null | undefined;
	currentNodeId: string | null;
	latest: AnsweredQuestion | null;
}): ReviewApplication {
	const { phase, review, tree, probeFacts, currentNodeId, latest } = args;
	const empty: ReviewApplication = { judged: [], plannedFacts: [], plannedArrows: [], problem: null, build: () => NO_CHANGE };
	if (!review) return empty;

	// The verdicts: own-words answers only, tagged facts only, first per fact.
	const tagged = new Set(latest ? taggedFactIds(latest.input) : []);
	const judged: ReviewApplication["judged"] = [];
	if (latest && OWN_WORDS_TOOLS.has(latest.tool)) {
		for (const j of review.judged) {
			if (tagged.has(j.factId) && !judged.some((k) => k.factId === j.factId)) judged.push({ factId: j.factId, correct: j.correct });
		}
	}
	const verdictsOnly = (problem: string | null): ReviewApplication => ({ ...empty, judged, problem });

	if (phase === "probe") {
		const baseFacts = probeFacts?.facts ?? [];
		const baseArrows = probeFacts?.arrows ?? [];
		const addFacts = freshProbeFacts(baseFacts, review.addFacts, PROBE_MAP_FACT_CAP);
		const known = new Set([...baseFacts.map((f) => f.id), ...addFacts.map((f) => f.id)]);
		const proposed = review.addArrows.filter((a) => known.has(a.conclusion) && a.premises.every((p) => known.has(p)));
		let added = newArrows(baseArrows, proposed);
		if (addFacts.length === 0 && added.length === 0) return verdictsOnly(null);
		const listOf = (graphIdOf: (id: string) => string): ProbeFacts => ({
			...probeFacts,
			facts: [...baseFacts.map((f) => ({ ...f })), ...addFacts.map((f) => planFact(f, graphIdOf))],
			arrows: [...baseArrows.map((a) => ({ premises: [...a.premises], conclusion: a.conclusion })), ...added],
		});
		// The probe list validates like a one-node tree: unique ids, known
		// endpoints, no self-support, no cycle. A map whose new arrows fail
		// keeps its new facts without them; otherwise the additions drop.
		const check = (): string | null => {
			try {
				const dry = listOf((id) => `pending:${id}`);
				createTree([{ id: "probe", title: "probe", facts: dry.facts }], [], dry.arrows);
				return null;
			} catch (err) {
				if (err instanceof PlanTreeError) return err.message;
				throw err;
			}
		};
		let problem = check();
		if (problem !== null && addFacts.length > 0 && added.length > 0) {
			added = [];
			problem = check() === null ? null : problem;
		}
		if (problem !== null || (addFacts.length === 0 && added.length === 0)) return verdictsOnly(problem);
		const graphOf = new Map(baseFacts.map((f) => [f.id, f.graphId]));
		return {
			judged,
			plannedFacts: addFacts.map(plannedFact),
			plannedArrows: added.map((a) => ({ premises: a.premises.map((p) => graphOf.get(p) ?? p), conclusion: graphOf.get(a.conclusion) ?? a.conclusion })),
			problem: null,
			build: (ids) => ({ probeFacts: listOf((id) => ids[id]!), insertedNodeIds: [] }),
		};
	}

	// Teach phase.
	const hasAdditions = review.addFacts.length > 0 || review.addNodes.length > 0 || review.addArrows.length > 0;
	if (!hasAdditions) return verdictsOnly(null);
	if (!tree || currentNodeId === null || !tree.nodes.some((n) => n.id === currentNodeId)) {
		return verdictsOnly("there is no current plan node to add to");
	}
	const added = newArrows(tree.arrows ?? [], review.addArrows);
	if (review.addFacts.length === 0 && review.addNodes.length === 0 && added.length === 0) return verdictsOnly(null);
	const treeOf = (graphIdOf: (id: string) => string): PlanTree => {
		const nodes: PlanNode[] = tree.nodes.map((n) =>
			n.id === currentNodeId && review.addFacts.length > 0 ? { ...n, facts: [...(n.facts ?? []), ...review.addFacts.map((f) => planFact(f, graphIdOf))] } : n,
		);
		const arrows = [...(tree.arrows ?? []), ...added];
		const base: PlanTree = { ...tree, nodes, ...(arrows.length > 0 ? { arrows } : {}) };
		if (review.addNodes.length > 0) {
			return insertNodesBefore(base, currentNodeId, review.addNodes.map((n) => ({ id: n.id, title: n.title, facts: n.facts.map((f) => planFact(f, graphIdOf)) })));
		}
		const checked = createTree(base.nodes, base.edges, arrows.length > 0 ? arrows : undefined);
		return { ...checked, version: tree.version + 1 };
	};
	try {
		treeOf((id) => `pending:${id}`);
	} catch (err) {
		if (err instanceof PlanTreeError) return verdictsOnly(err.message);
		throw err;
	}
	const graphOf = new Map(tree.nodes.flatMap((n) => (n.facts ?? []).map((f) => [f.id, f.graphId] as const)));
	return {
		judged,
		plannedFacts: [...review.addFacts, ...review.addNodes.flatMap((n) => n.facts)].map(plannedFact),
		plannedArrows: added.map((a) => ({ premises: a.premises.map((p) => graphOf.get(p) ?? p), conclusion: graphOf.get(a.conclusion) ?? a.conclusion })),
		problem: null,
		build: (ids) => ({ tree: treeOf((id) => ids[id]!), insertedNodeIds: review.addNodes.map((n) => n.id) }),
	};
}

/** After the mentor inserted nodes before the current one: the node
 *  handoff (CONTINUE template) to the node to teach next (nextPlanNode —
 *  normally the first inserted node), carrying `lastCard`. null when that
 *  node is the current node itself or there is none (the caller then
 *  falls back to the ordinary advance rule). */
export function insertedNodeHandoff(args: {
	tree: PlanTree;
	events: readonly EvidenceEvent[];
	currentNodeId: string;
	lastCard: string | null;
}): LhMarkerMessage | null {
	const { tree, events, currentNodeId, lastCard } = args;
	const knowledge = knowledgeOf(events);
	const next = nextPlanNode(tree, knowledge);
	if (!next || next.id === currentNodeId) return null;
	return newNodeHandoffMessage(next.id, nodeHandoffText({
		tree,
		nodeId: next.id,
		knowledge,
		first: false,
		road: roadRecord(tree, events, knowledge, next.id),
		lastCard,
	}));
}
