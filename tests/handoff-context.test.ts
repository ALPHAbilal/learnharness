/**
 * The fresh context (coach-planner design §4.6/§4.7): the teacher's model
 * context starts at the latest node-handoff, the planner's at a
 * planner-wake that is the latest boundary (toLlmMessages `boundary`).
 *
 *  A.1 tool call/result pairing inside the range stays intact, dangling
 *      calls still get the interrupted result, no orphan result is emitted;
 *  A.2 a compaction after the boundary applies inside the range; one whose
 *      kept message lies at or before it is ignored;
 *  A.3 later markers inside the range flatten exactly as today;
 *  A.4 with no boundary marker of the requested type the output is
 *      byte-identical to the no-option conversion.
 *
 * Plus the boundary-aware accounting: usage anchor, cut index, CLI window,
 * measured context, the projected estimate and the summariser's span.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-handoff-context-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { ensureCompacted, projectedContextTokens } = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
const {
	INTERRUPTED_TEXT,
	agentKindFor,
	cliContextWindowOf,
	contextBoundaryForKind,
	contextBoundaryIndex,
	newCoachCardMessage,
	newNodeHandoffMessage,
	newPlannerWakeMessage,
	newUserMessage,
	nextContextBoundaryIndex,
	toLlmMessages,
} = await import("../src/core/native-messages.ts");
import type { LhMarkerMessage, LhMessage } from "../src/core/native-messages.ts";
const {
	compactionCutIndex,
	estimateContextTokens,
	estimateTokens,
	lastAssistantUsageIndex,
	newCompactionMarker,
} = await import("../src/core/compaction.ts");
const { measuredContextTokens } = await import("../src/core/context-usage.ts");
const { newBuildReturnMessage } = await import("../src/core/build-branch.ts");
const { CLAUDE_CODE_PROVIDER } = await import("../src/core/contracts/claude-code.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

const USAGE = (input: number) => ({ input, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: input + 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function said(id: string, text: string, input = 0, provider = "openrouter"): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "text", text }],
		api: "openai-completions", provider, model: "test", usage: USAGE(input), stopReason: "stop", timestamp: 1,
	} as never;
}

function call(id: string, name: string, args: unknown, stopReason = "toolUse"): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "toolCall", id: `call_${id}`, name, arguments: args as never }],
		api: "openai-completions", provider: "openrouter", model: "test", usage: USAGE(0), stopReason, timestamp: 1,
	} as never;
}

function result(id: string, callId: string, name: string, details: unknown = { ok: true }): LhMessage {
	return { id, role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: `${name} result` }], details, isError: false, timestamp: 2 } as never;
}

function user(id: string, text: string): LhMessage {
	return { ...newUserMessage(text), id } as LhMessage;
}

function marker(m: LhMarkerMessage, id: string): LhMessage {
	return { ...m, id } as LhMessage;
}

const handoff = (id: string, nodeId: string) => marker(newNodeHandoffMessage(nodeId, `[Node handoff] ${nodeId}`), id);
const wake = (id: string) => marker(newPlannerWakeMessage(`[Planner brief] ${id}`), id);

/** goal → probe → planning: everything a fresh teacher must never see. */
const PRE: LhMessage[] = [
	user("u0", "teach me python imports"),
	call("p", "probe_done", { assessment: { strands: [{ strand: "imports", assessment: "none" }] } }),
	result("pr", "call_p", "probe_done"),
	call("plan", "plan_batch", { nodes: [] }),
	result("planr", "call_plan", "plan_batch"),
	said("a-plan", "Here is the plan.", 5_000),
];

const SYSTEM = { role: "system", content: "sys", timestamp: 0 } as unknown as LhMessage;

function texts(messages: Message[]): string[] {
	return messages.map((m) => {
		const content = (m as { content: unknown }).content;
		if (typeof content === "string") return content;
		return (content as Array<{ type: string; text?: string; name?: string }>).map((b) => b.text ?? `(${b.type} ${b.name ?? ""})`).join(" ");
	});
}

const TEACH = { boundary: "node-handoff" } as const;
const PLAN = { boundary: "planner-wake" } as const;

