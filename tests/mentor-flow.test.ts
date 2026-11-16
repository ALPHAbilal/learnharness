/**
 * The mentor (the learner's "Coach", coach-planner design §4.5/§4.7) end to
 * end through the turn composition, with an injected mentor runner and
 * scripted faux engines under an isolated LH_DATA_DIR:
 *
 *   1. probe: the goal answer (ask_user_question) → the mentor draws the
 *      map → probeFacts saved with its start level, graph nodes written, a
 *      [Probe step] card naming the app's pick that the prober reads next;
 *      the prober's next probe call must tag exactly that fact;
 *      mentor-changed fires true then false; usage lands on the card;
 *   2. teach: own-words answers judged correct become evidence and pass a node;
 *   3. teach: an added fact unpasses the current node until proven; the
 *      plan-update marker carries the full tree;
 *   4. teach: an inserted node gets the next node-handoff (origin "coach");
 *   5. a null review: the card is still appended and the node still advances;
 *   6. the planner wake: the planner's context starts at the brief,
 *      plan_batch appends, plan-accept hands off to the next node;
 *   7. the parallel-question deferral and `continue` never run the mentor.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep, type Usage } from "@earendil-works/pi-ai";
import type { LhMarkerMessage, LhMessage, TeachingAgentKind } from "../src/core/native-messages.ts";
import { danglingQuestionOf, newNodeHandoffMessage } from "../src/core/native-messages.ts";
import type { EvidenceEvent, PlanTree } from "../src/core/contracts.ts";
import type { MentorReview } from "../src/core/contracts/mentor.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { MentorRunArgs } from "../src/agent/subagents/mentor.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mentor-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { mentorInFlight } = await import("../src/server/mentor.ts");
const { createPlannerAgent, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { subscribe } = await import("../src/core/events.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function engineOf(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function textsOf(context: { messages: Array<{ role?: string; content?: unknown }> }): string[] {
	return context.messages.filter((m) => m.role !== "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

function assistantCall(id: string, name: string, args: unknown): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args as never }],
		api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: 1,
	} as never;
}

async function settle(chatId: string): Promise<void> {
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	const started = Date.now();
	while (isTurnRunning(chatId)) {
		if (Date.now() - started > 8000) throw new Error("turn never settled");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const markers = (messages: readonly LhMessage[], type: string) =>
	messages.filter((m): m is LhMarkerMessage & LhMessage => m.role === "custom" && m.customType === type);

const OPTIONS = [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }, { label: "Maybe", value: "maybe" }];
const quizOn = (nodeId: string, fact: string) => ({
	type: "check", nodeId, facts: [fact], question: `Is ${fact} true?`, options: OPTIONS, explanation: "It is.", correctAnswer: "yes",
});
const explainOn = (nodeId: string, fact: string) => ({ type: "check", nodeId, facts: [fact], question: `Explain ${fact}.`, correctAnswer: `${fact} holds.` });

function quizAnswer(question: string, value: "yes" | "no"): QuestionAnswerData {
	return { kind: "quiz", tool: "quiz", questionText: question, dontKnow: false, answers: [{ label: value === "yes" ? "Yes" : "No", value, index: value === "yes" ? 0 : 1 }], correct: value === "yes", confidence: 50, answeredAt: new Date().toISOString() };
}

const USAGE: Usage = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** An injected mentor: answers from a queue (null once exhausted), records
 *  every call's arguments and whether the registry saw it running. */
function mentorOf(queue: Array<Partial<MentorReview> | null>) {
	const calls: MentorRunArgs[] = [];
	const inFlight: boolean[] = [];
	const run = async (args: MentorRunArgs): Promise<MentorReview | null> => {
		calls.push(args);
		inFlight.push(mentorInFlight(chatIdOf(args)));
		args.onUsage?.(USAGE);
		const next = queue.shift();
		return next ? { notes: [], judged: [], addFacts: [], addArrows: [], addNodes: [], askLearner: null, ...next } : null;
	};
	return { run, calls, inFlight };
}
let currentChat = "";
const chatIdOf = (_args: MentorRunArgs) => currentChat;

