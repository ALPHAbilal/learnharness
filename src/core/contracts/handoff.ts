/**
 * Handoff contracts (coach-planner design §4.6/§4.7): the fixed,
 * app-filled texts that open a fresh context — the node handoff (START /
 * CONTINUE), the planner brief and the coach card — plus the road record
 * they share. Single-sourced here; the markers that carry them live in
 * native-messages.ts.
 *
 * Every builder is pure and takes a typed input object. Each text flattens
 * to a USER-role message on the wire, so it opens with a bracket tag (the
 * preamble law). Percentages are Math.round(p * 100). A section with no
 * entries is left out entirely, heading included.
 */

import type { PlanNode, PlanTree } from "./plan.ts";
import type { EvidenceEvent } from "./graph.ts";
import type { ProbeAssessment } from "./probe.ts";
import { knowledgeFor, nodePassed, type FactKnowledge } from "../knowledge.ts";

/** The folded evidence per graph node id (knowledge.ts knowledgeOf). */
type Knowledge = ReadonlyMap<string, FactKnowledge>;

const MISCONCEPTION_FLAG = "  ⚠ answered wrong with high confidence";
const FACT_LEGEND = "(id — statement — how sure the app is that the learner knows it):";

function percent(p: number): number {
	return Math.round(p * 100);
}

/** Join non-empty sections with one blank line between them. */
function joinSections(sections: ReadonlyArray<readonly string[] | null>): string {
	return sections.filter((s): s is readonly string[] => s !== null && s.length > 0).map((s) => s.join("\n")).join("\n\n");
}

/** A heading plus its entries, or null when there are no entries. */
function section(heading: string, entries: readonly string[]): string[] | null {
	return entries.length > 0 ? [heading, ...entries] : null;
}

function factLine(id: string, statement: string, p: number, misconception: boolean): string {
	return `- [${id}] ${statement} — ${percent(p)}%${misconception ? MISCONCEPTION_FLAG : ""}`;
}

/** " (after: a, b)" for a node with prerequisite nodes (the sources of its
 *  incoming edges, in edge order, deduplicated); "" otherwise. */
function afterSuffix(tree: PlanTree, nodeId: string): string {
	const prerequisites = [...new Set(tree.edges.filter((e) => e.to === nodeId).map((e) => e.from))];
	return prerequisites.length > 0 ? ` (after: ${prerequisites.join(", ")})` : "";
}

function passedSuffix(node: PlanNode, knowledge: Knowledge): string {
	return nodePassed(node, knowledge) ? "  ✓ passed" : "";
}

// ─── the road record ─────────────────────────────────────────────────────────

/** One past node, as the road record shows it. */
export interface RoadEntry {
	nodeId: string;
	title: string;
	passed: boolean;
	/** Statements of the node's facts that drew at least one wrong or
	 *  "I don't know" answer. */
	hardFacts: string[];
}

/** The road so far: one entry per node that comes before `uptoNodeId` in
 *  `tree.nodes` order (none when `uptoNodeId` is not in the tree). A fact
 *  is hard when any of `events` about its graph node is wrong or
 *  "I don't know". */
export function roadRecord(tree: PlanTree, events: readonly EvidenceEvent[], knowledge: Knowledge, uptoNodeId: string): RoadEntry[] {
	const end = tree.nodes.findIndex((n) => n.id === uptoNodeId);
	if (end < 0) return [];
	return roadEntries(tree.nodes.slice(0, end), events, knowledge);
}

/** The road record of the WHOLE tree, every node in `tree.nodes` order
 *  (the planner brief: the planner plans on from all of it). */
export function wholeRoadRecord(tree: PlanTree, events: readonly EvidenceEvent[], knowledge: Knowledge): RoadEntry[] {
	return roadEntries(tree.nodes, events, knowledge);
}

function roadEntries(nodes: readonly PlanNode[], events: readonly EvidenceEvent[], knowledge: Knowledge): RoadEntry[] {
	const missed = new Set(events.filter((e) => e.correct === false || e.dontKnow === true).map((e) => e.nodeId));
	return nodes.map((node) => ({
		nodeId: node.id,
		title: node.title,
		passed: nodePassed(node, knowledge),
		hardFacts: (node.facts ?? []).filter((f) => missed.has(f.graphId)).map((f) => f.statement),
	}));
}

/** One line per road entry (the handoffs, the planner brief and the
 *  mentor's review request share the layout). */
export function roadLines(road: readonly RoadEntry[]): string[] {
	return road.map((r) => `- ${r.title}: ${r.passed ? "passed" : "not passed"}${r.hardFacts.length > 0 ? `; needed more than one try: ${r.hardFacts.join("; ")}` : ""}`);
}

// ─── the node handoff (START / CONTINUE) ─────────────────────────────────────

/** What the node-handoff marker text is built from. */
export interface NodeHandoffInput {
	/** The stored plan tree (with facts and arrows). */
	tree: PlanTree;
	/** The node the teacher starts now. */
	nodeId: string;
	/** The folded evidence per graph node id; a fact without evidence reads
	 *  as the prior. */
	knowledge: Knowledge;
	/** True for the plan's first handoff (the START template); false for
	 *  every later node (CONTINUE). */
	first: boolean;
	/** The road record of the nodes before this one (roadRecord). Shown
	 *  only when `first` is false. */
	road: RoadEntry[];
	/** The latest coach card's text since the previous handoff, or null.
	 *  Shown only when `first` is false. */
	lastCard: string | null;
}

