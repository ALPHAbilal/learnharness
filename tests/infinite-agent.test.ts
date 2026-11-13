/**
 * THE INFINITE AGENT and the workspace wiring: Infinite composes its own
 * prompt directory (no teaching base) over the practice registry; a chat
 * with a folder gives every conversation agent (prober, teacher,
 * practice, infinite) run_command + write_file and the folder's
 * instruction block; a chat without one gets neither. Every tool of a real
 * conversation is wrapped by the tool log.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-infinite-agent-")));
process.env.LH_DATA_DIR = path.join(TMP, "data");
const DIR = path.join(TMP, "workspace", "chat");
fs.mkdirSync(DIR, { recursive: true });

const { composeInstructions, createInfiniteAgent, createPracticeAgent, createProberAgent, createTeacherAgent, CONVERSATION_TOOL_NAMES } = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths, effectivePromptSegments } = await import("../src/agent/prompt-segments.ts");
const { isValidSegmentPath } = await import("../src/core/prompt-segments.ts");
const { toolLogFile } = await import("../src/agent/tool-log.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const engine = {
	model: { api: "faux", provider: "faux", id: "faux-model", contextWindow: 8192, input: ["text"] } as never,
	streamFn: (async () => { throw new Error("not streamed in this test"); }) as never,
};
const store = { getChat: () => ({ messages: [], kind: "infinite" }) };
const practiceCtx = { chatId: "chat_inf", chatStore: store };
const toolNames = (agent: { state: { tools: Array<{ name: string }> } }) => agent.state.tools.map((tool) => tool.name).sort();

describe("Infinite prompt composition", () => {
	it("composes its own directory plus the practice shared appendix, never the teaching base", () => {
		const paths = effectivePromptSegments("infinite", {}).map((segment) => segment.path);
		assert.deepEqual(paths.slice(0, 2), ["infinite/00-base.md", "infinite/10-doctrine.md"]);
		assert.ok(!paths.includes("system-prompt.md"));
		assert.deepEqual(paths.slice(2), effectivePromptSegments("practice", {}).map((s) => s.path).filter((p) => p.startsWith("shared/")));
		const text = composeInstructions("infinite");
		assert.match(text, /running an \*\*Infinite\*\* session/);
		assert.match(text, /# The Infinite session/);
		assert.match(text, /The target governs everything/);
		assert.doesNotMatch(text, /Your job is to install understanding and knowledge/);
	});

	it("its segments are valid, listed override paths", () => {
		for (const segment of ["infinite/00-base.md", "infinite/10-doctrine.md"]) {
			assert.equal(isValidSegmentPath(segment), true);
			assert.ok(allSegmentPaths().includes(segment));
		}
	});

	it("an enabled override replaces an Infinite segment", () => {
		assert.equal(composeInstructions("infinite", { "infinite/10-doctrine.md": true }), composeInstructions("infinite"), "no file, no override");
	});

	it("names only tools the Infinite agent really has", () => {
		const text = composeInstructions("infinite");
		for (const tool of ["problem", "conclude", "run_command", "write_file", "read", "grep"]) assert.ok(text.includes(`\`${tool}\``), tool);
		for (const absent of ["`quiz`", "`explain`", "`plan_init`", "`probe_done`"]) assert.ok(!text.includes(absent), absent);
	});

	it("practice composition is untouched by the new directory", () => {
		assert.ok(!composeInstructions("practice").includes("Infinite"));
	});
});

describe("the teacher's build-course fragment", () => {
	it("composes into the teacher only", () => {
		assert.match(composeInstructions("teacher"), /# Build courses — programming is learned by building/);
		assert.doesNotMatch(composeInstructions("prober"), /Build courses/);
		assert.doesNotMatch(composeInstructions("practice"), /Build courses/);
	});
});

describe("workspace wiring", () => {
	it("an Infinite agent with a folder has the practice registry plus the workspace tools and the folder in its prompt", () => {
		const agent = createInfiniteAgent(practiceCtx, { engine, chatId: "chat_inf", workspaceDir: DIR });
		assert.deepEqual(toolNames(agent), ["conclude", "find", "grep", "ls", "problem", "read", "run_command", "write_file"]);
		assert.ok(agent.state.systemPrompt.includes(DIR));
		assert.match(agent.state.systemPrompt, /# This chat's folder/);
		assert.match(agent.state.systemPrompt, /# The Infinite session/);
	});

	it("a practice agent gains the tools with a folder and has neither without one", () => {
		const withFolder = createPracticeAgent(practiceCtx, { engine, chatId: "chat_p", workspaceDir: DIR });
		assert.ok(toolNames(withFolder).includes("run_command"));
		const without = createPracticeAgent(practiceCtx, { engine, chatId: "chat_old" });
		assert.deepEqual(toolNames(without), ["conclude", "find", "grep", "ls", "problem", "read"]);
		assert.doesNotMatch(without.state.systemPrompt, /^# This chat's folder/m);
	});

	it("the teacher and the prober gain them", () => {
		const chatStore = { getChat: () => ({ messages: [], tree: undefined }) } as never;
		const jobStore = {} as never;
		const teacher = createTeacherAgent({ chatId: "chat_t", chatStore, jobStore, spawn: () => {}, searchAvailable: () => false }, { engine, chatId: "chat_t", workspaceDir: DIR });
		assert.ok(toolNames(teacher).includes("run_command") && toolNames(teacher).includes("write_file"));
		assert.match(teacher.state.systemPrompt, /^# This chat's folder/m);
		const prober = createProberAgent({ chatId: "chat_t", chatStore, jobStore, spawn: () => {}, searchAvailable: () => false, deliver: () => {} }, { engine, chatId: "chat_t", workspaceDir: DIR });
		assert.ok(toolNames(prober).includes("run_command") && toolNames(prober).includes("write_file"));
		assert.match(prober.state.systemPrompt, /^# This chat's folder/m);
		assert.match(prober.state.systemPrompt, /## 5\. One small write — in his folder/);
	});

	it("a caller-owned test registry is left exactly as handed in", () => {
		const agent = createInfiniteAgent(practiceCtx, { engine, chatId: "chat_x", workspaceDir: DIR, tools: {} });
		assert.deepEqual(toolNames(agent), []);
		assert.doesNotMatch(agent.state.systemPrompt, /^# This chat's folder/m);
	});

	it("the workspace tool names are reserved conversation builtins", () => {
		assert.ok((CONVERSATION_TOOL_NAMES as readonly string[]).includes("run_command"));
		assert.ok((CONVERSATION_TOOL_NAMES as readonly string[]).includes("write_file"));
	});

	it("a real conversation's tool calls land in the chat's tool log", async () => {
		const agent = createInfiniteAgent(practiceCtx, { engine, chatId: "chat_logged", workspaceDir: DIR });
		const run = agent.state.tools.find((tool) => tool.name === "run_command")!;
		await run.execute("call_1", { command: "echo logged" } as never);
		const [line] = fs.readFileSync(toolLogFile("chat_logged"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		assert.equal(line!.agent, "infinite");
		assert.equal(line!.tool, "run_command");
		assert.deepEqual(line!.args, { command: "echo logged" });
		assert.match(line!.result as string, /logged/);
	});
});
