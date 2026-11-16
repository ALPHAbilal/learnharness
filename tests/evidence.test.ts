/**
 * Evidence stamping (coach-planner design §4.3/§4.4, core/evidence.ts):
 * the server-side, deterministic turn of an accepted answer into evidence
 * events — multiple-choice correctness re-derived from the committed
 * answer, coding questions read from their test outcome, own-words answers
 * left to the coach, plus the resolver, the idempotency filter and the
 * answer-result matcher the handler uses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { answeredQuestionsIn, evidenceForAnswer, factResolver, judgedEvidence, unstampedEvidence } from "../src/core/evidence.ts";
import { GUESS_CODE, GUESS_FREE_TEXT, guessForChoice } from "../src/core/knowledge.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import type { PluginQuestionAnswer } from "../src/core/plugin-questions.ts";
import type { EvidenceEvent, PlanTree } from "../src/core/contracts.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";

const QUIZ = {
	type: "check", nodeId: "planets", facts: ["f-inner", "f-order"],
	question: "Which planet is closest to the Sun?",
	options: [{ label: "Venus", value: "venus" }, { label: "Mercury", value: "mercury" }, { label: "Mars", value: "mars" }],
	explanation: "Mercury is the innermost planet.",
	correctAnswer: "mercury",
};
const GRAPH: Record<string, string> = { "f-inner": "n_inner", "f-order": "n_order" };
const resolve = (id: string) => GRAPH[id] ?? null;
const common = { chatId: "chat_1", messageId: "m_answer", at: "2026-11-15T10:00:00.000Z", resolve };

function picked(values: string[], extra: Partial<QuestionAnswerData> = {}): QuestionAnswerData {
	const labels: Record<string, string> = { venus: "Venus", mercury: "Mercury", mars: "Mars", a: "A", b: "B", c: "C" };
	return {
		kind: "quiz", tool: "quiz", questionText: QUIZ.question, dontKnow: false,
		answers: values.map((value, i) => ({ label: labels[value] ?? value, value, index: i + 1 })),
		answeredAt: "2026-11-15T10:00:00.000Z", ...extra,
	};
}

describe("evidenceForAnswer: multiple choice (quiz / probe)", () => {
	it("one event per resolving fact, correctness re-derived on the server", () => {
		const events = evidenceForAnswer({ ...common, tool: "quiz", input: QUIZ, answer: picked(["mercury"], { confidence: 70 }) });
		assert.deepEqual(events, [
			{ nodeId: "n_inner", chatId: "chat_1", messageId: "m_answer", at: common.at, source: "quiz", correct: true, guess: guessForChoice(3, false), confidence: 70 },
			{ nodeId: "n_order", chatId: "chat_1", messageId: "m_answer", at: common.at, source: "quiz", correct: true, guess: guessForChoice(3, false), confidence: 70 },
		]);
	});

	it("never trusts the client's verdict: a lying `correct` is overridden both ways", () => {
		const wrongButClaimed = evidenceForAnswer({ ...common, tool: "quiz", input: QUIZ, answer: picked(["venus"], { correct: true }) });
		assert.deepEqual(wrongButClaimed.map((e) => e.correct), [false, false]);
		const rightButDenied = evidenceForAnswer({ ...common, tool: "quiz", input: QUIZ, answer: picked(["mercury"], { correct: false }) });
		assert.deepEqual(rightButDenied.map((e) => e.correct), [true, true]);
	});

	it("matches the committed label too (coerceCorrectAnswer), and probe answers carry source probe", () => {
		const { type: _t, nodeId: _n, ...probe } = QUIZ;
		const events = evidenceForAnswer({ ...common, tool: "probe", input: { ...probe, correctAnswer: "Mercury", options: [QUIZ.options[1]!, QUIZ.options[0]!, QUIZ.options[2]!].map((o) => ({ label: o.label })) }, answer: picked(["Mercury"]) });
		assert.deepEqual(events.map((e) => [e.source, e.correct]), [["probe", true], ["probe", true]]);
	});

	it("multi-select: exact set equality and the multi-select guess", () => {
		const input = { ...QUIZ, facts: ["f-inner"], options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }], correctAnswer: ["a", "b"], multiSelect: true };
		const exact = evidenceForAnswer({ ...common, tool: "quiz", input, answer: picked(["b", "a"]) });
		assert.deepEqual(exact.map((e) => [e.correct, e.guess]), [[true, guessForChoice(3, true)]]);
		assert.equal(guessForChoice(3, true), 1 / 7);
		assert.equal(evidenceForAnswer({ ...common, tool: "quiz", input, answer: picked(["a"]) })[0]!.correct, false, "a subset is wrong");
		assert.equal(evidenceForAnswer({ ...common, tool: "quiz", input, answer: picked(["a", "b", "c"]) })[0]!.correct, false, "a superset is wrong");
	});

	it("\"I don't know\" is wrong and flagged; confidence passes through only when valid", () => {
		const dontKnow = evidenceForAnswer({ ...common, tool: "quiz", input: QUIZ, answer: picked([], { dontKnow: true }) });
		assert.deepEqual(dontKnow.map((e) => [e.correct, e.dontKnow, "confidence" in e]), [[false, true, false], [false, true, false]]);
		const bogus = evidenceForAnswer({ ...common, tool: "quiz", input: QUIZ, answer: picked(["mercury"], { confidence: 250 }) });
		assert.equal("confidence" in bogus[0]!, false);
	});

	it("skips fact ids that do not resolve, dedupes facts sharing a graph node, and needs tags", () => {
		const events = evidenceForAnswer({ ...common, tool: "quiz", input: { ...QUIZ, facts: ["f-inner", "f-ghost", "f-inner"] }, answer: picked(["mercury"]) });
		assert.deepEqual(events.map((e) => e.nodeId), ["n_inner"]);
		assert.deepEqual(evidenceForAnswer({ ...common, tool: "quiz", input: { ...QUIZ, facts: undefined }, answer: picked(["mercury"]) }), []);
		assert.deepEqual(evidenceForAnswer({ ...common, tool: "quiz", input: { ...QUIZ, facts: "f-order" }, answer: picked(["mercury"]) }).map((e) => e.nodeId), ["n_order"], "a bare-string tag is read as one id");
	});

	it("dismissed answers and ask_user_question answers stamp nothing", () => {
		assert.deepEqual(evidenceForAnswer({ ...common, tool: "quiz", input: QUIZ, answer: { kind: "quiz", questionText: "q", dontKnow: false, answers: [], dismissed: true, answeredAt: common.at } }), []);
		assert.deepEqual(evidenceForAnswer({ ...common, tool: "ask_user_question", input: { question: "q", facts: ["f-inner"] }, answer: { kind: "ask", questionText: "q", dontKnow: false, answers: [], text: "yes", answeredAt: common.at } }), []);
	});
});

describe("own-words answers (explain / recall)", () => {
	it("evidenceForAnswer stamps nothing — the coach judges them", () => {
		const answer: QuestionAnswerData = { kind: "explain", questionText: "Explain.", dontKnow: false, answers: [], text: "Because.", answeredAt: common.at };
		assert.deepEqual(evidenceForAnswer({ ...common, tool: "explain", input: { ...QUIZ, correctAnswer: "Because." }, answer }), []);
		assert.deepEqual(evidenceForAnswer({ ...common, tool: "recall", input: { question: "q", correctAnswer: "a", facts: ["f-inner"] }, answer }), []);
	});

	it("judgedEvidence turns the coach's verdicts into free-text events", () => {
		assert.deepEqual(judgedEvidence({ chatId: "c", messageId: "m", at: common.at, source: "recall", judged: [{ graphId: "n_a", correct: true }, { graphId: "n_b", correct: false }] }), [
			{ nodeId: "n_a", chatId: "c", messageId: "m", at: common.at, source: "recall", correct: true, guess: GUESS_FREE_TEXT },
			{ nodeId: "n_b", chatId: "c", messageId: "m", at: common.at, source: "recall", correct: false, guess: GUESS_FREE_TEXT },
		]);
	});
});

describe("coding questions (coding-questions / code)", () => {
	function coded(grading: PluginQuestionAnswer["grading"], pluginId = "coding-questions"): PluginQuestionAnswer {
		return { kind: "plugin-question", questionId: "q", pluginId, typeId: "code", contractVersion: 1, answer: { code: "x" }, answeredAt: common.at, ...(grading ? { grading } : {}) };
	}
	const input = { type: "check", nodeId: "planets", facts: ["f-inner"], question: "Write it.", payload: {} };
	const status = (s: string) => ({ result: { status: s, exitCode: s === "passed" ? 0 : 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false } });

	it("passed → correct, failed → wrong, both with the code guess", () => {
		assert.deepEqual(evidenceForAnswer({ ...common, tool: "coding_question", input, answer: coded(status("passed")) }), [
			{ nodeId: "n_inner", chatId: "chat_1", messageId: "m_answer", at: common.at, source: "code", correct: true, guess: GUESS_CODE },
		]);
		assert.deepEqual(evidenceForAnswer({ ...common, tool: "coding_question", input, answer: coded(status("failed")) }).map((e) => [e.source, e.correct, e.guess]), [["code", false, GUESS_CODE]]);
	});

	it("an error status, a grading error, no grading or another plugin stamps nothing", () => {
		for (const answer of [coded(status("error")), coded({ error: "runner crashed" }), coded(undefined), coded(status("passed"), "other-plugin")]) {
			assert.deepEqual(evidenceForAnswer({ ...common, tool: "coding_question", input, answer }), []);
		}
	});
});

describe("factResolver", () => {
	it("maps fact ids through the tree first, then the probe fact list", () => {
		const tree: PlanTree = { nodes: [{ id: "a", title: "A", facts: [{ id: "f1", graphId: "n_tree", statement: "S." }] }], edges: [], version: 1 };
		const r = factResolver({ tree, probeFacts: { facts: [{ id: "f1", graphId: "n_probe", statement: "S." }, { id: "p2", graphId: "n_p2", statement: "P." }], arrows: [] } });
		assert.equal(r("f1"), "n_tree", "the tree wins");
		assert.equal(r("p2"), "n_p2");
		assert.equal(r("nope"), null);
		assert.equal(factResolver({})("f1"), null);
	});
});

describe("unstampedEvidence (idempotent stamping)", () => {
	it("drops events whose (chatId, messageId, nodeId) is already in the ledger or earlier in the batch", () => {
		const e = (nodeId: string, messageId = "m"): EvidenceEvent => ({ nodeId, chatId: "c", messageId, at: common.at, source: "quiz", correct: true, guess: 0.5 });
		const ledger = [e("n_a")];
		assert.deepEqual(unstampedEvidence(ledger, [e("n_a"), e("n_b"), e("n_b"), e("n_a", "m2")]), [e("n_b"), e("n_a", "m2")]);
		assert.deepEqual(unstampedEvidence([...ledger, e("n_b"), e("n_a", "m2")], [e("n_a"), e("n_b"), e("n_a", "m2")]), [], "a re-post stamps nothing");
	});
});

describe("answeredQuestionsIn", () => {
	const assistant = (id: string, blocks: unknown[], extra: Record<string, unknown> = {}): LhMessage => ({
		id, role: "assistant", content: blocks, api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1, ...extra,
	}) as never;

	it("matches a builtin answer result to its call by id and name", () => {
		const call = assistant("a1", [{ type: "toolCall", id: "call_q", name: "quiz", arguments: QUIZ }]);
		const answer = picked(["mercury"]);
		const result = newAnswerResult("call_q", "quiz", answer) as LhMessage;
		assert.deepEqual(answeredQuestionsIn([call], [result]), [{ messageId: result.id, tool: "quiz", input: QUIZ, answer }]);
		assert.deepEqual(answeredQuestionsIn([call], [newAnswerResult("call_other", "quiz", answer) as LhMessage]), [], "no call, no answer");
	});

	it("matches a plugin answer through its bound occurrence and saved snapshot input", () => {
		const occurrence = { messageId: "a2", contentIndex: 0, toolCallId: "call_c", toolName: "coding_question" };
		const input = { type: "check", nodeId: "planets", facts: ["f-inner"], question: "Write it.", payload: { source: "x" } };
		const snapshot = {
			protocolVersion: 2, requiresGrading: true, pluginId: "coding-questions", typeId: "code", label: "Code", variant: "teach",
			questionId: "q1", occurrence, contractVersion: 1, input,
			questionSchema: Type.Object({ source: Type.String() }), answerSchema: Type.Any(), showThinking: false, requiresAnswerRefinement: false,
		};
		const call = assistant("a2", [{ type: "toolCall", id: "call_c", name: "coding_question", arguments: input }], { lhQuestions: { 0: snapshot } });
		const details = { kind: "plugin-question", questionId: "q1", pluginId: "coding-questions", typeId: "code", contractVersion: 1, answer: { code: "x" }, grading: { result: { status: "passed" } }, answeredAt: common.at };
		const result = { id: "r2", role: "toolResult", toolCallId: "call_c", toolName: "coding_question", lhQuestionOccurrence: occurrence, details, content: [{ type: "text", text: "{}" }], isError: false, timestamp: 2 } as unknown as LhMessage;
		const [answered] = answeredQuestionsIn([call], [result]);
		assert.equal(answered?.messageId, "r2");
		assert.equal(answered?.tool, "coding_question");
		assert.deepEqual(answered?.input, input);
		assert.deepEqual(evidenceForAnswer({ ...common, ...answered! }).map((e) => [e.nodeId, e.correct, e.source]), [["n_inner", true, "code"]]);
	});
});