// ── the converter ───────────────────────────────────────────────────────────

describe("toLlmMessages: the teacher's boundary (latest node-handoff)", () => {
	it("starts at the latest handoff: its content is the first message, nothing before it renders", () => {
		const record = [
			...PRE,
			handoff("h1", "a"),
			said("t1", "Node a teaching."),
			user("u1", "ok"),
			handoff("h2", "b"),
			said("t2", "Node b teaching."),
		];
		assert.deepEqual(texts(toLlmMessages(record as never, TEACH)), ["[Node handoff] b", "Node b teaching."]);
		// The leading system message is request chrome and always carries through.
		const withSystem = toLlmMessages([SYSTEM, ...record] as never, TEACH);
		assert.deepEqual(withSystem.map((m) => m.role), ["system", "user", "assistant"]);
		assert.equal(texts(withSystem)[1], "[Node handoff] b");
	});

	it("A.4: without a node-handoff the output is byte-identical to the plain conversion", () => {
		const records: LhMessage[][] = [
			PRE,
			[SYSTEM, ...PRE, call("q", "quiz", { question: "?" })],
			[...PRE, user("u1", "x".repeat(100)), newCompactionMarker("SUM", { firstKeptMessageId: "u1", tokensBefore: 1, at: "t" }) as LhMessage, said("a2", "after")],
			[...PRE, wake("w1"), said("a3", "planner")],
		];
		for (const record of records) {
			assert.equal(JSON.stringify(toLlmMessages(record as never, TEACH)), JSON.stringify(toLlmMessages(record as never)));
		}
	});

	it("A.1: pairs inside the range stay intact, a dangling call gets the interrupted result, no orphan result renders", () => {
		const record = [
			...PRE,
			call("q0", "quiz", { question: "before?" }),
			handoff("h1", "a"),
			result("orphan", "call_q0", "quiz", { kind: "quiz" }), // its call lies before the boundary
			call("r", "research", { question: "x" }),
			result("rr", "call_r", "research"),
			call("q1", "quiz", { question: "now?" }),
		];
		const out = toLlmMessages(record as never, TEACH);
		assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "toolResult", "assistant", "toolResult"]);
		const results = out.filter((m) => m.role === "toolResult") as Array<{ toolCallId: string; content: Array<{ text: string }> }>;
		assert.deepEqual(results.map((r) => r.toolCallId), ["call_r", "call_q1"]);
		assert.equal(results[1]!.content[0]!.text, INTERRUPTED_TEXT, "the dangling call inside the range is repaired");
		const calls = new Set(out.flatMap((m) => m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => (b as { id: string }).id) : []));
		for (const r of results) assert.ok(calls.has(r.toolCallId), "every rendered result has its call in the range");
	});

	it("A.2: a compaction after the boundary applies inside the range", () => {
		const record = [
			...PRE,
			handoff("h1", "a"),
			said("t1", "early node-a teaching"),
			user("u1", "kept from here"),
			said("t2", "later teaching"),
			newCompactionMarker("NODE SUMMARY", { firstKeptMessageId: "u1", tokensBefore: 1, at: "t" }) as LhMessage,
			user("u2", "after compaction"),
		];
		const out = texts(toLlmMessages([SYSTEM, ...record] as never, TEACH));
		assert.equal(out[0], "sys");
		assert.ok(out[1]!.includes("NODE SUMMARY"), "the compaction head follows the system message");
		assert.deepEqual(out.slice(2), ["kept from here", "later teaching", "after compaction"], "the marker itself never renders as text");
	});

	it("A.2: a compaction whose kept message lies at or before the boundary is ignored", () => {
		const before = [
			...PRE,
			newCompactionMarker("PROBE SUMMARY", { firstKeptMessageId: "a-plan", tokensBefore: 1, at: "t" }) as LhMessage,
			handoff("h1", "a"),
			said("t1", "teaching"),
		];
		assert.deepEqual(texts(toLlmMessages(before as never, TEACH)), ["[Node handoff] a", "teaching"]);
		// The marker after the boundary, its kept message before it (or AT it):
		for (const kept of ["u0", "h1"]) {
			const record = [...PRE, handoff("h1", "a"), said("t1", "teaching"), newCompactionMarker("OLD SUMMARY", { firstKeptMessageId: kept, tokensBefore: 1, at: "t" }) as LhMessage, user("u2", "next")];
			assert.deepEqual(texts(toLlmMessages(record as never, TEACH)), ["[Node handoff] a", "teaching", "next"], `kept at ${kept}`);
		}
		// An unresolvable kept id under a boundary degrades to the boundary alone.
		const broken = [...PRE, handoff("h1", "a"), newCompactionMarker("LOST", { firstKeptMessageId: "gone", tokensBefore: 1, at: "t" }) as LhMessage, user("u2", "next")];
		assert.deepEqual(texts(toLlmMessages(broken as never, TEACH)), ["[Node handoff] a", "next"]);
	});

	it("A.3: later markers inside the range flatten exactly as today", () => {
		const tail: LhMessage[] = [
			handoff("h1", "a"),
			said("t1", "teaching"),
			marker({ id: "sq", role: "custom", customType: "side-question", content: "[Side question] what is a path?", display: false, details: {}, timestamp: 3 }, "sq"),
			marker({ id: "sqe", role: "custom", customType: "side-question", content: "", display: false, details: {}, timestamp: 3 }, "sqe"),
			marker(newBuildReturnMessage({ branchId: "b1", nodeId: "a", nodeTitle: "A", summary: "built it" }), "br"),
			marker(newCoachCardMessage("[Coach card] slow down", { phase: "teach", nodeId: "a", notes: ["slow down"], askLearner: null }), "cc"),
			marker({ id: "pb", role: "custom", customType: "plan-block", content: "", display: true, details: {}, timestamp: 3 }, "pb"),
			user("u1", "next"),
		];
		const record = [...PRE, ...tail];
		assert.equal(JSON.stringify(toLlmMessages(record as never, TEACH)), JSON.stringify(toLlmMessages(tail as never)));
		const rendered = texts(toLlmMessages(record as never, TEACH)).slice(2);
		assert.equal(rendered.length, 4);
		assert.equal(rendered[0], "[Side question] what is a path?");
		assert.ok(rendered[1]!.startsWith("[Build branch returned]") && rendered[1]!.endsWith("built it"));
		assert.deepEqual(rendered.slice(2), ["[Coach card] slow down", "next"]);
	});
});