function configuredChat(title: string, messages: LhMessage[] = []): string {
	const chatId = chatStore.createChat(title).id;
	chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	if (messages.length) chatStore.saveMessages(chatId, messages);
	currentChat = chatId;
	return chatId;
}

type Factory = NonNullable<Parameters<typeof handleChatInput>[2]>;
function factoryOf(chatId: string, engines: { prober?: PiEngine; teacher?: PiEngine; planner?: PiEngine }, seen: TeachingAgentKind[] = [], toolToggles?: Record<string, boolean>): Factory {
	return (opts) => {
		seen.push(opts.kind);
		if (opts.kind === "prober") return createProberAgent({ chatId, chatStore, deliver: () => {}, jobStore, spawn: () => {} }, { engine: engines.prober, messages: opts.messages });
		if (opts.kind === "planner") return createPlannerAgent({ chatId, chatStore, graphStore, jobStore, spawn: () => {} }, { engine: engines.planner, messages: opts.messages });
		return createTeacherAgent({ chatId, chatStore, jobStore, spawn: () => {} }, { engine: engines.teacher, messages: opts.messages, toolToggles });
	};
}

/** A teaching record on node `current` of `tree`, with a dangling question. */
function teachRecord(tree: PlanTree, current: string, question: LhMessage): LhMessage[] {
	return [
		{ id: "u0", role: "user", content: "teach me Flask", timestamp: 1 } as LhMessage,
		assistantCall("p", "probe_done", { assessment: { strands: [{ strand: "python", assessment: "Floor: functions." }], summary: "Start at modules." } }),
		{ id: "pr", role: "toolResult", toolCallId: "call_p", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 2 } as LhMessage,
		newNodeHandoffMessage(current, `[Node handoff] ${current}`) as LhMessage,
		question,
	];
}

const linearTree = (prefix: string, ids: string[]): PlanTree => ({
	nodes: ids.map((id) => ({ id, title: `Node ${id}`, facts: [{ id: `f${id}`, graphId: `n_${prefix}_${id}`, statement: `Fact ${id} holds.` }], batch: 1, origin: "planner" as const })),
	edges: ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id })),
	version: 1,
});

function seedRight(graphId: string, n: number): void {
	for (let i = 0; i < n; i++) {
		graphStore.appendEvidence({ nodeId: graphId, chatId: "seed", messageId: `seed_${graphId}_${i}`, at: `2026-01-01T00:00:0${i}.000Z`, source: "quiz", correct: true, guess: 1 / 3 } satisfies EvidenceEvent);
	}
}

async function answerPending(chatId: string, factory: Factory, mentor: { run: (a: MentorRunArgs) => Promise<MentorReview | null> }, answerOf: (question: string, tool: string) => QuestionAnswerData): Promise<string> {
	const pending = danglingQuestionOf(chatStore.getChat(chatId)!.messages);
	assert.ok(pending, "a question is pending");
	const res = await handleChatInput(chatId, { type: "answer", toolCallId: pending.toolCallId, answer: answerOf((pending.input as { question: string }).question, pending.tool) }, factory, undefined, { mentor: mentor.run });
	assert.equal(res.status, 200, await res.clone().text());
	await settle(chatId);
	return chatStore.getChat(chatId)!.messages.find((m) => m.role === "toolResult" && m.toolCallId === pending.toolCallId)!.id;
}

// ── the flows ────────────────────────────────────────────────────────────────