/** The model-facing text of the node-handoff marker. */
export function nodeHandoffText(input: NodeHandoffInput): string {
	const { tree, nodeId, knowledge, first, road, lastCard } = input;
	const node = tree.nodes.find((n) => n.id === nodeId);
	const facts = node?.facts ?? [];
	const factsById = new Map<string, { statement: string; graphId: string }>();
	for (const n of tree.nodes) for (const f of n.facts ?? []) factsById.set(f.id, f);
	const statementOf = (id: string) => factsById.get(id)?.statement ?? id;

	const own = new Set(facts.map((f) => f.id));
	const arrows = (tree.arrows ?? []).filter((a) => own.has(a.conclusion));
	const premiseIds = new Set(arrows.flatMap((a) => a.premises).filter((id) => !own.has(id)));
	const underneath: string[] = [];
	for (const n of tree.nodes) {
		if (n.id === nodeId) continue;
		for (const f of n.facts ?? []) {
			if (!premiseIds.has(f.id)) continue;
			premiseIds.delete(f.id); // deduplicated: a fact id appears once
			underneath.push(`- ${f.statement} — ${percent(knowledgeFor(knowledge, f.graphId).p)}%`);
		}
	}

	return joinSections([
		["[Node handoff] — written by the app, not the learner speaking."],
		[`You are starting ${first ? "the first node of the plan." : "the next node of the plan."}`],
		section("The map:", tree.nodes.map((n) => `- ${n.id}: ${n.title}${afterSuffix(tree, n.id)}${passedSuffix(n, knowledge)}${n.id === nodeId ? "  ← you are here" : ""}`)),
		section(`This node's facts ${FACT_LEGEND}`, facts.map((f) => {
			const k = knowledgeFor(knowledge, f.graphId);
			return factLine(f.id, f.statement, k.p, k.misconception);
		})),
		section("Arrows into these facts (premises ⇒ conclusion):", arrows.map((a) => `- ${a.premises.map(statementOf).join(" + ")} ⇒ ${statementOf(a.conclusion)}`)),
		section("What the learner already holds underneath (facts these stand on, from other nodes):", underneath),
		first ? null : section("The road so far:", roadLines(road)),
		first || !lastCard ? null : ["The coach's last card:", lastCard],
	]);
}

// ─── the planner brief ───────────────────────────────────────────────────────

/** What the planner brief (the planner-wake text) is built from. */
export interface PlannerBriefInput {
	/** The learner's goal, in their own words (plan-progress goalOf). */
	goal: string;
	/** The concluded probe_done assessment, or null. */
	assessment: ProbeAssessment | null;
	/** The stored plan tree, or null. */
	tree: PlanTree | null;
	knowledge: Knowledge;
	road: RoadEntry[];
	/** The coach's notes for the planner. */
	notes: string[];
}

/** The model-facing text the planner reads when it is woken for the next
 *  stretch of the road. */
export function plannerBriefText(input: PlannerBriefInput): string {
	const { goal, assessment, tree, knowledge, road, notes } = input;
	const assessmentLines = [
		...(assessment?.strands ?? []).map((s) => `- ${s.strand}: ${s.assessment}`),
		...(assessment?.summary ? [`Summary: ${assessment.summary}`] : []),
	];
	const mapLines = (tree?.nodes ?? []).flatMap((n) => [
		`- ${n.id}: ${n.title}${afterSuffix(tree!, n.id)}${passedSuffix(n, knowledge)}`,
		...(n.facts ?? []).map((f) => `  - [${f.id}] (${f.graphId}) ${f.statement} — ${percent(knowledgeFor(knowledge, f.graphId).p)}%`),
	]);
	return joinSections([
		["[Planner brief] — written by the app, not the learner speaking."],
		["The next stretch of the road is needed. Plan at most 4 more nodes with plan_batch, continuing from the map below."],
		goal ? ["Goal (the learner's own words):", goal] : null,
		section("The prober's assessment:", assessmentLines),
		section("The map so far (node — its facts with their graph id and how sure the app is):", mapLines),
		section("The road so far:", roadLines(road)),
		section("The coach's notes:", notes.map((n) => `- ${n}`)),
	]);
}

// ─── the coach card ──────────────────────────────────────────────────────────

/** What the coach-card marker text is built from. */
export interface CoachCardInput {
	phase: "probe" | "teach";
	facts: { id: string; statement: string; p: number; misconception: boolean }[];
	notes: string[];
	askLearner: string | null;
}

/** The model-facing text of the coach-card marker. */
export function coachCardText(input: CoachCardInput): string {
	const { phase, facts, notes, askLearner } = input;
	return joinSections([
		["[Coach card] — written by the app from the coach's review, not the learner speaking."],
		section(`${phase === "probe" ? "Facts to test" : "This node's facts"} ${FACT_LEGEND}`, facts.map((f) => factLine(f.id, f.statement, f.p, f.misconception))),
		section("Notes:", notes.map((n) => `- ${n}`)),
		askLearner ? [`Ask the learner: ${askLearner}`] : null,
	]);
}
