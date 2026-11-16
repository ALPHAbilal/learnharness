/**
 * The mentor's review request (coach-planner design §4.5): the exact text
 * layout for the probe and teach phases, omitted sections, and what is
 * gathered from the record — the transcript's boundary, hidden markers
 * left out, the latest answer, related propositions from other sessions,
 * and the transcript cap.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceEvent, GraphNode, PlanTree } from "../src/core/contracts.ts";
import { mentorInputText, type MentorInput } from "../src/core/contracts/mentor.ts";
import { answeredQuestionsIn } from "../src/core/evidence.ts";
import { latestLearnerAnswer, mentorInputOf, mentorTranscript, mentorValidationContextOf } from "../src/core/mentor-input.ts";
import {
	newAnswerResult,
	newCoachCardMessage,
	newNodeHandoffMessage,
	newPlannerWakeMessage,
	newPlanUpdateMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

const base: MentorInput = {
	phase: "probe",
	goal: "",
	assessment: null,
	probeFacts: [],
	plan: [],
	road: [],
	existing: [],
	transcript: "",
	latest: { question: "What have you built?", facts: [], answer: "{\"kind\":\"ask\",\"text\":\"A todo app\"}", verdict: "ungraded" },
};

describe("mentorInputText — the exact layout", () => {
	it("probe phase: goal, the facts to test with numbers, related knowledge, the conversation, the latest answer", () => {
		const text = mentorInputText({
			...base,
			goal: "I want to learn Flask",
			probeFacts: [{ id: "py-functions", statement: "A function returns a value.", p: 0.3 }, { id: "imports", statement: "Import runs a module once.", p: 0.536 }],
			existing: [{ graphId: "n_abc", statement: "A list holds values in order.", p: 0.89 }],
			transcript: "Prober: What have you built?",
			latest: { question: "Which is a function call?", facts: ["py-functions"], answer: "{\"kind\":\"quiz\"}", verdict: "correct" },
		});
		assert.equal(text, [
			"[Review request] — written by the app.",
			"",
			"Phase: probe",
			"",
			"Goal (the learner's own words):",
			"I want to learn Flask",
			"",
			"Facts to test (id — statement — how sure the app is):",
			"- [py-functions] A function returns a value. — 30%",
			"- [imports] Import runs a module once. — 54%",
			"",
			"Existing knowledge that may be relevant (graph id — statement — how sure the app is):",
			"- (n_abc) A list holds values in order. — 89%",
			"",
			"The conversation of the current probe:",
			"Prober: What have you built?",
			"",
			"The latest answer:",
			"Question: Which is a function call?",
			"Tagged facts: py-functions",
			"Answer: {\"kind\":\"quiz\"}",
			"App verdict: correct",
		].join("\n"));
	});

	it("probe phase without facts reads 'none yet'; empty sections are left out", () => {
		assert.equal(mentorInputText(base), [
			"[Review request] — written by the app.",
			"",
			"Phase: probe",
			"",
			"Facts to test (id — statement — how sure the app is):",
			"none yet",
			"",
			"The latest answer:",
			"Question: What have you built?",
			"Tagged facts: none",
			"Answer: {\"kind\":\"ask\",\"text\":\"A todo app\"}",
			"App verdict: not graded",
		].join("\n"));
	});

	it("teach phase: assessment, the plan with passed and current marks, the road, and the own-words verdict", () => {
		const text = mentorInputText({
			...base,
			phase: "teach",
			goal: "Flask",
			assessment: { strands: [{ strand: "python", assessment: "Floor: functions." }], summary: "Start at modules." },
			plan: [
				{ id: "modules", title: "Modules", passed: true, current: false, facts: [{ id: "module-file", statement: "A module is a file.", p: 0.9 }] },
				{ id: "routes", title: "Routes", passed: false, current: true, facts: [{ id: "route-maps", statement: "A route maps a URL to a function.", p: 0.3 }] },
			],
			road: [{ nodeId: "modules", title: "Modules", passed: true, hardFacts: ["A module is a file."] }],
			transcript: "Teacher: A route is…",
			latest: { question: "Explain a route.", facts: ["route-maps"], answer: "{\"kind\":\"explain\",\"text\":\"it maps\"}", verdict: "own-words" },
		});
		assert.equal(text, [
			"[Review request] — written by the app.",
			"",
			"Phase: teach",
			"",
			"Goal (the learner's own words):",
			"Flask",
			"",
			"The prober's assessment:",
			"- python: Floor: functions.",
			"Summary: Start at modules.",
			"",
			"The plan (node — facts with how sure the app is):",
			"- modules: Modules  ✓ passed",
			"  - [module-file] A module is a file. — 90%",
			"- routes: Routes  ← current",
			"  - [route-maps] A route maps a URL to a function. — 30%",
			"",
			"The road so far:",
			"- Modules: passed; needed more than one try: A module is a file.",
			"",
			"The conversation of the current node:",
			"Teacher: A route is…",
			"",
			"The latest answer:",
			"Question: Explain a route.",
			"Tagged facts: route-maps",
			"Answer: {\"kind\":\"explain\",\"text\":\"it maps\"}",
			"App verdict: not graded by the app (own words) — judge it",
		].join("\n"));
	});

	it("verdict wording", () => {
		const verdictOf = (verdict: MentorInput["latest"]["verdict"]) => mentorInputText({ ...base, latest: { ...base.latest, verdict } }).split("\n").at(-1);
		assert.equal(verdictOf("wrong"), "App verdict: wrong");
		assert.equal(verdictOf("dont-know"), "App verdict: I don't know");
	});
});

// ─── gathering from the record ───────────────────────────────────────────────

function assistant(id: string, content: unknown[]): LhMessage {
	return {
		id, role: "assistant", content,
		api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: 1,
	} as never;
}

const OPTIONS = [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }, { label: "Maybe", value: "maybe" }];

function answer(over: Partial<QuestionAnswerData>): QuestionAnswerData {
	return { kind: "quiz", questionText: "q", dontKnow: false, answers: [], answeredAt: "2026-11-15T00:00:00.000Z", ...over };
}

function resultWithId(id: string, toolCallId: string, tool: string, data: QuestionAnswerData): LhMessage {
	return { ...newAnswerResult(toolCallId, tool, data), id } as LhMessage;
}

const TREE: PlanTree = {
	nodes: [
		{ id: "modules", title: "Modules", facts: [{ id: "module-file", graphId: "n_mod", statement: "A module is a file of definitions." }] },
		{ id: "routes", title: "Routes", facts: [{ id: "route-maps", graphId: "n_route", statement: "A route maps a URL to a view function." }] },
	],
	edges: [{ from: "modules", to: "routes" }],
	version: 2,
};

function graphNode(id: string, statement: string, chatIds: string[]): GraphNode {
	return { id, name: id, statement, aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: chatIds.map((chatId) => ({ chatId, messageId: "" })) } as GraphNode;
}

describe("mentorInputOf — the probe", () => {
	const messages: LhMessage[] = [
		{ id: "u0", role: "user", content: "I want to learn Flask routes", timestamp: 1 } as LhMessage,
		assistant("a1", [{ type: "text", text: "Let me see where you are." }, { type: "toolCall", id: "call_ask", name: "ask_user_question", arguments: { question: "Have you written Python functions?", options: [{ label: "Often", value: "often" }, { label: "Never", value: "never" }] } }]),
		resultWithId("r1", "call_ask", "ask_user_question", answer({ kind: "ask", questionText: "Have you written Python functions?", answers: [{ label: "Often", value: "often", index: 0 }], thinking: "I use them daily" })),
		newCoachCardMessage("[Coach card] SECRET CARD TEXT", { phase: "probe", nodeId: null, notes: [], askLearner: null }) as LhMessage,
		assistant("a2", [{ type: "toolCall", id: "call_probe", name: "probe", arguments: { facts: ["py-functions"], question: "What does `f()` return?", details: "```python\ndef f():\n    return 2\n```", options: OPTIONS, explanation: "It returns 2.", correctAnswer: "yes" } }]),
	];
	const appended = [resultWithId("r2", "call_probe", "probe", answer({ questionText: "What does `f()` return?", answers: [{ label: "No", value: "no", index: 1 }], confidence: 90, correct: true }))];
	const saved = [...messages, ...appended];
	const probeFacts = { facts: [{ id: "py-functions", graphId: "n_fn", statement: "A function returns a value." }], arrows: [] };

	it("finds the latest answer, renders the whole probe without hidden markers or the latest result, and the app's verdict", () => {
		const latest = latestLearnerAnswer(messages, appended)!;
		assert.equal(latest.messageId, "r2");
		const input = mentorInputOf({
			chatId: "chat_me", phase: "probe", messages: saved, tree: undefined, probeFacts, events: [],
			graphNodes: [graphNode("n_other", "A Flask route maps a URL to a function.", ["chat_other"]), graphNode("n_mine", "Flask routes are decorators.", ["chat_me"]), graphNode("n_fn", "A function returns a value.", ["chat_other"])],
			latest,
		});
		assert.equal(input.goal, "I want to learn Flask routes");
		assert.deepEqual(input.probeFacts, [{ id: "py-functions", statement: "A function returns a value.", p: 0.3 }]);
		assert.deepEqual(input.existing.map((e) => e.graphId), ["n_other"], "other sessions only; the session's own facts are left out");
		assert.deepEqual(input.latest, {
			question: "What does `f()` return?",
			facts: ["py-functions"],
			answer: JSON.stringify({ kind: "quiz", answers: [{ index: 1, label: "No" }], correct: true, confidence: 90 }),
			verdict: "wrong",
		});
		assert.equal(input.transcript, [
			"Learner: I want to learn Flask routes",
			"Prober: Let me see where you are.",
			"Question (ask_user_question): Have you written Python functions?\nOptions:\n- Often\n- Never",
			"Learner's answer: Often\nLearner's thinking: I use them daily",
			"Question (probe, facts: py-functions): What does `f()` return?\n```python\ndef f():\n    return 2\n```\nOptions:\n- Yes (the committed answer)\n- No\n- Maybe",
		].join("\n\n"));
		assert.ok(!input.transcript.includes("SECRET CARD TEXT"), "hidden markers are left out");
		assert.match(mentorInputText(input), /App verdict: wrong$/);
	});

	it("a dismissal is no answer to review", () => {
		const dismissed = [resultWithId("r3", "call_probe", "probe", answer({ dismissed: true }))];
		assert.equal(latestLearnerAnswer(messages, dismissed), null);
		assert.equal(answeredQuestionsIn(messages, dismissed).length, 1, "it is still an answer result");
	});

	it("the validation context: the probe list's ids, the tagged facts, the live and used graph ids", () => {
		const latest = latestLearnerAnswer(messages, appended)!;
		const ctx = mentorValidationContextOf({ phase: "probe", tree: TREE, probeFacts, latest, liveGraphIds: new Set(["n_fn"]) });
		assert.deepEqual([...ctx.factIds], ["py-functions"]);
		assert.deepEqual([...ctx.takenIds].sort(), ["module-file", "modules", "py-functions", "route-maps", "routes"]);
		assert.deepEqual([...ctx.taggedFactIds], ["py-functions"]);
		assert.equal(ctx.usedGraphIds.get("n_fn"), "py-functions");
	});
});

describe("mentorInputOf — a node", () => {
	const handoff = newNodeHandoffMessage("routes", "[Node handoff] HANDOFF TEXT") as LhMessage;
	const messages: LhMessage[] = [
		{ id: "u0", role: "user", content: "Flask", timestamp: 1 } as LhMessage,
		assistant("old", [{ type: "text", text: "EARLIER NODE PROSE" }]),
		handoff,
		assistant("t1", [{ type: "text", text: "A route ties a URL to a function." }, { type: "toolCall", id: "call_ex", name: "explain", arguments: { type: "check", nodeId: "routes", facts: ["route-maps"], question: "Explain what a route does." } }]),
	];
	const appended = [resultWithId("r1", "call_ex", "explain", answer({ kind: "explain", questionText: "Explain what a route does.", text: "It maps a URL", readingThinking: "what is a URL exactly?" }))];
	const saved = [...messages, ...appended, newPlanUpdateMessage(TREE) as LhMessage, newPlannerWakeMessage("[Planner brief] HIDDEN") as LhMessage];
	const events: EvidenceEvent[] = [
		{ nodeId: "n_mod", chatId: "c", messageId: "m1", at: "2026-11-01T00:00:01.000Z", source: "quiz", correct: false, guess: 1 / 3 },
		...[2, 3, 4, 5, 6, 7].map((i) => ({ nodeId: "n_mod", chatId: "c", messageId: `m${i}`, at: `2026-11-01T00:00:0${i}.000Z`, source: "quiz" as const, correct: true, guess: 1 / 3 })),
	];

	it("starts at the latest node handoff, shows the plan with marks, the road, and the own-words verdict", () => {
		const latest = latestLearnerAnswer(messages, appended)!;
		const input = mentorInputOf({ chatId: "c", phase: "teach", messages: saved, tree: TREE, probeFacts: undefined, events, graphNodes: [], latest });
		assert.equal(input.transcript, "Teacher: A route ties a URL to a function.\n\nQuestion (explain, check, facts: route-maps): Explain what a route does.");
		assert.ok(!input.transcript.includes("EARLIER NODE PROSE"));
		assert.deepEqual(input.plan.map((n) => [n.id, n.passed, n.current]), [["modules", true, false], ["routes", false, true]]);
		assert.deepEqual(input.road, [{ nodeId: "modules", title: "Modules", passed: true, hardFacts: ["A module is a file of definitions."] }]);
		assert.equal(input.latest.verdict, "own-words");
		assert.equal(input.existing.length, 0);
		const text = mentorInputText(input);
		assert.match(text, /The conversation of the current node:\nTeacher: A route ties/);
		assert.match(text, /Answer: \{"kind":"explain","text":"It maps a URL","thinkingWhileReading":"what is a URL exactly\?"\}/);
	});
});

describe("mentorTranscript — the cap", () => {
	it("keeps the most recent blocks, cut at a block boundary behind '(earlier part omitted)'", () => {
		const messages = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, role: "user", content: `${String(i).padStart(2, "0")} ${"x".repeat(495)}`, timestamp: i }) as LhMessage);
		const text = mentorTranscript(messages, { speaker: "Teacher" });
		const blocks = text.split("\n\n");
		assert.equal(blocks[0], "(earlier part omitted)");
		assert.ok(text.length <= 12_000 + "(earlier part omitted)\n\n".length, String(text.length));
		assert.ok(blocks[1]!.startsWith("Learner: "), "the cut falls on a block boundary");
		assert.ok(blocks.at(-1)!.startsWith("Learner: 39 "), "the latest block is kept");
		const firstKept = Number(blocks[1]!.slice("Learner: ".length, "Learner: ".length + 2));
		assert.equal(blocks.length - 1, 40 - firstKept);
		assert.equal(mentorTranscript(messages.slice(0, 3), { speaker: "Teacher" }).startsWith("Learner: 00"), true, "under the cap nothing is omitted");
	});

	it("an oversized last block is kept whole", () => {
		const big = { id: "u", role: "user", content: "y".repeat(20_000), timestamp: 1 } as LhMessage;
		const text = mentorTranscript([{ id: "u0", role: "user", content: "short", timestamp: 0 } as LhMessage, big], { speaker: "Teacher" });
		assert.equal(text, `(earlier part omitted)\n\nLearner: ${"y".repeat(20_000)}`);
	});
});
