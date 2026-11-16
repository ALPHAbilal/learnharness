/**
 * The after-answer step end to end through the turn composition
 * (coach-planner design §4.3/§4.4/§4.7), with scripted faux engines under an
 * isolated LH_DATA_DIR:
 *
 *   planner turn (plan_batch, three one-fact nodes a → b → c) → plan-accept
 *   → the teacher asks tagged quizzes on a; three right 3-option answers
 *   pass a's fact (0.30 → 0.54 → 0.76 → 0.89) → the record gains a
 *   node-handoff for b and the same request's teacher context starts there
 *   → three right answers on b pass it, one unpassed node is left → the
 *   record gains a planner-wake and the PLANNER is the agent built.
 *
 * The learner's answers claim `correct: false`: the evidence rows carry the
 * server-derived verdict instead.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { LhMarkerMessage, LhMessage, TeachingAgentKind } from "../src/core/native-messages.ts";
import { danglingQuestionOf } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import type { PiEngine } from "../src/agent/models.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-advance-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { createPlannerAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { jobStore } = await import("../src/store/jobs.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PLAN = {
	nodes: [
		{ id: "a", title: "Letters", facts: [{ id: "fa", name: "Letters", statement: "Words are made of letters." }] },
		{ id: "b", title: "Vowels", requires: ["a"], facts: [{ id: "fb", name: "Vowels", statement: "A, e, i, o and u are vowels." }] },
		{ id: "c", title: "Syllables", requires: ["b"], facts: [{ id: "fc", name: "Syllables", statement: "Every syllable holds a vowel." }] },
	],
};

const OPTIONS = [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }, { label: "Maybe", value: "maybe" }];
const quizOn = (nodeId: string, fact: string) => ({
	type: "check", nodeId, facts: [fact],
	question: `Is ${fact} true?`, options: OPTIONS, explanation: "It is.", correctAnswer: "yes",
});

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

/** The learner picks "Yes" (the committed answer) but the client claims
 *  the answer was wrong — the server must not believe it. */
function lyingRightAnswer(question: string): QuestionAnswerData {
	return {
		kind: "quiz", tool: "quiz", questionText: question, dontKnow: false,
		answers: [{ label: "Yes", value: "yes", index: 1 }], correct: false, confidence: 50,
		answeredAt: new Date().toISOString(),
	};
}

const markers = (messages: readonly LhMessage[], type: string) =>
	messages.filter((m): m is LhMarkerMessage & LhMessage => m.role === "custom" && m.customType === type);

