/**
 * The lesson progress payload (coach-planner design §4.10): one derived,
 * read-only object the server adds to the chat GET and the page props, so
 * the client can draw plan-node states, the Start button, the legacy
 * notice and the coverage gate without seeing hidden markers or the
 * evidence ledger. Pure and browser-safe: the server passes the evidence
 * events (graphStore.readEvidence()); the client only reads the result.
 */

import type { ChatKind, EvidenceEvent, PlanTree } from "./contracts.ts";
import { knowledgeFor, knowledgeOf, nodePassed, nodeProgress } from "./knowledge.ts";
import { agentKindFor, hasUnresolvedQuestion, isLegacyTeachRecord, type LhMessage, type TeachingAgentKind } from "./native-messages.ts";
import { currentPlanNodeId, nextPlanNode } from "./plan-progress.ts";

export interface LessonProgress {
	/** The agent the next turn builds; null for practice and build sessions. */
	agentKind: TeachingAgentKind | null;
	/** A teach session from before the coach update (isLegacyTeachRecord). */
	legacy: boolean;
	/** The Start button applies: the planner presented a plan with a node
	 *  left to teach, no question is open and no turn is running. */
	canAcceptPlan: boolean;
	/** The plan node the teacher is on (latest node-handoff); null before. */
	currentNodeId: string | null;
	/** Per plan node id: passed, and the fraction of its facts at the pass line. */
	nodes: Record<string, { passed: boolean; progress: number }>;
	/** Per plan fact id: the knowledge number, graded answers, misconception flag. */
	facts: Record<string, { p: number; attempts: number; misconception: boolean }>;
}

/** The payload for a session that is not a teaching session. */
const NOT_TEACHING: LessonProgress = {
	agentKind: null,
	legacy: false,
	canAcceptPlan: false,
	currentNodeId: null,
	nodes: {},
	facts: {},
};

/** Derive the lesson progress of one chat record from the evidence ledger.
 *  `options.turnRunning` is the live turn registry's answer (the server
 *  knows it; the record does not) — a running turn never offers Start. */
export function lessonProgress(
	record: { kind?: ChatKind; messages: readonly LhMessage[]; tree?: PlanTree | null },
	events: readonly EvidenceEvent[],
	options: { turnRunning?: boolean } = {},
): LessonProgress {
	if ((record.kind ?? "teach") !== "teach") return { ...NOT_TEACHING, nodes: {}, facts: {} };
	const { messages } = record;
	const tree = record.tree ?? null;
	const legacy = isLegacyTeachRecord(messages);
	const agentKind = agentKindFor(messages);
	const knowledge = knowledgeOf(events);
	const nodes: LessonProgress["nodes"] = {};
	const facts: LessonProgress["facts"] = {};
	for (const node of tree?.nodes ?? []) {
		nodes[node.id] = { passed: nodePassed(node, knowledge), progress: nodeProgress(node, knowledge) };
		for (const fact of node.facts ?? []) {
			const state = knowledgeFor(knowledge, fact.graphId);
			facts[fact.id] = { p: state.p, attempts: state.attempts, misconception: state.misconception };
		}
	}
	const canAcceptPlan =
		!legacy &&
		agentKind === "planner" &&
		!!tree &&
		tree.nodes.length > 0 &&
		nextPlanNode(tree, knowledge) !== null &&
		!hasUnresolvedQuestion(messages) &&
		options.turnRunning !== true;
	return { agentKind, legacy, canAcceptPlan, currentNodeId: currentPlanNodeId(messages), nodes, facts };
}

/** Teaching sessions created under the coach design run no automatic
 *  extraction (design D12), so their coverage ring and menu block hide.
 *  Legacy teach sessions and non-teaching sources keep them. */
export function hidesCoverage(progress: LessonProgress | null | undefined): boolean {
	return !!progress && progress.agentKind !== null && !progress.legacy;
}

/** Uses the coach-design node states (passed / current / upcoming) instead
 *  of the legacy tagged-call derivation: a current node exists, or the
 *  tree's nodes carry facts. */
export function usesLessonStatuses(tree: PlanTree, progress: LessonProgress | null | undefined): boolean {
	if (!progress || progress.legacy) return false;
	return progress.currentNodeId !== null || tree.nodes.some((n) => (n.facts?.length ?? 0) > 0);
}
