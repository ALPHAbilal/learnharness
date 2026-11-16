/**
 * The knowledge number (src/core/knowledge.ts, coach-planner design §4.3):
 * Bayesian knowledge tracing with fixed parameters, folded per graph node
 * from the evidence events; the pass rule for plan nodes. Pure — no IO.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceEvent, PlanNode } from "../src/core/contracts.ts";
import {
	GUESS_CODE,
	GUESS_FREE_TEXT,
	KNOWLEDGE_PASS,
	KNOWLEDGE_PRIOR,
	KNOWLEDGE_SLIP,
	MISCONCEPTION_CONFIDENCE,
	guessForChoice,
	knowledgeFor,
	knowledgeOf,
	nodePassed,
	nodeProgress,
	updateKnowledge,
} from "../src/core/knowledge.ts";

/** |actual − expected| < 10^−digits (the design quotes 3 truncated digits). */
const close = (actual: number, expected: number, digits = 3): void => {
	assert.ok(Math.abs(actual - expected) < 10 ** -digits, `expected ≈${expected}, got ${actual}`);
};

let clock = 0;
/** An evidence event; `at` increases with every call unless given. */
function ev(nodeId: string, over: Partial<EvidenceEvent> = {}): EvidenceEvent {
	clock++;
	return {
		nodeId,
		chatId: "chat_k",
		messageId: "",
		at: `2026-11-14T00:00:00.${String(clock).padStart(3, "0")}Z`,
		source: "quiz",
		correct: true,
		guess: 1 / 3,
		...over,
	};
}

describe("knowledge constants", () => {
	it("carry the owner's fixed parameters", () => {
		assert.equal(KNOWLEDGE_PRIOR, 0.3);
		assert.equal(KNOWLEDGE_PASS, 0.85);
		assert.equal(KNOWLEDGE_SLIP, 0.1);
		assert.equal(GUESS_CODE, 0.05);
		assert.equal(GUESS_FREE_TEXT, 0.1);
		assert.equal(MISCONCEPTION_CONFIDENCE, 90);
	});
});

describe("guessForChoice", () => {
	it("single-select is 1/n", () => {
		close(guessForChoice(3, false), 1 / 3, 9);
		assert.equal(guessForChoice(4, false), 0.25);
		assert.equal(guessForChoice(2, false), 0.5);
	});

	it("multi-select is 1/(2^n − 1)", () => {
		close(guessForChoice(3, true), 1 / 7, 9);
		close(guessForChoice(4, true), 1 / 15, 9);
	});

	it("clamps into [0.01, 0.5]", () => {
		assert.equal(guessForChoice(1, false), 0.5);
		assert.equal(guessForChoice(1, true), 0.5);
		assert.equal(guessForChoice(0, false), 0.5);
		assert.equal(guessForChoice(200, false), 0.01);
		assert.equal(guessForChoice(10, true), 0.01);
	});
});

describe("updateKnowledge", () => {
	it("three right 3-option answers from the prior: ≈0.536, ≈0.757, ≈0.894", () => {
		let p = KNOWLEDGE_PRIOR;
		p = updateKnowledge(p, { correct: true, guess: 1 / 3 });
		close(p, 0.536);
		p = updateKnowledge(p, { correct: true, guess: 1 / 3 });
		close(p, 0.757);
		p = updateKnowledge(p, { correct: true, guess: 1 / 3 });
		close(p, 0.894);
	});

	it("one passed code question from the prior: ≈0.885", () => {
		close(updateKnowledge(KNOWLEDGE_PRIOR, { correct: true, guess: GUESS_CODE }), 0.885);
	});

	it("one wrong 3-option answer from the prior: ≈0.060", () => {
		close(updateKnowledge(KNOWLEDGE_PRIOR, { correct: false, guess: 1 / 3 }), 0.06);
	});

	it("'I don't know' counts as wrong, even if flagged correct", () => {
		const wrong = updateKnowledge(KNOWLEDGE_PRIOR, { correct: false, guess: 1 / 3 });
		assert.equal(updateKnowledge(KNOWLEDGE_PRIOR, { correct: false, dontKnow: true, guess: 1 / 3 }), wrong);
		assert.equal(updateKnowledge(KNOWLEDGE_PRIOR, { correct: true, dontKnow: true, guess: 1 / 3 }), wrong);
	});
});