describe("the after-answer step through the turn composition", () => {
	it("passing a node hands off to the next; one unpassed node left wakes the planner", async () => {
		const chat = chatStore.createChat("Flow: advance");
		const chatId = chat.id;
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		chatStore.saveMessages(chatId, [
			{ id: "u0", role: "user", content: "teach me to read", timestamp: 1 } as LhMessage,
			assistantCall("p", "probe_done", { assessment: { strands: [{ strand: "reading", assessment: "Floor: none." }], summary: "Start at letters." } }),
			{ id: "pr", role: "toolResult", toolCallId: "call_p", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 2 } as LhMessage,
		]);

		const seen: TeachingAgentKind[] = [];
		const teacherSaw: string[][] = [];
		const plannerSaw: string[][] = [];
		const planner = engineOf([
			() => fauxAssistantMessage([fauxToolCall("plan_batch", PLAN as never, { id: "call-plan" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Letters, then vowels, then syllables.")]),
			(context) => {
				plannerSaw.push(textsOf(context as never));
				return fauxAssistantMessage([fauxText("Planning the next stretch.")]);
			},
		]);
		const asks: Array<[string, string]> = [["a", "fa"], ["a", "fa"], ["a", "fa"], ["b", "fb"], ["b", "fb"], ["b", "fb"]];
		const teacher = engineOf(asks.map(([nodeId, fact], i) => (context) => {
			teacherSaw.push(textsOf(context as never));
			return fauxAssistantMessage([fauxToolCall("quiz", quizOn(nodeId, fact) as never, { id: `call-q${i + 1}` })], { stopReason: "toolUse" });
		}));
		const factory = (opts: Parameters<NonNullable<Parameters<typeof handleChatInput>[2]>>[0]) => {
			seen.push(opts.kind);
			return opts.kind === "planner"
				? createPlannerAgent({ chatId, chatStore, graphStore, jobStore, spawn: () => {} }, { engine: planner, messages: opts.messages })
				// The real teacher registry: quiz validates nodeId and facts against the live record.
				: createTeacherAgent({ chatId, chatStore, jobStore, spawn: () => {} }, { engine: teacher, messages: opts.messages });
		};

		const plan = await handleChatInput(chatId, { type: "text", text: "Plan it." }, factory);
		assert.equal(plan.status, 200, await plan.clone().text());
		await settle(chatId);
		const tree = chatStore.getChat(chatId)!.tree!;
		const graphIdOf = (fact: string) => tree.nodes.flatMap((n) => n.facts ?? []).find((f) => f.id === fact)!.graphId;

		const accept = await handleChatInput(chatId, { type: "plan-accept" }, factory);
		assert.equal(accept.status, 200, await accept.clone().text());
		await settle(chatId);
		assert.equal(seen.at(-1), "teacher");

		const answerIds: string[] = [];
		const answerPending = async () => {
			const record = chatStore.getChat(chatId)!;
			const pending = danglingQuestionOf(record.messages);
			assert.ok(pending, "the teacher's tagged quiz is pending (it passed validation)");
			const res = await handleChatInput(chatId, { type: "answer", toolCallId: pending.toolCallId, answer: lyingRightAnswer((pending.input as { question: string }).question) }, factory);
			assert.equal(res.status, 200, await res.clone().text());
			await settle(chatId);
			const saved = chatStore.getChat(chatId)!.messages;
			const result = saved.find((m) => m.role === "toolResult" && m.toolCallId === pending.toolCallId)!;
			answerIds.push(result.id);
			return saved;
		};

		// Two right answers on a: the knowledge rises but a has not passed.
		await answerPending();
		let messages = await answerPending();
		assert.equal(markers(messages, "node-handoff").length, 1, "no advance before the node passes");

		// The third right answer passes a: the handoff for b lands right after the answer.
		messages = await answerPending();
		const handoffs = markers(messages, "node-handoff");
		assert.equal(handoffs.length, 2);
		assert.deepEqual(handoffs[1]!.details, { nodeId: "b", firstKeptMessageId: null });
		assert.match(handoffs[1]!.content, /You are starting the next node of the plan\./);
		assert.match(handoffs[1]!.content, /The road so far:\n- Letters: passed/);
		const handoffIndex = messages.indexOf(handoffs[1]!);
		// answer → the mentor's coach card → the handoff (which carries the card).
		assert.equal((messages[handoffIndex - 1] as LhMarkerMessage).customType, "coach-card");
		assert.equal(messages[handoffIndex - 2]!.id, answerIds[2], "the handoff follows the answer that completed the node");
		assert.match(handoffs[1]!.content, /The coach's last card:\n\[Coach card\]/);
		assert.deepEqual(seen.slice(-1), ["teacher"]);
		// The same request's teacher already starts at b: its context opens at the new handoff.
		const fourth = teacherSaw[3]!;
		assert.equal(fourth.length, 1, "the fresh teacher sees the handoff only");
		assert.ok(fourth[0]!.includes("You are starting the next node of the plan."));
		assert.ok(!fourth.some((t) => t.includes("Is fa true?")), "nothing from node a's conversation");

		// Evidence: three rows on a's fact, with the server's verdict (the client lied).
		const evidence = graphStore.readEvidence();
		assert.equal(evidence.length, 3);
		for (const [i, row] of evidence.entries()) {
			assert.equal(row.nodeId, graphIdOf("fa"));
			assert.equal(row.chatId, chatId);
			assert.equal(row.messageId, answerIds[i]);
			assert.equal(row.source, "quiz");
			assert.equal(row.correct, true, "server-derived, not the client's false");
			assert.equal(row.guess, 1 / 3);
			assert.equal(row.confidence, 50);
		}

		// Three right answers on b: b passes, only c is unpassed → the planner wakes.
		await answerPending();
		await answerPending();
		messages = await answerPending();
		const wakes = markers(messages, "planner-wake");
		assert.equal(wakes.length, 1);
		assert.equal(messages.indexOf(wakes[0]!) - 2, messages.findIndex((m) => m.id === answerIds[5]), "the wake follows the answer (and its coach card)");
		assert.match(wakes[0]!.content, /^\[Planner brief\]/);
		assert.match(wakes[0]!.content, /The road so far:\n- Letters: passed\n- Vowels: passed\n- Syllables: not passed/);
		assert.equal(seen.at(-1), "planner", "the planner is the agent built for this turn");
		assert.ok(plannerSaw[0]![0]!.includes("[Planner brief]"), "the planner's context opens at the wake");
		assert.equal(markers(messages, "node-handoff").length, 2, "no handoff for c: the planner plans first");
		assert.deepEqual(graphStore.readEvidence().map((e) => e.nodeId), [...Array(3).fill(graphIdOf("fa")), ...Array(3).fill(graphIdOf("fb"))]);
	});

	it("an answer deferred by the parallel-question gate is still stamped; nothing advances", async () => {
		const { newNodeHandoffMessage } = await import("../src/core/native-messages.ts");
		const chatId = chatStore.createChat("Flow: parallel stamp").id;
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		chatStore.saveTree(chatId, {
			nodes: [{ id: "a", title: "Letters", facts: [{ id: "fa", graphId: "n_parallel_fa", statement: "Words are made of letters." }] }],
			edges: [], version: 1,
		});
		const twin: LhMessage = {
			...assistantCall("q", "quiz", {}),
			content: [
				{ type: "toolCall", id: "call_q1", name: "quiz", arguments: quizOn("a", "fa") },
				{ type: "toolCall", id: "call_q2", name: "quiz", arguments: quizOn("a", "fa") },
			],
		} as never;
		chatStore.saveMessages(chatId, [
			{ id: "u0", role: "user", content: "teach me to read", timestamp: 1 } as LhMessage,
			assistantCall("p", "probe_done", { assessment: { strands: [], summary: "x" } }),
			{ id: "pr", role: "toolResult", toolCallId: "call_p", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 2 } as LhMessage,
			newNodeHandoffMessage("a", "[Node handoff] a") as LhMessage,
			twin,
		]);
		const before = graphStore.readEvidence().length;
		const res = await handleChatInput(chatId, { type: "answer", toolCallId: "call_q1", answer: lyingRightAnswer("Is fa true?") }, () => { throw new Error("no agent: the gate defers"); });
		assert.equal(res.status, 200, await res.clone().text());
		const rows = graphStore.readEvidence().slice(before);
		assert.equal(rows.length, 1);
		assert.deepEqual([rows[0]!.nodeId, rows[0]!.correct, rows[0]!.chatId], ["n_parallel_fa", true, chatId]);
		assert.equal(markers(chatStore.getChat(chatId)!.messages, "node-handoff").length, 1, "nothing advances while a sibling is open");
		// A re-post of the same answer is refused (no longer pending) and stamps nothing new.
		const again = await handleChatInput(chatId, { type: "answer", toolCallId: "call_q1", answer: lyingRightAnswer("Is fa true?") }, () => { throw new Error("no agent"); });
		assert.equal(again.status, 400);
		assert.equal(graphStore.readEvidence().length, before + 1);
	});
});