describe("toLlmMessages: the planner's boundary (a planner-wake that is the latest boundary)", () => {
	it("starts at the wake when it follows the latest handoff", () => {
		const record = [...PRE, handoff("h1", "a"), said("t1", "teaching a"), user("u1", "answer"), wake("w1"), call("pb2", "plan_batch", { nodes: [] }), result("pb2r", "call_pb2", "plan_batch")];
		assert.deepEqual(texts(toLlmMessages(record as never, PLAN)), ["[Planner brief] w1", "(toolCall plan_batch)", "plan_batch result"]);
		// A second wake later: the latest one wins.
		const again = [...record, handoff("h2", "b"), said("t2", "teaching b"), wake("w2")];
		assert.deepEqual(texts(toLlmMessages(again as never, PLAN)), ["[Planner brief] w2"]);
	});

	it("A.4: the first planning (no wake, or a wake older than the latest handoff) reads the full record", () => {
		for (const record of [PRE, [...PRE, wake("w0"), handoff("h1", "a"), said("t1", "teaching")]]) {
			assert.equal(JSON.stringify(toLlmMessages(record as never, PLAN)), JSON.stringify(toLlmMessages(record as never)));
		}
	});

	it("A.1/A.2/A.3 hold the same way under the wake", () => {
		const tail: LhMessage[] = [wake("w1"), marker(newCoachCardMessage("[Coach card] note", { phase: "teach", nodeId: "a", notes: [], askLearner: null }), "cc"), call("pb2", "plan_batch", { nodes: [] })];
		const record = [...PRE, handoff("h1", "a"), call("q", "quiz", { question: "?" }), result("qr", "call_q", "quiz"), ...tail];
		assert.equal(JSON.stringify(toLlmMessages(record as never, PLAN)), JSON.stringify(toLlmMessages(tail as never)));
		const orphan = [...PRE, handoff("h1", "a"), call("q", "quiz", { question: "?" }), wake("w1"), result("qr", "call_q", "quiz")];
		assert.deepEqual(toLlmMessages(orphan as never, PLAN).map((m) => m.role), ["user"], "the result of a pre-wake call is dropped");
		const compacted = [...PRE, newCompactionMarker("PRE", { firstKeptMessageId: "a-plan", tokensBefore: 1, at: "t" }) as LhMessage, handoff("h1", "a"), wake("w1"), user("u9", "x")];
		assert.deepEqual(texts(toLlmMessages(compacted as never, PLAN)), ["[Planner brief] w1", "x"]);
	});
});