describe("knowledgeOf / knowledgeFor", () => {
	it("folds per node from the prior, in ascending `at` order", () => {
		const events = [
			ev("n_b", { at: "2026-11-14T02:00:00.000Z", correct: true }),
			ev("n_a", { at: "2026-11-14T01:00:00.000Z", correct: true }),
			ev("n_b", { at: "2026-11-14T01:00:00.000Z", correct: false }),
		];
		const map = knowledgeOf(events);
		const a = knowledgeFor(map, "n_a");
		close(a.p, 0.536);
		assert.equal(a.attempts, 1);
		assert.equal(a.lastCorrect, true);
		// n_b: wrong first (earlier `at`), then right — order by time, not input.
		const b = knowledgeFor(map, "n_b");
		const expected = updateKnowledge(updateKnowledge(KNOWLEDGE_PRIOR, { correct: false, guess: 1 / 3 }), { correct: true, guess: 1 / 3 });
		close(b.p, expected, 9);
		assert.equal(b.attempts, 2);
		assert.equal(b.lastCorrect, true, "the latest event by time was right");
	});

	it("ties on `at` keep input order (stable)", () => {
		const at = "2026-11-14T03:00:00.000Z";
		const map = knowledgeOf([ev("n_t", { at, correct: true }), ev("n_t", { at, correct: false })]);
		assert.equal(knowledgeFor(map, "n_t").lastCorrect, false, "the second event in input order is the latest");
	});

	it("knowledgeFor returns the prior state for a node without evidence", () => {
		assert.deepEqual(knowledgeFor(knowledgeOf([]), "n_none"), {
			p: KNOWLEDGE_PRIOR,
			attempts: 0,
			lastCorrect: null,
			misconception: false,
		});
	});

	it("misconception: set by a confident wrong answer, cleared by a later right one", () => {
		const set = knowledgeOf([ev("n_m", { correct: false, confidence: 95 })]);
		assert.equal(knowledgeFor(set, "n_m").misconception, true);
		const atThreshold = knowledgeOf([ev("n_m", { correct: false, confidence: MISCONCEPTION_CONFIDENCE })]);
		assert.equal(knowledgeFor(atThreshold, "n_m").misconception, true, "the threshold is inclusive");
		const unsure = knowledgeOf([ev("n_m", { correct: false, confidence: 89 })]);
		assert.equal(knowledgeFor(unsure, "n_m").misconception, false);
		const noConfidence = knowledgeOf([ev("n_m", { correct: false })]);
		assert.equal(knowledgeFor(noConfidence, "n_m").misconception, false);
		const dontKnow = knowledgeOf([ev("n_m", { correct: false, dontKnow: true, confidence: 100 })]);
		assert.equal(knowledgeFor(dontKnow, "n_m").misconception, false, "'I don't know' is never a misconception");
		const cleared = knowledgeOf([ev("n_m", { correct: false, confidence: 95 }), ev("n_m", { correct: true, confidence: 95 })]);
		assert.equal(knowledgeFor(cleared, "n_m").misconception, false);
	});
});

describe("nodePassed / nodeProgress", () => {
	const node = (facts: string[]): PlanNode => ({
		id: "node",
		title: "Node",
		facts: facts.map((graphId, i) => ({ id: `f${i}`, graphId, statement: `Fact ${i}` })),
	});
	// n_hi: three right answers (≈0.894, above the line); n_lo: one (≈0.536).
	const map = knowledgeOf([ev("n_hi"), ev("n_hi"), ev("n_hi"), ev("n_lo")]);

	it("passes iff every fact is at or above the pass line", () => {
		assert.equal(nodePassed(node(["n_hi"]), map), true);
		assert.equal(nodePassed(node(["n_hi", "n_lo"]), map), false);
		assert.equal(nodePassed(node(["n_hi", "n_unseen"]), map), false, "an unseen fact sits at the prior");
	});

	it("a node without facts is not passed", () => {
		assert.equal(nodePassed(node([]), map), false);
		assert.equal(nodePassed({ id: "bare", title: "Bare" }, map), false);
	});

	it("progress is the fraction of facts at or above the line (0 without facts)", () => {
		assert.equal(nodeProgress(node(["n_hi"]), map), 1);
		assert.equal(nodeProgress(node(["n_hi", "n_lo"]), map), 0.5);
		assert.equal(nodeProgress(node(["n_lo", "n_unseen"]), map), 0);
		assert.equal(nodeProgress({ id: "bare", title: "Bare" }, map), 0);
	});
});
