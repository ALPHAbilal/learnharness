/**
 * Fact tags on graded questions (coach-planner design §4.4): the call-time
 * checks that a question's `facts` name real facts — of the node the
 * teacher is on, or of the probe map while probing. Pure: the tools
 * (agent/tools.ts, agent/plugin-question-tools.ts) read the live record and
 * hand it here; every problem is a model-readable sentence the tool returns
 * as an invalid-input result.
 */

import type { PlanTree } from "./contracts/plan.ts";
import type { ProbeFacts } from "./contracts/chat.ts";
import type { EvidenceEvent } from "./contracts/graph.ts";
import { answeredQuestionsIn, type AnsweredQuestion } from "./evidence.ts";
import type { LhMessage } from "./native-messages.ts";
import { currentPlanNodeId } from "./plan-progress.ts";
import {
	forcedFactLine,
	forcedNextFact,
	openFactsText,
	probeAnswerCounts,
	probeAnswers,
	probeComplete,
	unplacedFacts,
	whyNotOpen,
	type ProbeCounts,
} from "./probe-edge.ts";

function listing(ids: readonly string[]): string {
	return ids.join(", ");
}

/** The teacher's tag rules, given the live record:
 *  1. `nodeId` must be the current node (currentPlanNodeId);
 *  2. every id in `facts` must be a fact of that node;
 *  3. with `factsRequired`, `facts` must be present and non-empty when the
 *     node has facts (the plugin teach tools, whose schema keeps `facts`
 *     optional).
 *  null when there is no current node (no node-handoff yet): the caller
 *  keeps its plain node-existence check. A node without facts skips 2/3. */
export function teachFactProblems(
	record: { tree?: PlanTree | null; messages: readonly LhMessage[] },
	nodeId: string,
	facts: readonly string[] | undefined,
	opts: { factsRequired: boolean },
): string[] | null {
	const current = currentPlanNodeId(record.messages);
	if (current === null) return null;
	if (nodeId !== current) return [`nodeId "${nodeId}" is not the node you are teaching. The current node is "${current}". Use it.`];
	const own = (record.tree?.nodes.find((n) => n.id === nodeId)?.facts ?? []).map((f) => f.id);
	if (own.length === 0) return [];
	if (!facts || facts.length === 0) {
		return opts.factsRequired
			? [`facts is required: list the id(s) of the fact(s) this question tests. This node's facts are: ${listing(own)}`]
			: [];
	}
	return facts
		.filter((id) => !own.includes(id))
		.map((id) => `fact "${id}" is not a fact of node "${nodeId}". This node's facts are: ${listing(own)}`);
}

/** Where the probe stands, for the prober's tools (the prober owns the
 *  map; the app keeps the rules that stop it running away):
 *  - "legacy": a probe list without `marks` (an empty fallback list, or a
 *    map from before draw_map): nothing is enforced;
 *  - "before-opening": the opening ask_user_question is not answered yet;
 *  - "no-map": no map drawn yet (draw_map);
 *  - "unreflected": the latest graded probe answer awaits `reflect`;
 *  - "open": questions are due on the `unplaced` facts;
 *  - "complete": every fact is placed, or the question budget is spent. */
export type ProbeGate =
	| { mode: "legacy" }
	| { mode: "before-opening" }
	| { mode: "no-map" }
	| { mode: "unreflected"; map: ProbeFacts; answer: AnsweredQuestion }
	| { mode: "open"; map: ProbeFacts; counts: ProbeCounts; asked: number; unplaced: string[] }
	| { mode: "complete"; map: ProbeFacts; counts: ProbeCounts; asked: number };

/** Has the learner answered (or dismissed) the opening ask_user_question? */
export function openingAnswered(messages: readonly LhMessage[]): boolean {
	return answeredQuestionsIn(messages, messages).some((a) => a.tool === "ask_user_question");
}

/** The gate over the LIVE record and the evidence ledger (`events` may
 *  hold the whole ledger; only this chat's probe evidence counts). */
