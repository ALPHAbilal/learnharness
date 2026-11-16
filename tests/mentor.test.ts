/**
 * The mentor worker (coach-planner design §4.5 — the learner's "Coach"):
 * the `review` argument heal and fill, every validation rule's message,
 * notes capping, the retry-once-then-null run, and abort.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { MentorReview, MentorValidationContext } from "../src/core/contracts/mentor.ts";
import { fillReview, mentorReviewProblems, prepareReviewArguments, runMentor, MENTOR_TOOL } from "../src/agent/subagents/mentor.ts";

function engineOf(steps: FauxResponseStep[]): { engine: PiEngine; calls: () => number; contexts: string[][] } {
	const faux = createFauxCore({});
	let calls = 0;
	const contexts: string[][] = [];
	faux.setResponses(steps.map((step) => (context: { messages: Array<{ role?: string; content?: unknown }> }, ...rest: unknown[]) => {
		calls++;
		contexts.push(context.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
		return typeof step === "function" ? (step as (...a: unknown[]) => unknown)(context, ...rest) : step;
	}) as FauxResponseStep[]);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls: () => calls, contexts };
}

const context = (over: Partial<MentorValidationContext> = {}): MentorValidationContext => ({
	phase: "teach",
	factIds: new Set(["fa", "fb"]),
	takenIds: new Set(["fa", "fb", "node-a"]),
	taggedFactIds: new Set(["fa"]),
	liveGraphIds: new Set(["n_live", "n_used"]),
	usedGraphIds: new Map([["n_used", "fa"]]),
	...over,
});

const review = (over: Partial<MentorReview> = {}): MentorReview => ({
	notes: [], judged: [], addFacts: [], addArrows: [], addNodes: [], askLearner: null, ...over,
});

const fact = (id: string, existing?: string) => ({ id, name: `Name ${id}`, statement: `Statement ${id}.`, ...(existing ? { existing } : {}) });

describe("the review argument heal and fill", () => {
	it("parses stringified lists, wraps bare strings and lone objects, drops nulls", () => {
		const healed = prepareReviewArguments({
			notes: "Said 'paths?': show the URL.",
			judged: JSON.stringify([{ factId: "fa", correct: true }]),
			addFacts: { id: "f1", name: "N", statement: "S." },
			addArrows: JSON.stringify([{ premises: "fa", conclusion: "f1" }]),
			addNodes: [{ id: "n1", title: "T", facts: JSON.stringify([{ id: "f2", name: "N", statement: "S." }]) }],
			askLearner: null,
		}) as Record<string, unknown>;
		assert.deepEqual(healed.notes, ["Said 'paths?': show the URL."]);
		assert.deepEqual(healed.judged, [{ factId: "fa", correct: true }]);
		assert.deepEqual(healed.addFacts, [{ id: "f1", name: "N", statement: "S." }]);
		assert.deepEqual(healed.addArrows, [{ premises: ["fa"], conclusion: "f1" }]);
		assert.deepEqual((healed.addNodes as Array<{ facts: unknown }>)[0]!.facts, [{ id: "f2", name: "N", statement: "S." }]);
		assert.equal("askLearner" in healed, false);
		assert.deepEqual(prepareReviewArguments({ notes: null, judged: null }), { notes: [] });
		assert.deepEqual(prepareReviewArguments({ notes: '["a","b"]' }), { notes: ["a", "b"] });
	});

	it("fills every omitted list with [] and an empty askLearner with null", () => {
		assert.deepEqual(fillReview({ notes: [] }), review());
		assert.deepEqual(fillReview({ notes: [], askLearner: "  " }), review());
		assert.equal(fillReview({ notes: [], askLearner: " Have you written a loop? " }).askLearner, "Have you written a loop?");
	});

	it("trims notes, drops empty ones, and keeps the first three instead of failing", () => {
		assert.deepEqual(fillReview({ notes: [" one ", "", "  ", "two", "three", "four", "five"] }).notes, ["one", "two", "three"]);
	});
});

describe("the review validation (model-readable, naming the culprit)", () => {
	it("accepts an empty review and a well-formed one", () => {
		assert.deepEqual(mentorReviewProblems(review(), context()), []);
		assert.deepEqual(mentorReviewProblems(review({
			judged: [{ factId: "fa", correct: true }],
			addFacts: [fact("new-fact", "n_live")],
			addArrows: [{ premises: ["fa"], conclusion: "new-fact" }],
			addNodes: [{ id: "new-node", title: "T", facts: [fact("other-fact")] }],
		}), context()), []);
	});

	it("slug grammar for fact and node ids", () => {
		const problems = mentorReviewProblems(review({ addFacts: [fact("Bad Id")], addNodes: [{ id: "Node_X!", title: "T", facts: [fact("ok-fact")] }] }), context());
		assert.ok(problems.some((p) => p.includes('Fact id "Bad Id" must be a new short slug')), problems.join("\n"));
		assert.ok(problems.some((p) => p.includes('Node id "Node_X!" must be a new short slug')), problems.join("\n"));
	});

	it("new ids must not collide with the session's fact or node ids, nor with each other", () => {
		const problems = mentorReviewProblems(review({ addFacts: [fact("fa"), fact("dup")], addNodes: [{ id: "node-a", title: "T", facts: [fact("dup")] }] }), context());
		assert.ok(problems.includes('Fact id "fa" is already used by a fact or node of this session — pick a new id.'), problems.join("\n"));
		assert.ok(problems.includes('Node id "node-a" is already used by a fact or node of this session — pick a new id.'), problems.join("\n"));
		assert.ok(problems.includes('Fact id "dup" appears twice in this review — ids must be unique.'), problems.join("\n"));
	});

	it("arrow endpoints must be known or added in the same review", () => {
		const problems = mentorReviewProblems(review({ addFacts: [fact("added")], addArrows: [{ premises: ["fa", "ghost"], conclusion: "added" }] }), context());
		assert.deepEqual(problems, ['Arrow ["fa", "ghost"] → "added" names unknown fact id "ghost" — use a fact id shown to you or one you add in this review.']);
	});

	it("judged facts must be among the facts the latest question tagged", () => {
		assert.deepEqual(mentorReviewProblems(review({ judged: [{ factId: "fb", correct: true }] }), context()), [
			'judged names fact "fb", which the latest question did not test. It tested: fa.',
		]);
		assert.deepEqual(mentorReviewProblems(review({ judged: [{ factId: "fa", correct: true }] }), context({ taggedFactIds: new Set() })), [
			'judged names fact "fa", but the latest question tested no facts — leave judged out.',
		]);
	});

	it("addNodes is refused during the probe", () => {
		const problems = mentorReviewProblems(review({ addNodes: [{ id: "n1", title: "T", facts: [fact("f1")] }] }), context({ phase: "probe" }));
		assert.ok(problems[0]!.startsWith("addNodes is for teaching only"), problems.join("\n"));
		assert.ok(problems[0]!.includes('"n1"'));
	});

	it("existing must be a live graph node, not already a fact of the session, and named once", () => {
		const problems = mentorReviewProblems(review({ addFacts: [fact("f1", "n_dead"), fact("f2", "n_used"), fact("f3", "n_live"), fact("f4", "n_live")] }), context());
		assert.ok(problems.some((p) => p.startsWith('Fact "f1" names existing node "n_dead", which is not in the knowledge graph')), problems.join("\n"));
		assert.ok(problems.some((p) => p.startsWith('Fact "f2" names existing node "n_used", which is already fact "fa" of this session')), problems.join("\n"));
		assert.ok(problems.includes('Facts "f3" and "f4" both name existing node "n_live" — add it once.'), problems.join("\n"));
	});
});

describe("runMentor", () => {
	const args = (engine: PiEngine, signal?: AbortSignal) => ({ engine, systemPrompt: "You are the coach.", input: "[Review request] — written by the app.", context: context(), signal });

	it("returns the filled review of a valid call, reporting usage", async () => {
		const { engine, calls } = engineOf([
			fauxAssistantMessage([fauxToolCall(MENTOR_TOOL, { notes: ["a", "b", "c", "d"], askLearner: "Ever written one?" } as never, { id: "r1" })], { stopReason: "toolUse" }),
		]);
		let usages = 0;
		const result = await runMentor({ ...args(engine), onUsage: () => usages++ });
		assert.deepEqual(result, review({ notes: ["a", "b", "c"], askLearner: "Ever written one?" }));
		assert.equal(calls(), 1);
		assert.equal(usages, 1);
	});

	it("a rejected call goes back to the model with the problem; the corrected call is taken", async () => {
		const { engine, calls, contexts } = engineOf([
			fauxAssistantMessage([fauxToolCall(MENTOR_TOOL, { notes: [], judged: [{ factId: "fb", correct: true }] } as never, { id: "r1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall(MENTOR_TOOL, { notes: [], judged: [{ factId: "fa", correct: false }] } as never, { id: "r2" })], { stopReason: "toolUse" }),
		]);
		const result = await runMentor(args(engine));
		assert.deepEqual(result?.judged, [{ factId: "fa", correct: false }]);
		assert.equal(calls(), 2);
		assert.ok(contexts[1]!.some((t) => t.includes('judged names fact \\"fb\\", which the latest question did not test')), contexts[1]!.join("\n"));
	});

	it("a run that never submits is retried once, then the result is null", async () => {
		const { engine, calls } = engineOf([
			fauxAssistantMessage([fauxText("I think the learner is fine.")]),
			fauxAssistantMessage([fauxText("Still no call.")]),
			fauxAssistantMessage([fauxToolCall(MENTOR_TOOL, { notes: ["too late"] } as never, { id: "r3" })], { stopReason: "toolUse" }),
		]);
		assert.equal(await runMentor(args(engine)), null);
		assert.equal(calls(), 2, "one run, one retry — never a third");
	});

	it("the retry can succeed", async () => {
		const { engine, calls } = engineOf([
			fauxAssistantMessage([fauxText("No call.")]),
			fauxAssistantMessage([fauxToolCall(MENTOR_TOOL, { notes: ["second run"] } as never, { id: "r2" })], { stopReason: "toolUse" }),
		]);
		assert.deepEqual((await runMentor(args(engine)))?.notes, ["second run"]);
		assert.equal(calls(), 2);
	});

	it("an aborted signal yields null at once; an abort during the call yields null without a retry", async () => {
		const pre = engineOf([fauxAssistantMessage([fauxText("never")])]);
		const aborted = new AbortController();
		aborted.abort();
		assert.equal(await runMentor(args(pre.engine, aborted.signal)), null);
		assert.equal(pre.calls(), 0);

		const controller = new AbortController();
		const during = engineOf([
			() => {
				controller.abort();
				return fauxAssistantMessage([fauxToolCall(MENTOR_TOOL, { notes: ["late"] } as never, { id: "r1" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxToolCall(MENTOR_TOOL, { notes: ["retry"] } as never, { id: "r2" })], { stopReason: "toolUse" }),
		]);
		assert.equal(await runMentor(args(during.engine, controller.signal)), null);
		assert.equal(during.calls(), 1, "no retry after an abort");
	});
});
