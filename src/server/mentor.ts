/**
 * THE MENTOR STEP (coach-planner design §4.5): the server half of the
 * learner's "Coach". After a learner answer is saved and its evidence
 * stamped, the answer request awaits one mentor review (on the session's
 * own engine, inside the answer's claimed turn), then the app applies it:
 *
 *   1. gather the review request from the record (core/mentor-input.ts)
 *      and run the mentor (agent/subagents/mentor.ts, or an injected
 *      runner in tests); `mentor-changed` brackets the call;
 *   2. plan the changes (core/mentor-apply.ts applyReview), write the new
 *      facts and arrows to the knowledge graph (writePlannedFacts +
 *      settleGraphLayout), save the tree or probe fact list;
 *   3. turn the own-words verdicts into evidence (judgedEvidence,
 *      idempotent through unstampedEvidence);
 *   4. build the markers: a plan-update when the tree changed, then the
 *      coach-card (always, even without a review — its numbers are the
 *      app's);
 *   5. record the model calls' usage, tied to the card.
 *
 * Failures inside never throw: a failed review is a null review. An abort
 * returns `aborted: true` with no markers (the answer and its evidence are
 * already saved).
 *
 * Teaching only: the probe has no mentor (the prober owns its map —
 * agent/tools/probe-map.ts).
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { EvidenceEvent, LhMarkerMessage, LhMessage, PlanTree } from "../core/index.ts";
import type { ProbeFacts } from "../core/contracts/chat.ts";
import { coachCardText } from "../core/contracts/handoff.ts";
import { mentorInputText, type MentorReview } from "../core/contracts/mentor.ts";
import { emit } from "../core/events.ts";
import { factResolver, judgedEvidence, unstampedEvidence, type AnsweredQuestion } from "../core/evidence.ts";
import { getGraph, writePlannedFacts } from "../core/graph.ts";
import { knowledgeFor, knowledgeOf } from "../core/knowledge.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import { applyReview } from "../core/mentor-apply.ts";
import { mentorInputOf, mentorValidationContextOf } from "../core/mentor-input.ts";
import { newCoachCardMessage, newPlanUpdateMessage } from "../core/native-messages.ts";
import { currentPlanNodeId } from "../core/plan-progress.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import type { PiEngine } from "../agent/models.ts";
import type { MentorRunArgs } from "../agent/subagents/mentor.ts";

/** The mentor call the step makes: production runs agent/subagents/mentor
 *  runMentor; tests inject their own (the handler's seam). */
export type MentorRunner = (args: MentorRunArgs) => Promise<MentorReview | null>;

// ─── the registry (module-global on globalThis, compaction's pattern) ───────

interface MentorState {
	inFlight: Set<string>;
}
const g = globalThis as typeof globalThis & { __lhMentor?: MentorState };
function state(): MentorState {
	return (g.__lhMentor ??= { inFlight: new Set() });
}

/** Is the mentor reviewing an answer for this chat right now? (The
 *  `coaching` snapshot flag of the chat GET payloads and page props.) */
export function mentorInFlight(chatId: string): boolean {
	return state().inFlight.has(chatId);
}

// ─── the step ────────────────────────────────────────────────────────────────

export interface MentorStepArgs {
	chatId: string;
	/** Teaching only (the probe has no mentor). */
	phase: "teach";
	/** The saved record messages, the answer included. */
	saved: readonly LhMessage[];
	/** The answer under review. */
	latest: AnsweredQuestion;
	/** The evidence ledger after this answer was stamped. */
	events: readonly EvidenceEvent[];
	/** The session's conversation engine (the mentor's engine). */
	engine: PiEngine;
	/** provider:id of the engine (usage stamps). */
	modelId: string;
	/** The mentor's composed instructions. */
	systemPrompt: string;
	/** The answer turn's preparation signal (the abort route). */
	signal: AbortSignal;
	/** The mentor call; null = no model call (a null review). */
	run: MentorRunner | null;
	stores: { chatStore: ChatStore; graphStore: GraphStore };
}

export interface MentorStepOutcome {
	/** The preparation was aborted: nothing more is appended. */
	aborted: boolean;
	/** plan-update (when the tree changed), then the coach-card. */
	markers: LhMarkerMessage[];
	/** The tree after the review (the saved one). */
	tree: PlanTree | undefined;
	/** The evidence ledger after the review's verdicts. */
	events: EvidenceEvent[];
	/** The review's notes ([] without a review). */
	notes: string[];
	/** Ids of nodes the review inserted before the current node. */
	insertedNodeIds: string[];
	/** The current plan node (teach), else null. */
	currentNodeId: string | null;
}

function stepOf(usage: Usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		reasoningTokens: usage.reasoning ?? 0,
	};
}