export function probeGateOf(
	record: { probeFacts?: ProbeFacts | null; messages: readonly LhMessage[] },
	events: readonly EvidenceEvent[],
	chatId: string,
): ProbeGate {
	const map = record.probeFacts;
	if (map && !map.marks) return { mode: "legacy" };
	if (!openingAnswered(record.messages)) return { mode: "before-opening" };
	if (!map) return { mode: "no-map" };
	const answers = probeAnswers(record.messages);
	const latest = answers.at(-1);
	if (latest && latest.messageId !== map.reflected) return { mode: "unreflected", map, answer: latest };
	const counts = probeAnswerCounts(map, events, chatId);
	// A voided answer (reflect's `void`) does not count toward the budget.
	const asked = answers.filter((a) => !map.voided?.includes(a.messageId)).length;
	if (probeComplete(map, counts, asked)) return { mode: "complete", map, counts, asked };
	return { mode: "open", map, counts, asked, unplaced: unplacedFacts(map, counts) };
}

export const OPENING_FIRST = "Ask the opening question first with ask_user_question.";
export const MAP_FIRST = "Draw the map first with draw_map.";
export const REFLECT_FIRST = "Reflect on the last answer first with reflect.";
export const PROBE_COMPLETE = "The probe is complete. Call probe_done now.";

/** The prober's rules for `probe` / `recall` (probeGateOf): the opening
 *  question, then the map, then a reflect after every answer; `facts` is
 *  exactly ONE fact on the map that is not placed — the forced next fact
 *  (forcedNextFact) while there is one; once complete, only probe_done.
 *  A refusal says why, then lists the open facts and what each still
 *  needs. A legacy record enforces nothing. */
export function probeFactProblems(
	record: { probeFacts?: ProbeFacts | null; messages: readonly LhMessage[] } | null | undefined,
	facts: readonly string[] | undefined,
	events: readonly EvidenceEvent[],
	chatId: string,
): string[] {
	if (!record) return [];
	const gate = probeGateOf(record, events, chatId);
	switch (gate.mode) {
		case "legacy": return [];
		case "before-opening": return [OPENING_FIRST];
		case "no-map": return [MAP_FIRST];
		case "unreflected": return [REFLECT_FIRST];
		case "complete": return [PROBE_COMPLETE];
	}
	const tagged = facts ?? [];
	const forced = forcedNextFact(gate.map, gate.counts);
	if (tagged.length === 1 && gate.unplaced.includes(tagged[0]!) && (!forced || forced.id === tagged[0])) return [];
	const problems = tagged.length === 1
		? [whyNotOpen(gate.map, gate.counts, tagged[0]!)]
		: [`A question tests exactly one fact; you tagged ${tagged.length === 0 ? "none" : tagged.length}.`];
	if (forced && !problems.includes(forcedFactLine(forced))) problems.push(forcedFactLine(forced));
	return [...problems, openFactsText(gate.map, gate.counts)];
}

/** probe_done's refusal while the probe is still open: how many facts are
 *  not placed, the forced next fact (if any), and what each open fact
 *  still needs. */
export function probeNotCompleteText(map: ProbeFacts, counts: ProbeCounts, unplaced: readonly string[]): string {
	const forced = forcedNextFact(map, counts);
	return [
		`The probe is not complete: ${unplaced.length} fact(s) not placed.`,
		...(forced ? [forcedFactLine(forced)] : []),
		openFactsText(map, counts),
	].join("\n");
}

/** The prober's rule for ask_user_question: one opening question only. */
export function proberAskProblems(record: { probeFacts?: ProbeFacts | null; messages: readonly LhMessage[] } | null | undefined): string[] {
	if (!record) return [];
	if (record.probeFacts && !record.probeFacts.marks) return [];
	return openingAnswered(record.messages) ? ["One opening question only. Draw the map with draw_map."] : [];
}

/** A plugin teach pose's tag rules over the LIVE record (the
 *  PluginQuestionLedger's teach check): once a node-handoff exists, the
 *  teacher's rules with `facts` REQUIRED whenever the node has facts (the
 *  plugin schema keeps it optional for historical snapshots); in every case
 *  the node must exist in the plan map. */
export function pluginTeachTagProblems(
	record: { tree?: PlanTree | null; messages: readonly LhMessage[] } | null | undefined,
	nodeId: string,
	facts: readonly string[] | undefined,
): string[] {
	const tagged = record ? teachFactProblems(record, nodeId, facts, { factsRequired: true }) : null;
	if (tagged?.length) return tagged;
	return record?.tree?.nodes.some((node) => node.id === nodeId) ? [] : ["nodeId must identify a live node in this session's plan map."];
}
