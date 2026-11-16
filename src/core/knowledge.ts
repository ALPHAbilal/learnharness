/**
 * The knowledge number (coach-planner design §4.3): the probability that
 * the learner knows a fact, as a pure fold over the fact's evidence events
 * (contracts/graph.ts EvidenceEvent). Never stored — recomputed from the
 * evidence ledger on every read.
 *
 * Bayesian knowledge tracing with fixed parameters: every fact starts at
 * KNOWLEDGE_PRIOR; each graded answer updates it by Bayes' rule with slip
 * KNOWLEDGE_SLIP and the event's own guess probability. A plan node passes
 * when every one of its facts reaches KNOWLEDGE_PASS. Fading with time is
 * deferred (design D10).
 *
 * Pure and browser-safe: types only, no IO.
 */

import type { EvidenceEvent, PlanNode } from "./contracts.ts";

/** Where every fact starts (owner decision O1). */
export const KNOWLEDGE_PRIOR = 0.30;
/** The pass line: a fact at or above it counts as known (O1). */
export const KNOWLEDGE_PASS = 0.85;
/** Probability of a wrong answer although the fact is known. */
export const KNOWLEDGE_SLIP = 0.10;
/** Guess probability for typed code that passed its tests. */
export const GUESS_CODE = 0.05;
/** Guess probability for an own-words answer judged by the coach. */
export const GUESS_FREE_TEXT = 0.10;
/** A wrong answer given with at least this confidence raises the
 *  misconception flag. */
export const MISCONCEPTION_CONFIDENCE = 90;

/** The folded state of one fact. */
export interface FactKnowledge {
	/** Probability the learner knows the fact. */
	p: number;
	/** Graded answers folded in. */
	attempts: number;
	/** Whether the most recent answer was right; null before any. */
	lastCorrect: boolean | null;
	/** The most recent answer was wrong (not "I don't know") with
	 *  confidence >= MISCONCEPTION_CONFIDENCE. */
	misconception: boolean;
}

/** Guess probability for a multiple-choice question: 1/n for single-select,
 *  1/(2^n − 1) for multi-select (any non-empty subset), clamped into
 *  [0.01, 0.5]. */
export function guessForChoice(optionCount: number, multiSelect: boolean): number {
	const raw = multiSelect ? 1 / (2 ** optionCount - 1) : 1 / optionCount;
	if (!Number.isFinite(raw) || raw > 0.5) return 0.5;
	return Math.max(0.01, raw);
}

/** One answer counts as right only when it is correct and not "I don't know". */
function isRight(e: Pick<EvidenceEvent, "correct" | "dontKnow">): boolean {
	return e.correct && e.dontKnow !== true;
}

/** One Bayesian update. Right: p(1−s) / (p(1−s) + (1−p)g). Wrong or
 *  "I don't know": p·s / (p·s + (1−p)(1−g)). */
export function updateKnowledge(p: number, e: Pick<EvidenceEvent, "correct" | "dontKnow" | "guess">): number {
	const s = KNOWLEDGE_SLIP;
	const g = e.guess;
	if (isRight(e)) {
		const known = p * (1 - s);
		return known / (known + (1 - p) * g);
	}
	const known = p * s;
	return known / (known + (1 - p) * (1 - g));
}

function priorState(): FactKnowledge {
	return { p: KNOWLEDGE_PRIOR, attempts: 0, lastCorrect: null, misconception: false };
}

/** Fold evidence per graph node id, in ascending `at` order (ties keep
 *  their input order), each fact starting from KNOWLEDGE_PRIOR. */
export function knowledgeOf(events: readonly EvidenceEvent[]): Map<string, FactKnowledge> {
	const ordered = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	const out = new Map<string, FactKnowledge>();
	for (const e of ordered) {
		const state = out.get(e.nodeId) ?? priorState();
		const right = isRight(e);
		out.set(e.nodeId, {
			p: updateKnowledge(state.p, e),
			attempts: state.attempts + 1,
			lastCorrect: right,
			misconception: !right && e.dontKnow !== true && (e.confidence ?? 0) >= MISCONCEPTION_CONFIDENCE,
		});
	}
	return out;
}

/** The state of one fact; the prior state when it has no evidence. */
export function knowledgeFor(map: ReadonlyMap<string, FactKnowledge>, nodeId: string): FactKnowledge {
	return map.get(nodeId) ?? priorState();
}

/** A plan node passes iff it has at least one fact and every fact's graph
 *  node is at or above KNOWLEDGE_PASS. */
export function nodePassed(node: PlanNode, map: ReadonlyMap<string, FactKnowledge>): boolean {
	const facts = node.facts ?? [];
	return facts.length > 0 && facts.every((fact) => knowledgeFor(map, fact.graphId).p >= KNOWLEDGE_PASS);
}

/** Fraction of the node's facts at or above KNOWLEDGE_PASS (0 without facts). */
export function nodeProgress(node: PlanNode, map: ReadonlyMap<string, FactKnowledge>): number {
	const facts = node.facts ?? [];
	if (facts.length === 0) return 0;
	return facts.filter((fact) => knowledgeFor(map, fact.graphId).p >= KNOWLEDGE_PASS).length / facts.length;
}
