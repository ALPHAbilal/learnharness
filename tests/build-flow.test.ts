/**
 * Build-branch turn cargo through the real chat handler (faux engine, zero
 * tokens): a build session's coach sees the branch context and new
 * workspace activity; a teaching session receives a queued branch summary
 * only AFTER a pending quiz's answer — never between the call and its
 * result — and exactly once.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-build-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
type AssistantMessage = import("@earendil-works/pi-ai").AssistantMessage;
type TranscriptContext = import("@earendil-works/pi-ai").TranscriptContext;
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;
type FauxResponseFactory = import("@earendil-works/pi-ai").FauxResponseFactory;
type PiEngine = import("../src/agent/models.ts").PiEngine;
const { createTeacherAgent, createBuildAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { buildAnswer, normalizeOptions, resolveCorrect } = await import("../src/core/question-core.ts");
const { newBuildContextMessage } = await import("../src/core/build-branch.ts");
const { allocateFolder, buildWorkspacePort, recordEvent, updateState } = await import("../src/server/build-workspace.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }) });
}

async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

function scripted(steps: FauxResponseStep[]): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps.map((step) => async (context: TranscriptContext): Promise<AssistantMessage> => {
		calls.push(context.messages.map((m) => JSON.stringify((m as { content?: unknown }).content)).join("\n"));
		return typeof step === "function" ? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never) : step;
	}));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

function newChat(title: string, kind?: "build", branch?: Parameters<typeof chatStore.createChat>[2]) {
	const chat = chatStore.createChat(title, kind, branch);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat;
}

const QUIZ = {
	question: "Where does the JSON go?",
	options: [{ label: "body" }, { label: "header" }],
	correctAnswer: "body",
	explanation: "The body carries data.",
	type: "check",
	nodeId: "http",
	facts: ["f-http"],
};

function graded(values: string[]) {
	const options = normalizeOptions(QUIZ.options);
	return buildAnswer({
		id: "call-q",
		kind: "quiz",
		question: QUIZ.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(QUIZ.correctAnswer, options).indices,
		explanation: QUIZ.explanation,
		createdAt: new Date().toISOString(),
	}, { values });
}

describe("build branch turn cargo", () => {
	it("delivers a queued summary after the pending quiz's answer, once", async () => {
		const parent = newChat("Flask lesson");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("quiz", QUIZ, { id: "call-q" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Good — and your build showed status codes are solid.")]),
			() => fauxAssistantMessage([fauxText("Next step.")]),
		]);
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
		await drainTurn(post(parent.id, { type: "text", text: "teach me HTTP" }), factory);

		// The learner branched, built, and returned while the quiz was pending.
		chatStore.queueBuildReturn(parent.id, { id: "ret_x", branchId: "chat_x", nodeId: "http", nodeTitle: "HTTP is plain text", summary: "solid: status codes", createdAt: "now", delivered: false });

		await drainTurn(post(parent.id, { type: "answer", toolCallId: "call-q", answer: graded(["body"]) }), factory);
		const saved = chatStore.getChat(parent.id)!;
		const resultIndex = saved.messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === "call-q");
		const returnIndex = saved.messages.findIndex((m) => m.role === "custom" && m.customType === "build-return");
		// The answer's coach card (the mentor's hidden marker) comes first.
		assert.equal((saved.messages[resultIndex + 1] as { customType?: string }).customType, "coach-card");
		assert.ok(resultIndex > 0 && returnIndex === resultIndex + 2, "the summary lands right after the answer (and its card), never before it");
		assert.equal(saved.buildReturns?.[0]?.delivered, true);
		assert.match(calls[1]!, /\[Build branch returned\]/);
		assert.match(calls[1]!, /solid: status codes/);

		await drainTurn(post(parent.id, { type: "text", text: "ok next" }), factory);
		const again = chatStore.getChat(parent.id)!;
		assert.equal(again.messages.filter((m) => m.role === "custom" && m.customType === "build-return").length, 1, "delivered exactly once");
	});

	it("gives the build coach its context and new workspace activity", async () => {
		const parent = newChat("Flask lesson 2");
		const folder = allocateFolder(parent.id, "http");
		const branch = { parentChatId: parent.id, parentNodeId: "http", parentNodeTitle: "HTTP is plain text", folder, phase: "customize" as const };
		const child = newChat("Build: HTTP", "build", branch);
		chatStore.saveMessages(child.id, [newBuildContextMessage("[Build branch context] goal: trace /chat", branch)]);
		updateState(child.id, (s) => recordEvent(s, "you", "file-saved", "Saved server.py"));

		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxText("Let's build a tiny server. What do you want out of it?")]),
			() => fauxAssistantMessage([fauxText("Next: predict.")]),
		]);
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) => createBuildAgent({
			chatId: child.id, chatStore, workspace: buildWorkspacePort(),
			terminal: () => ({ runAiCommand: async () => ({ output: "", exitCode: 0, running: false }), transcript: () => "" }),
		}, { engine, messages: opts.messages });

		await drainTurn(post(child.id, { type: "text", text: "I want to see the raw request" }), factory);
		assert.match(calls[0]!, /\[Build branch context\]/);
		assert.match(calls[0]!, /\[Workspace activity\]/);
		assert.match(calls[0]!, /Learner: Saved server\.py/);

		await drainTurn(post(child.id, { type: "text", text: "ready" }), factory);
		assert.doesNotMatch(calls[1]!.split("I want to see the raw request")[1] ?? "", /\[Workspace activity\]/, "seen activity is not repeated");
		const kinds = chatStore.getChat(child.id)!.messages.filter((m) => m.role === "custom").map((m) => (m as { customType: string }).customType);
		assert.deepEqual(kinds, ["build-context", "build-activity"]);
	});
});