describe("the mentor through the turn composition", () => {
	it("teach: own-words answers judged correct become evidence and pass the node", async () => {
		const tree = linearTree("ex", ["a", "b", "c"]);
		const chatId = configuredChat("Mentor: explain", teachRecord(tree, "a", assistantCall("q0", "explain", explainOn("a", "fa"))));
		chatStore.saveTree(chatId, tree);
		const teacher = engineOf([
			() => fauxAssistantMessage([fauxToolCall("explain", explainOn("a", "fa") as never, { id: "call-ex1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("On to b.")]),
		]);
		const factory = factoryOf(chatId, { teacher }, [], { explain: true });
		const mentor = mentorOf([{ judged: [{ factId: "fa", correct: true }] }, { judged: [{ factId: "fa", correct: true }] }]);
		const explainAnswer = (question: string): QuestionAnswerData => ({ kind: "explain", tool: "explain", questionText: question, dontKnow: false, answers: [], text: "fa holds because…", answeredAt: new Date().toISOString() });

		const first = await answerPending(chatId, factory, mentor, explainAnswer);
		assert.match(mentor.calls[0]!.input, /App verdict: not graded by the app \(own words\) — judge it$/);
		assert.equal(markers(chatStore.getChat(chatId)!.messages, "node-handoff").length, 1, "one right free-text answer does not pass");
		const second = await answerPending(chatId, factory, mentor, explainAnswer);

		const rows = graphStore.readEvidence().filter((e) => e.chatId === chatId);
		assert.deepEqual(rows.map((r) => [r.nodeId, r.messageId, r.source, r.correct, r.guess]), [
			["n_ex_a", first, "quiz", true, 0.1],
			["n_ex_a", second, "quiz", true, 0.1],
		]);
		const messages = chatStore.getChat(chatId)!.messages;
		const handoffs = markers(messages, "node-handoff");
		assert.equal(handoffs.length, 2);
		assert.equal((handoffs[1]!.details as { nodeId: string }).nodeId, "b");
		const card = markers(messages, "coach-card").at(-1)!;
		assert.match(card.content, /- \[fa\] Fact a holds\. — 97%/, "the card carries the judged number");
		assert.equal(messages.indexOf(handoffs[1]!) - 1, messages.indexOf(card), "card, then the handoff");
	});

	it("teach: an added fact unpasses the current node until proven; plan-update carries the full tree", async () => {
		const tree = linearTree("add", ["a", "b", "c"]);
		seedRight("n_add_a", 2);
		const chatId = configuredChat("Mentor: add fact", teachRecord(tree, "a", assistantCall("q0", "quiz", quizOn("a", "fa"))));
		chatStore.saveTree(chatId, tree);
		const teacher = engineOf([
			...[1, 2, 3].map((i) => () => fauxAssistantMessage([fauxToolCall("quiz", quizOn("a", "fa-extra") as never, { id: `call-x${i}` })], { stopReason: "toolUse" })),
			() => fauxAssistantMessage([fauxText("On to b.")]),
		]);
		const factory = factoryOf(chatId, { teacher });
		const mentor = mentorOf([{ addFacts: [{ id: "fa-extra", name: "Extra", statement: "The extra fact holds." }], notes: ["Missing the extra fact."] }]);
		const right = (question: string) => quizAnswer(question, "yes");

		const answerId = await answerPending(chatId, factory, mentor, right);
		let messages = chatStore.getChat(chatId)!.messages;
		const answerIndex = messages.findIndex((m) => m.id === answerId);
		const update = messages[answerIndex + 1] as LhMarkerMessage;
		assert.equal(update.customType, "plan-update");
		assert.equal(update.content, "");
		assert.equal(update.display, false);
		const saved = chatStore.getChat(chatId)!.tree!;
		assert.deepEqual((update.details as { tree: PlanTree }).tree, saved, "the full tree");
		assert.deepEqual(saved.nodes[0]!.facts!.map((f) => f.id), ["fa", "fa-extra"]);
		assert.equal(saved.version, 2);
		assert.ok(graphStore.readNodes().some((n) => n.id === saved.nodes[0]!.facts![1]!.graphId));
		assert.equal((messages[answerIndex + 2] as LhMarkerMessage).customType, "coach-card");
		assert.match((messages[answerIndex + 2] as LhMarkerMessage).content, /- \[fa\] Fact a holds\. — 89%\n- \[fa-extra\] The extra fact holds\. — 30%/);
		assert.equal(markers(messages, "node-handoff").length, 1, "fa passed, but the node now waits for fa-extra");

		await answerPending(chatId, factory, mentor, right);
		await answerPending(chatId, factory, mentor, right);
		assert.equal(markers(chatStore.getChat(chatId)!.messages, "node-handoff").length, 1);
		await answerPending(chatId, factory, mentor, right);
		messages = chatStore.getChat(chatId)!.messages;
		assert.equal(markers(messages, "node-handoff").length, 2, "fa-extra proven: the node passes");
		assert.equal((markers(messages, "node-handoff")[1]!.details as { nodeId: string }).nodeId, "b");
		assert.equal(markers(messages, "plan-update").length, 1, "only a changed tree is announced");
	});

	it("teach: an inserted node takes the next node-handoff, origin coach", async () => {
		const tree = linearTree("ins", ["a", "b", "c"]);
		const chatId = configuredChat("Mentor: insert node", teachRecord(tree, "b", assistantCall("q0", "quiz", quizOn("b", "fb"))));
		chatStore.saveTree(chatId, tree);
		seedRight("n_ins_a", 3);
		const teacherSaw: string[][] = [];
		const teacher = engineOf([(context) => {
			teacherSaw.push(textsOf(context as never));
			return fauxAssistantMessage([fauxText("Let us look at URLs first.")]);
		}]);
		const seen: TeachingAgentKind[] = [];
		const factory = factoryOf(chatId, { teacher }, seen);
		const mentor = mentorOf([{ addNodes: [{ id: "urls", title: "URLs", facts: [{ id: "url-parts", name: "URL parts", statement: "A URL has a path." }] }], notes: ["Asked what a URL is."] }]);

		const answerId = await answerPending(chatId, factory, mentor, (q) => quizAnswer(q, "no"));
		const record = chatStore.getChat(chatId)!;
		assert.deepEqual(record.tree!.nodes.map((n) => [n.id, n.origin]), [["a", "planner"], ["urls", "coach"], ["b", "planner"], ["c", "planner"]]);
		assert.ok(record.tree!.edges.some((e) => e.from === "urls" && e.to === "b"));
		const i = record.messages.findIndex((m) => m.id === answerId);
		assert.deepEqual(record.messages.slice(i + 1, i + 4).map((m) => (m as LhMarkerMessage).customType), ["plan-update", "coach-card", "node-handoff"]);
		const handoff = record.messages[i + 3] as LhMarkerMessage;
		assert.equal((handoff.details as { nodeId: string }).nodeId, "urls");
		assert.match(handoff.content, /- urls: URLs  ← you are here/);
		assert.match(handoff.content, /The coach's last card:\n\[Coach card\]/);
		assert.deepEqual(seen, ["teacher"]);
		assert.equal(teacherSaw[0]!.length, 1, "the teacher's fresh context opens at the new handoff");
		assert.ok(teacherSaw[0]![0]!.includes("[Node handoff]"));
	});

	it("a null review: the card is still appended and the node still advances", async () => {
		const tree = linearTree("null", ["a", "b", "c"]);
		seedRight("n_null_a", 2);
		const chatId = configuredChat("Mentor: null review", teachRecord(tree, "a", assistantCall("q0", "quiz", quizOn("a", "fa"))));
		chatStore.saveTree(chatId, tree);
		const factory = factoryOf(chatId, { teacher: engineOf([() => fauxAssistantMessage([fauxText("On to b.")])]) });
		const mentor = mentorOf([null]);
		const answerId = await answerPending(chatId, factory, mentor, (q) => quizAnswer(q, "yes"));
		assert.equal(mentor.calls.length, 1);
		const messages = chatStore.getChat(chatId)!.messages;
		const i = messages.findIndex((m) => m.id === answerId);
		const card = messages[i + 1] as LhMarkerMessage;
		assert.equal(card.customType, "coach-card");
		assert.deepEqual(card.details, { phase: "teach", nodeId: "a", notes: [], askLearner: null });
		assert.match(card.content, /This node's facts .*:\n- \[fa\] Fact a holds\. — 89%$/);
		assert.equal((messages[i + 2] as LhMarkerMessage).customType, "node-handoff");
		assert.equal(((messages[i + 2] as LhMarkerMessage).details as { nodeId: string }).nodeId, "b");
	});

	it("the planner wake: the planner's context starts at the brief; plan_batch appends; Start hands off", async () => {
		const tree = linearTree("wake", ["a", "b"]);
		seedRight("n_wake_a", 2);
		for (const node of tree.nodes) for (const f of node.facts!) graphStore.appendNode({ id: f.graphId, name: f.id, statement: f.statement, aliases: [], createdAt: "2026-01-01T00:00:00.000Z", provenance: [{ chatId: "seed", messageId: "" }] } as never);
		const chatId = configuredChat("Mentor: planner wake", teachRecord(tree, "a", assistantCall("q0", "quiz", quizOn("a", "fa"))));
		chatStore.saveTree(chatId, tree);
		const plannerSaw: string[][] = [];
		const teacherSaw: string[][] = [];
		const planner = engineOf([
			(context) => {
				plannerSaw.push(textsOf(context as never));
				return fauxAssistantMessage([fauxToolCall("plan_batch", { nodes: [{ id: "c", title: "Node c", requires: ["b"], facts: [{ id: "fc", name: "C", statement: "Fact c holds." }] }], arrows: [{ premises: ["fb"], conclusion: "fc" }] } as never, { id: "call-batch" })], { stopReason: "toolUse" });
			},
			() => fauxAssistantMessage([fauxText("Next: b, then c.")]),
		]);
		const teacher = engineOf([(context) => {
			teacherSaw.push(textsOf(context as never));
			return fauxAssistantMessage([fauxText("Starting b.")]);
		}]);
		const seen: TeachingAgentKind[] = [];
		const factory = factoryOf(chatId, { planner, teacher }, seen);
		const mentor = mentorOf([{ notes: ["Solid on a."] }]);

		const answerId = await answerPending(chatId, factory, mentor, (q) => quizAnswer(q, "yes"));
		let messages = chatStore.getChat(chatId)!.messages;
		const i = messages.findIndex((m) => m.id === answerId);
		assert.deepEqual(messages.slice(i + 1, i + 3).map((m) => (m as LhMarkerMessage).customType), ["coach-card", "planner-wake"]);
		assert.match((messages[i + 2] as LhMarkerMessage).content, /The coach's notes:\n- Solid on a\./);
		assert.deepEqual(seen, ["planner"]);
		assert.ok(plannerSaw[0]![0]!.includes("[Planner brief]"), "the planner's model context starts at the brief");
		assert.ok(!plannerSaw[0]!.some((t) => t.includes("[Coach card]")), "nothing before the wake");
		const appended = chatStore.getChat(chatId)!.tree!;
		assert.deepEqual(appended.nodes.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(markers(messages, "node-handoff").length, 1);

		const accept = await handleChatInput(chatId, { type: "plan-accept" }, factory, undefined, { mentor: mentor.run });
		assert.equal(accept.status, 200, await accept.clone().text());
		await settle(chatId);
		messages = chatStore.getChat(chatId)!.messages;
		const handoffs = markers(messages, "node-handoff");
		assert.equal(handoffs.length, 2);
		assert.equal((handoffs[1]!.details as { nodeId: string }).nodeId, "b");
		assert.match(handoffs[1]!.content, /The coach's last card:\n\[Coach card\]/);
		assert.equal(seen.at(-1), "teacher");
		assert.equal(teacherSaw[0]!.length, 1);
		assert.equal(mentor.calls.length, 1, "plan-accept is no answer");
	});

	it("an abort during the review releases the turn; the answer and its evidence stay saved, nothing else is appended", async () => {
		const tree = linearTree("abort", ["a", "b", "c"]);
		const chatId = configuredChat("Mentor: abort", teachRecord(tree, "a", assistantCall("q0", "quiz", quizOn("a", "fa"))));
		chatStore.saveTree(chatId, tree);
		let busy = false;
		const run = async (args: MentorRunArgs): Promise<MentorReview | null> => {
			busy = isTurnRunning(chatId);
			runningTurn(chatId)!.abort(); // the abort route's path: the preparation's handle
			assert.equal(args.signal?.aborted, true);
			return null;
		};
		const res = await handleChatInput(chatId, { type: "answer", toolCallId: "call_q0", answer: quizAnswer("Is fa true?", "yes") }, () => { throw new Error("no agent after an abort"); }, undefined, { mentor: run });
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal(busy, true, "the chat counts as busy while the mentor runs");
		await settle(chatId);
		assert.equal(isTurnRunning(chatId), false, "the claim is released");
		const messages = chatStore.getChat(chatId)!.messages;
		assert.equal(messages.at(-1)!.role, "toolResult", "the answer is saved; no card, no reaction");
		assert.equal(graphStore.readEvidence().filter((e) => e.chatId === chatId).length, 1);
	});

	it("the parallel-question deferral and continue never run the mentor", async () => {
		const tree = linearTree("par", ["a", "b", "c"]);
		const twin: LhMessage = {
			...assistantCall("q", "quiz", {}),
			content: [
				{ type: "toolCall", id: "call_q1", name: "quiz", arguments: quizOn("a", "fa") },
				{ type: "toolCall", id: "call_q2", name: "quiz", arguments: quizOn("a", "fa") },
			],
		} as never;
		const chatId = configuredChat("Mentor: parallel", teachRecord(tree, "a", twin));
		chatStore.saveTree(chatId, tree);
		const mentor = mentorOf([]);
		const noAgent = () => { throw new Error("no agent: the gate defers"); };
		const res = await handleChatInput(chatId, { type: "answer", toolCallId: "call_q1", answer: quizAnswer("Is fa true?", "yes") }, noAgent, undefined, { mentor: mentor.run });
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal(mentor.calls.length, 0);
		assert.equal(markers(chatStore.getChat(chatId)!.messages, "coach-card").length, 0);
		assert.equal(graphStore.readEvidence().filter((e) => e.chatId === chatId).length, 1, "the deferred answer is still stamped");

		// A record that ends on an answer whose reaction never ran: continue.
		const chatId2 = configuredChat("Mentor: continue", teachRecord(tree, "a", assistantCall("q9", "quiz", quizOn("a", "fa"))));
		chatStore.saveTree(chatId2, tree);
		const record = chatStore.getChat(chatId2)!;
		chatStore.saveMessages(chatId2, [...record.messages, { id: "r9", role: "toolResult", toolCallId: "call_q9", toolName: "quiz", content: [{ type: "text", text: "{}" }], details: quizAnswer("Is fa true?", "yes") as never, isError: false, timestamp: 3 } as LhMessage]);
		const factory = factoryOf(chatId2, { teacher: engineOf([() => fauxAssistantMessage([fauxText("Picking up.")])]) });
		const cont = await handleChatInput(chatId2, { type: "continue" }, factory, undefined, { mentor: mentor.run });
		assert.equal(cont.status, 200, await cont.clone().text());
		await settle(chatId2);
		assert.equal(mentor.calls.length, 0);
		assert.equal(markers(chatStore.getChat(chatId2)!.messages, "coach-card").length, 0);
	});
});
