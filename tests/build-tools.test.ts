/**
 * The build coach's tools (build branches, 2026-11-13): plan → stage gates,
 * the locked test file, the command guard, confinement, and the return to
 * the parent lesson — over the real workspace module in a temp data root.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-build-tools-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_BUILD_SHELL = "bash";

const { chatStore } = await import("../src/store/chats.ts");
const { buildTools } = await import("../src/agent/tools/build.ts");
const { buildWorkspacePort, allocateFolder } = await import("../src/server/build-workspace.ts");
const { composeInstructions, createBuildAgent } = await import("../src/agent/teacher-agent.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const hasBash = fs.existsSync("/bin/bash") || fs.existsSync("/usr/bin/bash");

function setup() {
	const parent = chatStore.createChat("Flask lesson");
	const folder = allocateFolder(parent.id, "http");
	const child = chatStore.createChat("Build: HTTP", "build", {
		parentChatId: parent.id, parentNodeId: "http", parentNodeTitle: "HTTP is plain text", folder, phase: "customize",
	});
	const commands: string[] = [];
	let stopped = 0;
	const tools = buildTools({
		chatId: child.id,
		chatStore,
		workspace: buildWorkspacePort(),
		terminal: () => ({
			runAiCommand: async (command: string) => {
				commands.push(command);
				return { output: `ran ${command}`, exitCode: 0, running: false };
			},
			transcript: () => "[YOU typed] $ ls",
		}),
		stopProcesses: () => {
			stopped++;
		},
	});
	const call = async (name: string, args: Record<string, unknown>) => {
		const tool = tools[name]!;
		const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
		const result = await tool.execute(`call_${name}`, prepared as never);
		return result.details as Record<string, unknown>;
	};
	return { parent, child, folder, call, commands, stopped: () => stopped };
}

const stage1 = {
	stage: 1,
	hook: "Print the raw request",
	concept: "A request is text",
	tests: "Sends GET / and expects the server to print it",
	starterFiles: [{ path: "server.py", content: "# your code here\n" }],
	testFile: { path: "tests/test_stage_1.sh", content: "test -f server.py\n" },
	testCommand: "bash tests/test_stage_1.sh",
};

describe("build coach tools", () => {
	it("refuses a stage before a plan, then poses and locks it", async () => {
		const t = setup();
		assert.equal((await t.call("stage_start", stage1)).ok, false);
		assert.equal((await t.call("build_plan", { stages: [{ title: "Bytes", goal: "print raw bytes" }, { title: "Flask", goal: "map to Flask" }] })).ok, true);
		const posed = await t.call("stage_start", stage1);
		assert.equal(posed.ok, true);
		assert.deepEqual(posed.starterFilesWritten, ["server.py"]);
		assert.equal(chatStore.getChat(t.child.id)?.branch?.phase, "build", "first stage moves customize → build");
		const again = await t.call("stage_start", { ...stage1, stage: 2 });
		assert.equal(again.ok, false);
		assert.match(String(again.error), /still active/);
		const locked = await t.call("file_write", { path: "tests/test_stage_1.sh", content: "true\n" });
		assert.equal(locked.ok, false);
		assert.match(String(locked.error), /locked test/);
		const listed = await t.call("file_list", {});
		assert.ok((listed.files as string[]).some((f) => f.includes("[locked test]")));
	});

	it("never overwrites the learner's existing files with starter files", async () => {
		const t = setup();
		await t.call("build_plan", { stages: [{ title: "A", goal: "a" }, { title: "B", goal: "b" }] });
		await t.call("stage_start", stage1);
		fs.writeFileSync(path.join(t.folder, "server.py"), "learner work\n");
		await t.call("stage_complete", { outcome: "passed", evidence: "explained it" });
		const posed = await t.call("stage_start", { ...stage1, stage: 2, testFile: { path: "tests/test_stage_2.sh", content: "true\n" } });
		assert.deepEqual(posed.starterFilesKeptExisting, ["server.py"]);
		assert.equal(fs.readFileSync(path.join(t.folder, "server.py"), "utf-8"), "learner work\n");
	});

	it("runs and completes stages with outcomes", { skip: !hasBash }, async () => {
		const t = setup();
		await t.call("build_plan", { stages: [{ title: "A", goal: "a" }] });
		await t.call("stage_start", stage1);
		const run = await t.call("run_tests", {});
		assert.equal(run.passed, true);
		const done = await t.call("stage_complete", { outcome: "passed-shaky", evidence: "could not say which line" });
		assert.equal(done.ok, true);
		assert.equal(done.stagesRemaining, 0);
		assert.equal((await t.call("stage_complete", { outcome: "passed", evidence: "x" })).ok, false, "nothing active");
	});

	it("guards commands and paths", async () => {
		const t = setup();
		const escaped = await t.call("terminal_run", { command: "cat /etc/passwd" });
		assert.equal(escaped.ok, false);
		assert.equal(t.commands.length, 0, "a refused command never runs");
		const ran = await t.call("terminal_run", { command: "python3 --version" });
		assert.equal(ran.ok, true);
		assert.deepEqual(t.commands, ["python3 --version"]);
		assert.equal((await t.call("file_write", { path: "../outside.txt", content: "x" })).ok, false);
		assert.equal((await t.call("file_read", { path: "/etc/hostname" })).ok, false);
		await t.call("build_plan", { stages: [{ title: "A", goal: "a" }] });
		assert.equal((await t.call("stage_start", { ...stage1, testCommand: "bash ../x.sh" })).ok, false);
		assert.equal((await t.call("terminal_read", {})).transcript, "[YOU typed] $ ls");
	});

	it("returns to the lesson once, queuing the summary on the parent", async () => {
		const t = setup();
		const returned = await t.call("return_to_lesson", { summary: "solid: status codes (stage 2 run passed)" });
		assert.equal(returned.ok, true);
		assert.equal(t.stopped(), 1);
		const parent = chatStore.getChat(t.parent.id)!;
		assert.equal(parent.buildReturns?.length, 1);
		assert.equal(parent.buildReturns?.[0]?.nodeId, "http");
		assert.equal(parent.buildReturns?.[0]?.delivered, false);
		assert.equal(chatStore.getChat(t.child.id)?.branch?.phase, "returned");
		assert.equal((await t.call("return_to_lesson", { summary: "again" })).ok, false);
		assert.equal((await t.call("terminal_run", { command: "ls" })).ok, false, "a returned branch is closed");
	});
});

describe("build coach agent", () => {
	it("composes its own base and doctrine with the curated shared appendix", () => {
		const prompt = composeInstructions("build");
		assert.match(prompt, /# The build coach/);
		assert.match(prompt, /# The method/);
		assert.doesNotMatch(prompt, /\b\d+\s*(?:minutes|hours)\b/i, "no time estimates");
		assert.ok(!prompt.includes("20-question-tools"), "no question mechanics");
	});
	it("builds with the workspace tool registry", () => {
		const t = setup();
		const agent = createBuildAgent({
			chatId: t.child.id, chatStore, workspace: buildWorkspacePort(),
			terminal: () => ({ runAiCommand: async () => ({ output: "", exitCode: 0, running: false }), transcript: () => "" }),
		}, { engine: { model: { provider: "faux", id: "faux", api: "faux" }, level: "off", streamFn: (() => { throw new Error("unused"); }) } as never });
		const names = agent.state.tools.map((tool) => tool.name).sort();
		for (const name of ["build_plan", "stage_start", "run_tests", "stage_complete", "terminal_run", "terminal_read", "file_list", "file_read", "file_write", "return_to_lesson", "read"]) {
			assert.ok(names.includes(name), name);
		}
		assert.ok(!names.includes("quiz") && !names.includes("problem"));
	});
});
