/**
 * The planner phase end to end through the turn composition (coach-planner
 * design §4.1, O3, O4), with scripted faux engines under an isolated
 * LH_DATA_DIR:
 *
 *   probe concluded → learner text → PLANNER turn (plan_batch, plan block,
 *   graph write) → plan-accept → node-handoff marker + TEACHER turn whose
 *   model context starts at the handoff (nothing from the probe or the
 *   planning) → a second plan-accept is refused → a later node-handoff
 *   moves the teacher's fresh context to it.
 *
 * Also: plan-accept before any plan is refused, and a legacy teach record
 * (a plan_init call) refuses every turn with the legacySession envelope
 * before anything is saved.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { LhMarkerMessage, LhMessage, TeachingAgentKind } from "../src/core/native-messages.ts";
import { newNodeHandoffMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-planner-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { handleChatInput, handleChatRequest } = await import("../src/server/chat-handler.ts");
const { createPlannerAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { nodeHandoffText, LEGACY_SESSION_CODE } = await import("../src/core/contracts.ts");
const { writePlannedFacts } = await import("../src/core/graph.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const PLAN = {
	nodes: [
		{ id: "modules", title: "Modules", facts: [
			{ id: "module-file", name: "A module is a file", statement: "A Python module is a file of definitions other files can import." },
			{ id: "import-runs", name: "Import runs once", statement: "An import statement runs a module once and binds its name." },
		] },
		{ id: "packages", title: "Packages", requires: ["modules"], facts: [
			{ id: "package-dir", name: "A package is a folder", statement: "A package is a folder of modules imported by dotted names." },
		] },
	],
	arrows: [{ premises: ["module-file"], conclusion: "import-runs" }],
};

function engineOf(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** The model-facing conversation of one request, minus the system message
 *  (request chrome: prompt and tool declarations). */
function textsOf(context: { messages: Array<{ role?: string; content?: unknown }> }): string[] {
	return context.messages.filter((m) => m.role !== "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

function configuredChat(title: string, messages: LhMessage[] = []): string {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	if (messages.length) chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

function assistantCall(id: string, name: string, args: unknown): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args as never }],
		api: "openai-completions", provider: "openrouter", model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: 1,
	} as never;
}

const probeDone = (): LhMessage[] => [
	{ id: "u0", role: "user", content: "teach me python imports", timestamp: 1 } as LhMessage,
	assistantCall("p", "probe_done", { assessment: { strands: [{ strand: "imports", assessment: "Floor: none." }], summary: "Start at modules." } }),
	{ id: "pr", role: "toolResult", toolCallId: "call_p", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 2 } as LhMessage,
];