/** Run the mentor for one saved answer and apply its review. */
export async function runMentorStep(args: MentorStepArgs): Promise<MentorStepOutcome> {
	const { chatId, phase, saved, latest, engine, modelId, systemPrompt, signal, run, stores } = args;
	const { chatStore, graphStore } = stores;
	let events = [...args.events];
	const record = chatStore.getChat(chatId);
	let tree = record?.tree;
	let probeFacts: ProbeFacts | undefined = record?.probeFacts;
	const currentNodeId = phase === "teach" ? currentPlanNodeId(saved) : null;
	const usages: Usage[] = [];

	// 1. The review.
	let review: MentorReview | null = null;
	if (run) {
		let runArgs: MentorRunArgs | null = null;
		try {
			const graphNodes = getGraph(graphStore).nodes;
			const input = mentorInputText(mentorInputOf({ chatId, phase, messages: saved, tree, probeFacts, events, graphNodes, latest }));
			const context = mentorValidationContextOf({ phase, tree, probeFacts, latest, liveGraphIds: new Set(graphStore.readNodes().map((n) => n.id)) });
			runArgs = { engine, systemPrompt, input, context, signal, onUsage: (usage) => usages.push(usage) };
		} catch (err) {
			console.error(`[chat ${chatId}] mentor input failed:`, err);
		}
		if (runArgs) {
			state().inFlight.add(chatId);
			emit("mentor-changed", { chatId, running: true });
			try {
				review = await run(runArgs);
			} catch (err) {
				console.error(`[chat ${chatId}] mentor failed:`, err);
				review = null;
			} finally {
				state().inFlight.delete(chatId);
				emit("mentor-changed", { chatId, running: false });
			}
		}
	}
	if (signal.aborted) {
		recordUsage(chatStore, chatId, modelId, latest.messageId, usages);
		return { aborted: true, markers: [], tree, events, notes: [], insertedNodeIds: [], currentNodeId };
	}

	// 2. The structural changes.
	const markers: LhMarkerMessage[] = [];
	let insertedNodeIds: string[] = [];
	let judged: { factId: string; correct: boolean }[] = [];
	try {
		const plan = applyReview({ phase, review, tree, probeFacts, currentNodeId, latest });
		judged = plan.judged;
		if (plan.problem) console.warn(`[chat ${chatId}] mentor additions dropped: ${plan.problem}`);
		if (plan.plannedFacts.length > 0 || plan.plannedArrows.length > 0) {
			let ids: Record<string, string> | null = null;
			try {
				ids = writePlannedFacts(chatId, plan.plannedFacts, plan.plannedArrows, { chatStore, graphStore }).ids;
				settleGraphLayout(graphStore);
			} catch (err) {
				console.error(`[chat ${chatId}] mentor graph write failed:`, err);
			}
			if (ids) {
				const built = plan.build(ids);
				if (built.tree) {
					chatStore.saveTree(chatId, built.tree);
					tree = built.tree;
					markers.push(newPlanUpdateMessage(built.tree));
				}
				if (built.probeFacts) {
					chatStore.saveProbeFacts(chatId, built.probeFacts);
					probeFacts = built.probeFacts;
				}
				insertedNodeIds = built.insertedNodeIds;
			}
		}
	} catch (err) {
		console.error(`[chat ${chatId}] mentor review apply failed:`, err);
	}

	// 3. The verdicts on an own-words answer.
	if (judged.length > 0) {
		try {
			const resolve = factResolver({ tree, probeFacts });
			const resolved = judged.flatMap((j) => {
				const graphId = resolve(j.factId);
				return graphId ? [{ graphId, correct: j.correct }] : [];
			});
			const fresh = unstampedEvidence(events, judgedEvidence({
				chatId,
				messageId: latest.messageId,
				at: new Date().toISOString(),
				source: latest.tool === "recall" ? "recall" : "quiz",
				judged: resolved,
			}));
			for (const event of fresh) graphStore.appendEvidence(event);
			events = [...events, ...fresh];
		} catch (err) {
			console.error(`[chat ${chatId}] mentor verdicts failed:`, err);
		}
	}

	// 4. The card: the app's numbers, the review's notes and question.
	const knowledge = knowledgeOf(events);
	const cardFacts = (phase === "teach" ? (tree?.nodes.find((n) => n.id === currentNodeId)?.facts ?? []) : (probeFacts?.facts ?? [])).map((f) => {
		const k = knowledgeFor(knowledge, f.graphId);
		return { id: f.id, statement: f.statement, p: k.p, misconception: k.misconception };
	});
	const notes = review?.notes ?? [];
	const askLearner = review?.askLearner ?? null;
	const card = newCoachCardMessage(coachCardText({ phase, facts: cardFacts, notes, askLearner }), { phase, nodeId: currentNodeId, notes, askLearner });
	markers.push(card);

	// 5. The money channel.
	recordUsage(chatStore, chatId, modelId, card.id, usages);
	return { aborted: false, markers, tree, events, notes, insertedNodeIds, currentNodeId };
}

/** One usage entry per model call, keyed to `messageId` (the card; the
 *  answer when the step was aborted before a card existed). */
function recordUsage(chatStore: ChatStore, chatId: string, modelId: string, messageId: string, usages: readonly Usage[]): void {
	for (const usage of usages) {
		try {
			chatStore.appendTurnUsage(chatId, { id: crypto.randomUUID(), messageId, at: new Date().toISOString(), model: modelId, steps: [stepOf(usage)] });
		} catch (err) {
			console.error(`[chat ${chatId}] mentor usage failed:`, err);
		}
	}
}