describe("the boundary helpers", () => {
	it("map kinds to boundaries and find the marker", () => {
		assert.equal(contextBoundaryForKind("teacher"), "node-handoff");
		assert.equal(contextBoundaryForKind("planner"), "planner-wake");
		for (const kind of ["prober", "practice", "build"]) assert.equal(contextBoundaryForKind(kind), undefined);
		const record = [...PRE, handoff("h1", "a"), wake("w1"), handoff("h2", "b")];
		assert.equal(contextBoundaryIndex(record, "node-handoff"), PRE.length + 2);
		assert.equal(contextBoundaryIndex(record, "planner-wake"), -1, "the wake is older than the latest handoff");
		assert.equal(contextBoundaryIndex(record.slice(0, -1), "planner-wake"), PRE.length + 1);
		assert.equal(nextContextBoundaryIndex(record), PRE.length + 2, "teacher next: its handoff");
		assert.equal(nextContextBoundaryIndex(record.slice(0, -1)), PRE.length + 1, "planner next: its wake");
		assert.equal(nextContextBoundaryIndex(PRE), -1, "first planning: no boundary");
		assert.equal(nextContextBoundaryIndex([user("u", "hi")]), -1, "prober: no boundary");
	});
});

// ── accounting ──────────────────────────────────────────────────────────────

