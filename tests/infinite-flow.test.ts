/**
 * Infinite-flow integration test — an Infinite session through the real
 * chat handler with a scripted model (the practice-flow harness):
 *
 *   learner opens → the agent runs a command in the chat's folder and
 *   poses a challenge → the learner's work arrives → the agent runs it,
 *   concludes → the learner's go-ahead ("next") is accepted.
 *
 * Under pin: the handler hands the record's folder to the agent, the
 * practice machinery (pose ends the turn, the next signal, no extraction)
 * applies to kind "infinite", and the calls land in the tool log.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseStep,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createInfiniteAgent, type AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import { toolLogFile } from "../src/agent/tool-log.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { activeProblemOf } from "../src/core/index.ts";
import { PATHS } from "../config.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-infinite-flow-")));
const created: string[] = [];
after(() => {
	for (const id of created) {
		for (const file of [path.join(PATHS.chats, `${id}.json`), toolLogFile(id)]) {
			try { fs.unlinkSync(file); } catch { /* already gone */ }
		}
	}
	fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

const POSE = {
	statement: "In `01-sum.py`, print the sum of the integers given on the command line.",
	mode: "recall",
	modelSolution: "import sys\nprint(sum(int(a) for a in sys.argv[1:]))",
} as const;
const CONCLUDE = { outcome: "solved", verdict: "Ran it with 1 2 3; printed 6.", rung: null, missClass: null, retest: false } as const;

function createInfiniteChat(title: string) {
	const chat = chatStore.createChat(title, "infinite", (id) => {
		const dir = path.join(WORKSPACE, id);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	});
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	created.push(chat.id);
	return chat;
}

const post = (chatId: string, input: unknown) => new Request("http://test/api/chat", {
	method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input }),
});

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
		return typeof step === "function" ? await step(context, undefined, undefined as never, undefined as never) : step;
	}));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

describe("infinite flow (scripted model)", () => {
	it("the handler hands over the chat's folder; the agent runs, poses, checks, concludes; next is accepted", async () => {
		const chat = createInfiniteChat("Test: infinite python");
		const dir = chatStore.getChat(chat.id)!.workspaceDir!;
		assert.equal(chatStore.getChat(chat.id)!.kind, "infinite");
		const seen: Array<AgentBuildOptions["workspaceDir"]> = [];
		const { engine, calls } = scripted([
			// Turn 1: look at the folder, then pose (the pose ends the run).
			() => fauxAssistantMessage([fauxToolCall("run_command", { command: "pwd" }, { id: "call-r1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p1" })], { stopReason: "toolUse" }),
			// Turn 2: the learner says done — run their file, conclude, close.
			() => fauxAssistantMessage([fauxToolCall("run_command", { command: "cat 01-sum.py" }, { id: "call-r2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("conclude", CONCLUDE, { id: "call-c1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Solid. Say when you want the next one.")]),
			// Turn 3: the go-ahead.
			() => fauxAssistantMessage([fauxText("Next challenge coming.")]),
		]);
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) => {
			seen.push(opts.workspaceDir);
			return createInfiniteAgent({ chatId: chat.id, chatStore }, { engine, messages: opts.messages, chatId: chat.id, workspaceDir: opts.workspaceDir });
		};

		await drainTurn(post(chat.id, { type: "text", text: "get me good at python" }), factory);
		assert.deepEqual(seen, [dir], "the handler passes the record's folder to the agent");
		const afterPose = chatStore.getChat(chat.id)!.messages;
		const ran = afterPose.find((m) => (m as ToolResultMessage).toolName === "run_command") as LhMessage & ToolResultMessage;
		assert.ok((ran.content[0] as { text: string }).text.includes(dir), "the command ran in the chat's folder");
		assert.equal(activeProblemOf(afterPose)?.toolCallId, "call-p1", "the pose ended the turn with the challenge active");

		fs.writeFileSync(path.join(dir, "01-sum.py"), "import sys\nprint(sum(map(int, sys.argv[1:])))\n");
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-p1", text: "done" }), factory);
		const afterConclude = chatStore.getChat(chat.id)!.messages;
		assert.equal(activeProblemOf(afterConclude), null);
		assert.ok(calls.some((prompt) => prompt.includes("sum(map(int")), "the model saw the learner's file through run_command");

		// The between-problems go-ahead is a practice-style affordance: it
		// must be accepted for an Infinite session, not refused as teach.
		await drainTurn(post(chat.id, { type: "next" }), factory);
		assert.ok(JSON.stringify(chatStore.getChat(chat.id)!.messages).includes("Next challenge coming."));

		const logged = fs.readFileSync(toolLogFile(chat.id), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { tool: string; agent: string; args: unknown });
		assert.deepEqual(logged.map((line) => line.tool), ["run_command", "problem", "run_command", "conclude"]);
		assert.ok(logged.every((line) => line.agent === "infinite"));
		assert.deepEqual(logged[0]!.args, { command: "pwd" });
	});

	it("a chat born without a folder runs with no workspace handed over", async () => {
		const chat = chatStore.createChat("Test: old infinite", "infinite");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		created.push(chat.id);
		const seen: unknown[] = [];
		const { engine } = scripted([() => fauxAssistantMessage([fauxText("What do you want to get good at?")])]);
		await drainTurn(post(chat.id, { type: "text", text: "hello" }), (opts) => {
			seen.push(opts.workspaceDir);
			return createInfiniteAgent({ chatId: chat.id, chatStore }, { engine, messages: opts.messages, chatId: chat.id, workspaceDir: opts.workspaceDir });
		});
		assert.deepEqual(seen, [undefined]);
	});
});