async function settle(chatId: string): Promise<void> {
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	const started = Date.now();
	while (isTurnRunning(chatId)) {
		if (Date.now() - started > 8000) throw new Error("turn never settled");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("the planner phase through the turn composition", () => {
	it("planner turn → plan-accept → handoff + teacher turn; a second accept is refused", async () => {
		const chatId = configuredChat("Flow: planner", probeDone());
		const seen: Array<{ kind: TeachingAgentKind; teaching: boolean }> = [];
		const teacherSaw: string[][] = [];
		const planner = engineOf([
			() => fauxAssistantMessage([fauxToolCall("plan_batch", PLAN as unknown as Parameters<typeof fauxToolCall>[1], { id: "call-plan" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Here is the first stretch: modules, then packages.")]),
		]);
		const teacher = engineOf([
			(context) => {
				teacherSaw.push(textsOf(context as never));
				return fauxAssistantMessage([fauxText("Let's open with modules.")]);
			},
			(context) => {
				teacherSaw.push(textsOf(context as never));
				return fauxAssistantMessage([fauxText("Packages now.")]);
			},
		]);
		const factory = (opts: Parameters<NonNullable<Parameters<typeof handleChatInput>[2]>>[0]) => {
			seen.push({ kind: opts.kind, teaching: opts.teaching });
			return opts.kind === "planner"
				? createPlannerAgent({ chatId, chatStore, graphStore, jobStore, spawn: () => {} }, { engine: planner, messages: opts.messages })
				: createTeacherAgent(undefined, { engine: teacher, messages: opts.messages });
		};

		// Typed text while no plan is accepted runs a PLANNER turn.
		const first = await handleChatInput(chatId, { type: "text", text: "Plan it, please." }, factory);
		assert.equal(first.status, 200, await first.clone().text());
		await settle(chatId);
		assert.deepEqual(seen, [{ kind: "planner", teaching: true }]);
		const planned = chatStore.getChat(chatId)!;
		const tree = planned.tree!;
		assert.deepEqual(tree.nodes.map((n) => n.id), ["modules", "packages"]);
		const live = new Set(graphStore.readNodes().map((n) => n.id));
		for (const fact of tree.nodes.flatMap((n) => n.facts ?? [])) assert.ok(live.has(fact.graphId), "facts were written to the graph");
		const block = planned.messages.find((m) => m.role === "custom" && m.customType === "plan-block") as LhMarkerMessage | undefined;
		assert.ok(block, "a successful plan_batch presents a plan block");
		assert.equal(planned.messages.some((m) => m.role === "custom" && m.customType === "node-handoff"), false);

		// Start: the handoff appends write-ahead and the TEACHER runs.
		const before = planned.messages.length;
		const accept = await handleChatRequest(new Request("http://test/api/chat", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, input: { type: "plan-accept" } }),
		}), factory);
		assert.equal(accept.status, 200, await accept.clone().text());
		await settle(chatId);
		assert.deepEqual(seen.at(-1), { kind: "teacher", teaching: true });
		const accepted = chatStore.getChat(chatId)!;
		const handoff = accepted.messages[before] as LhMarkerMessage;
		assert.equal(handoff.customType, "node-handoff");
		assert.deepEqual(handoff.details, { nodeId: "modules", firstKeptMessageId: null });
		assert.equal(handoff.content, nodeHandoffText({ tree, nodeId: "modules", knowledge: new Map(), first: true, road: [], lastCard: null }));
		assert.equal(accepted.messages.at(-1)!.role, "assistant", "the teacher answered");
		// THE FRESH CONTEXT (design D2/§4.6): the teacher's model context
		// begins with the handoff text and holds nothing from the probe or
		// the planning conversation.
		const firstContext = teacherSaw[0]!;
		assert.equal(firstContext.length, 1, "the handoff is the whole conversation the teacher sees");
		assert.ok(firstContext[0]!.includes(JSON.stringify(handoff.content).slice(1, -1)), "it begins with the handoff text");
		for (const earlier of ["teach me python imports", "probe_done", "Floor: none.", "Plan it, please.", "plan_batch", "Here is the first stretch"]) {
			assert.ok(!firstContext.some((t) => t.includes(earlier)), `the teacher never sees "${earlier}"`);
		}

		// The plan is accepted now: Start again is an honest 400, nothing saved.
		const again = await handleChatInput(chatId, { type: "plan-accept" }, factory);
		assert.equal(again.status, 400);
		assert.match(((await again.json()) as { error: string }).error, /plan waiting for acceptance/);
		assert.equal(chatStore.getChat(chatId)!.messages.length, accepted.messages.length);

		// A later node: a second node-handoff (appended directly here; the
		// coach appends it in the product) moves the fresh context to it.
		const second = newNodeHandoffMessage("packages", "[Node handoff] the packages node");
		chatStore.saveMessages(chatId, [...accepted.messages, second as LhMessage]);
		const next = await handleChatInput(chatId, { type: "text", text: "Ready for more." }, factory);
		assert.equal(next.status, 200, await next.clone().text());
		await settle(chatId);
		assert.deepEqual(seen.at(-1), { kind: "teacher", teaching: true });
		const secondContext = teacherSaw[1]!;
		assert.equal(secondContext.length, 2);
		assert.ok(secondContext[0]!.includes("[Node handoff] the packages node"), "the context begins at the second handoff");
		assert.ok(secondContext[1]!.includes("Ready for more."));
		for (const earlier of ["Let's open with modules.", "You are starting the first node", "teach me python imports"]) {
			assert.ok(!secondContext.some((t) => t.includes(earlier)), `the second node never sees "${earlier}"`);
		}
		assert.ok(chatStore.getChat(chatId)!.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("Let's open with modules.")), "the record keeps everything");
	});

	it("a plan fact that reuses a probe fact's id carries the probe's evidence into the first handoff", async () => {
		const chatId = configuredChat("Flow: probe fact carried", probeDone());
		// The coach's probe fact list, and the learner's right probe answer on it.
		const probeFact = PLAN.nodes[0]!.facts[0]!;
		const graphId = writePlannedFacts(chatId, [probeFact], [], { chatStore, graphStore }).ids[probeFact.id]!;
		chatStore.saveProbeFacts(chatId, { facts: [{ id: probeFact.id, graphId, statement: probeFact.statement, minted: true }], arrows: [] });
		graphStore.appendEvidence({ nodeId: graphId, chatId, messageId: "m-probe", at: new Date().toISOString(), source: "probe", correct: true, guess: 0.33 });
		const planner = engineOf([
			() => fauxAssistantMessage([fauxToolCall("plan_batch", PLAN as unknown as Parameters<typeof fauxToolCall>[1], { id: "call-plan" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Modules, then packages.")]),
		]);
		const teacher = engineOf([() => fauxAssistantMessage([fauxText("Let's open with modules.")])]);
		const factory = (opts: Parameters<NonNullable<Parameters<typeof handleChatInput>[2]>>[0]) => opts.kind === "planner"
			? createPlannerAgent({ chatId, chatStore, graphStore, jobStore, spawn: () => {} }, { engine: planner, messages: opts.messages })
			: createTeacherAgent(undefined, { engine: teacher, messages: opts.messages });

		const planned = await handleChatInput(chatId, { type: "text", text: "Plan it, please." }, factory);
		assert.equal(planned.status, 200, await planned.clone().text());
		await settle(chatId);
		const fact = chatStore.getChat(chatId)!.tree!.nodes[0]!.facts![0]!;
		assert.equal(fact.graphId, graphId, "the plan fact is the probe fact's graph node");

		const accept = await handleChatInput(chatId, { type: "plan-accept" }, factory);
		assert.equal(accept.status, 200, await accept.clone().text());
		await settle(chatId);
		const handoff = chatStore.getChat(chatId)!.messages.find((m) => m.role === "custom" && m.customType === "node-handoff") as LhMarkerMessage;
		assert.equal((handoff.details as { nodeId: string }).nodeId, "modules");
		const line = handoff.content.split("\n").find((l) => l.startsWith(`- [${probeFact.id}] `));
		assert.ok(line, "the handoff lists the probed fact");
		const shown = Number(/ — (\d+)%/.exec(line)![1]);
		assert.notEqual(shown, 30, "the probe's evidence shows, not the 30% prior");
		assert.ok(shown > 30);
		assert.match(handoff.content, /- \[import-runs\] .* — 30%/, "an unprobed fact starts from the prior");
	});

	it("plan-accept before any plan exists is refused without a turn", async () => {
		const chatId = configuredChat("Flow: no plan", probeDone());
		let built = false;
		const res = await handleChatInput(chatId, { type: "plan-accept" }, () => { built = true; throw new Error("no agent expected"); });
		assert.equal(res.status, 400);
		assert.match(((await res.json()) as { error: string }).error, /requires a stored plan/);
		assert.equal(built, false);
		assert.equal(chatStore.getChat(chatId)!.messages.length, 3);
	});
});

describe("legacy teach sessions (a plan_init call in the record)", () => {
	it("refuses every turn with the legacySession envelope before anything is saved", async () => {
		const messages = [...probeDone(), assistantCall("old", "plan_init", { mermaid: "graph TD\n  a[A]" })];
		const chatId = configuredChat("Flow: legacy", messages);
		const snapshot = structuredClone(chatStore.getChat(chatId)!.messages);
		for (const input of [{ type: "text", text: "continue" }, { type: "continue" }, { type: "plan-accept" }] as const) {
			let built = false;
			const res = await handleChatInput(chatId, input, () => { built = true; throw new Error("no agent expected"); });
			assert.equal(res.status, 410);
			const body = (await res.json()) as { code: string; error: string };
			assert.equal(body.code, LEGACY_SESSION_CODE);
			assert.equal(body.code, "legacySession");
			assert.equal(body.error, "This lesson was created before the coach update. It stays readable, but it cannot be continued. Start a new session to keep learning.");
			assert.equal(built, false);
		}
		assert.deepEqual(chatStore.getChat(chatId)!.messages, snapshot, "the record is untouched");
	});
});