describe("boundary-aware accounting", () => {
	it("lastAssistantUsageIndex / estimateContextTokens: the applicable boundary is a reset", () => {
		const fresh = [...PRE, handoff("h1", "a")];
		assert.equal(agentKindFor(fresh), "teacher");
		assert.equal(lastAssistantUsageIndex(PRE), PRE.length - 1, "planning usage anchors while the planner is next");
		assert.equal(lastAssistantUsageIndex(fresh), null, "the planner's usage does not describe the teacher's fresh context");
		assert.equal(estimateContextTokens(fresh).lastUsageIndex, null);
		const answered = [...fresh, said("t1", "teaching", 1_234)];
		assert.equal(lastAssistantUsageIndex(answered), answered.length - 1);
		const woken = [...answered, user("u1", "answer"), wake("w1")];
		assert.equal(lastAssistantUsageIndex(woken), null, "the planner's wake resets too");
		// A practice-like record (no boundary markers) is untouched.
		const plain = [user("u", "x"), said("a", "y", 777)];
		assert.equal(lastAssistantUsageIndex(plain), 1);
	});

	it("projectedContextTokens: the fallback estimate uses the next agent's kind-aware conversion", () => {
		const history = Array.from({ length: 8 }, (_, i) => user(`big${i}`, "x".repeat(40_000)));
		const record = [user("u0", "goal"), ...history, ...PRE.slice(1, 5), handoff("h1", "a")];
		assert.equal(lastAssistantUsageIndex(record), null);
		const projected = projectedContextTokens(record, 100);
		assert.equal(projected, estimateTokens(toLlmMessages(record as never, TEACH) as never) + 100);
		assert.ok(projected < 200, `a fresh start is small (${projected})`);
		assert.ok(estimateTokens(toLlmMessages(record as never) as never) > 50_000, "the full record would be huge");
	});

	it("compactionCutIndex never cuts before the boundary of the next agent", () => {
		const history = Array.from({ length: 6 }, (_, i) => user(`big${i}`, "x".repeat(40_000)));
		const small = [user("u0", "goal"), ...history, ...PRE.slice(1), handoff("h1", "a"), said("t1", "short")];
		const h = small.findIndex((m) => m.id === "h1");
		assert.equal(compactionCutIndex(small), h, "nothing after the fresh start to drop: the cut is the boundary");
		const bigTail = [...small, ...Array.from({ length: 6 }, (_, i) => user(`tail${i}`, "y".repeat(40_000)))];
		const cut = compactionCutIndex(bigTail);
		assert.ok(cut > h, `the cut falls inside the teacher's range (${cut} > ${h})`);
		// Planning next, no wake: the whole record is the planner's context.
		const planning = [user("u0", "goal"), ...history, ...PRE.slice(1)];
		assert.ok(compactionCutIndex(planning) < planning.length);
	});

	it("cliContextWindowOf and measuredContextTokens reset at the applicable boundary", () => {
		const cli = { ...said("cc", "claude says", 9_000, CLAUDE_CODE_PROVIDER), cliContextWindow: 200_000 } as LhMessage;
		const before = [...PRE, cli];
		assert.deepEqual(cliContextWindowOf(before), { model: `${CLAUDE_CODE_PROVIDER}:test`, tokens: 200_000 });
		assert.equal(measuredContextTokens(before), 9_100);
		const after = [...before, handoff("h1", "a")];
		assert.equal(cliContextWindowOf(after), null);
		assert.equal(measuredContextTokens(after), null);
		const answered = [...after, { ...said("t1", "teaching", 3_000, CLAUDE_CODE_PROVIDER), cliContextWindow: 180_000 } as LhMessage];
		assert.deepEqual(cliContextWindowOf(answered), { model: `${CLAUDE_CODE_PROVIDER}:test`, tokens: 180_000 });
		assert.equal(measuredContextTokens(answered), 3_100);
	});

	it("the summariser is never handed pre-boundary history, nor a summary of it", async () => {
		const chat = chatStore.createChat("boundary span");
		const record = [
			user("u0", "PROBE-GOAL"),
			user("old", `PRE-BOUNDARY ${"p".repeat(200_000)}`),
			...PRE.slice(1),
			newCompactionMarker("PRE-SUMMARY", { firstKeptMessageId: "old", tokensBefore: 1, at: "t" }) as LhMessage,
			handoff("h1", "a"),
			...Array.from({ length: 8 }, (_, i) => user(`t${i}`, `NODE-A-${i} ${"n".repeat(40_000)}`)),
		];
		chatStore.saveMessages(chat.id, record);
		let prompt = "";
		const deps: CompactionDeps = {
			chatStore,
			engine: { model: { provider: "faux", id: "test" } } as never,
			modelId: "faux:test",
			kind: "teach",
			thresholdTokens: 30_000,
			systemPromptTokens: 100,
			summarize: async (p) => {
				prompt = p;
				return { summary: "NODE SUMMARY", usage: USAGE(10) };
			},
		};
		await ensureCompacted(deps, chat.id);
		assert.ok(prompt.includes("[Node handoff] a"), "the span starts at the boundary marker");
		assert.ok(prompt.includes("NODE-A-0"));
		for (const banned of ["PROBE-GOAL", "PRE-BOUNDARY", "PRE-SUMMARY", "Here is the plan."]) assert.ok(!prompt.includes(banned), `no ${banned} in the summariser input`);
		const saved = chatStore.getChat(chat.id)!.messages;
		const compaction = saved.at(-1) as LhMarkerMessage;
		assert.equal(compaction.customType, "compaction");
		const kept = saved.findIndex((m) => m.id === (compaction.details as { firstKeptMessageId: string }).firstKeptMessageId);
		assert.ok(kept > saved.findIndex((m) => m.id === "h1"));
		const out = texts(toLlmMessages(saved as never, TEACH));
		assert.ok(out[0]!.includes("NODE SUMMARY"), "the new compaction heads the teacher's range");
		assert.ok(!out.some((t) => t.includes("PRE-SUMMARY") || t.includes("PRE-BOUNDARY")));
	});
});
