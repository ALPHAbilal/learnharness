/**
 * Plan progress (coach-planner design §4.3/§4.6/§4.7): which plan node the
 * teacher works on next, from the stored tree and the folded evidence, and
 * the record reads the handoff templates need. Pure and browser-safe.
 */

import type { EvidenceEvent, PlanNode, PlanTree, ProbeAssessment } from "./contracts.ts";
import { nodeHandoffText, plannerBriefText, roadRecord, wholeRoadRecord } from "./contracts/handoff.ts";
import { knowledgeOf, nodePassed, type FactKnowledge } from "./knowledge.ts";
import {
	agentKindFor,
	hasUnresolvedQuestion,
	newNodeHandoffMessage,
	newPlannerWakeMessage,
	probeDoneResultIds,
	type LhMarkerMessage,
	type LhMessage,
	type NodeHandoffDetails,
} from "./native-messages.ts";
import { parseProbeDoneInput } from "./tool-parts.ts";

/** The next node to teach: the first node, in `tree.nodes` order, that has
 *  not passed and whose prerequisite nodes (the sources of its incoming
 *  edges) have all passed. null when there is none. */
export function nextPlanNode(tree: PlanTree, knowledge: ReadonlyMap<string, FactKnowledge>): PlanNode | null {
	const byId = new Map(tree.nodes.map((n) => [n.id, n]));
	for (const node of tree.nodes) {
		if (nodePassed(node, knowledge)) continue;
		const prerequisites = tree.edges.filter((e) => e.to === node.id).map((e) => byId.get(e.from));
		if (prerequisites.every((p) => p !== undefined && nodePassed(p, knowledge))) return node;
	}
	return null;
}

/** The node the teacher is on: `details.nodeId` of the latest node-handoff
 *  marker; null when the record has none. */
export function currentPlanNodeId(messages: readonly LhMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "custom" || m.customType !== "node-handoff") continue;
		const nodeId = (m.details as Partial<NodeHandoffDetails> | null)?.nodeId;
		return typeof nodeId === "string" ? nodeId : null;
	}
	return null;
}

/** What happens after a graded answer on the current node. */
export type AdvanceDecision =
	/** The current node has not passed. */
	| { kind: "stay" }
	/** Passed; teach this node next. */
	| { kind: "next"; node: PlanNode }
	/** Passed; the planner must run before teaching continues. */
	| { kind: "wake-planner" };

/** The advance rule (coach-planner design §4.7, D11): stay until the
 *  current node passes. Once it has, wake the planner when at most one
 *  node of the tree is still unpassed (one node of the batch left, or the
 *  plan is exhausted); otherwise move to nextPlanNode — or wake the
 *  planner when no node is ready although several are unpassed. */
export function advanceAfterAnswer(tree: PlanTree, knowledge: ReadonlyMap<string, FactKnowledge>, currentNodeId: string): AdvanceDecision {
	const current = tree.nodes.find((n) => n.id === currentNodeId);
	if (!current || !nodePassed(current, knowledge)) return { kind: "stay" };
	const unpassed = tree.nodes.filter((n) => !nodePassed(n, knowledge)).length;
	if (unpassed <= 1) return { kind: "wake-planner" };
	const node = nextPlanNode(tree, knowledge);
	return node ? { kind: "next", node } : { kind: "wake-planner" };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => b.text)
		.join("\n");
}

/** The learner's goal: the text of the record's first learner message
 *  (user role; markers are custom-role and never count). "" when none. */
export function goalOf(messages: readonly LhMessage[]): string {
	for (const m of messages) if (m.role === "user") return textOf(m.content);
	return "";
}

/** The prober's assessment: the arguments of the concluded probe_done call
 *  (the call whose successful result probeDoneResultIds accepts). null when
 *  the probe has not concluded or the arguments do not parse. */
export function probeAssessmentOf(messages: readonly LhMessage[]): ProbeAssessment | null {
	const resultIds = probeDoneResultIds(messages);
	for (const m of messages) {
		if (m.role !== "toolResult" || !resultIds.has(m.id)) continue;
		for (const owner of messages) {
			if (owner.role !== "assistant" || owner.stopReason === "error" || owner.stopReason === "aborted") continue;
			const call = owner.content.find((b) => b.type === "toolCall" && b.id === m.toolCallId && b.name === "probe_done");
			if (call?.type === "toolCall") return parseProbeDoneInput(call.arguments)?.assessment ?? null;
		}
	}
	return null;
}

/** The advance rule after a learner answer (coach-planner design §4.6/§4.7),
 *  app-side and model-free: the markers to append after the answer's tool
 *  result. Applies only while the teacher is on a node (agentKindFor is
 *  "teacher", a tree and a current node exist) and no question is still
 *  open; otherwise []. `messages` includes the just-saved answer and
 *  `events` the just-stamped evidence.
 *  - stay → [];
 *  - next → one node-handoff (CONTINUE) for the next node, with the road
 *    record up to it and the latest coach card since the previous handoff;
 *  - wake-planner → one planner-wake carrying the planner brief (goal,
 *    probe assessment, the plan with numbers, the road record of the whole
 *    tree, the coach's notes). */
export function advanceAppends(args: {
	messages: readonly LhMessage[];
	tree: PlanTree | null | undefined;
	events: readonly EvidenceEvent[];
	/** Coach notes for a planner brief ([] until the coach exists). */
	notes: string[];
}): LhMarkerMessage[] {
	const { messages, tree, events, notes } = args;
	if (!tree || agentKindFor(messages) !== "teacher" || hasUnresolvedQuestion(messages)) return [];
	const currentNodeId = currentPlanNodeId(messages);
	if (currentNodeId === null) return [];
	const knowledge = knowledgeOf(events);
	const decision = advanceAfterAnswer(tree, knowledge, currentNodeId);
	if (decision.kind === "stay") return [];
	if (decision.kind === "next") {
		const previousHandoff = messages.findLastIndex((m) => m.role === "custom" && m.customType === "node-handoff");
		const card = messages.slice(previousHandoff + 1).findLast((m) => m.role === "custom" && m.customType === "coach-card");
		return [newNodeHandoffMessage(decision.node.id, nodeHandoffText({
			tree,
			nodeId: decision.node.id,
			knowledge,
			first: false,
			road: roadRecord(tree, events, knowledge, decision.node.id),
			lastCard: card?.role === "custom" ? card.content : null,
		}))];
	}
	return [newPlannerWakeMessage(plannerBriefText({
		goal: goalOf(messages),
		assessment: probeAssessmentOf(messages),
		tree,
		knowledge,
		road: wholeRoadRecord(tree, events, knowledge),
		notes,
	}))];
}
