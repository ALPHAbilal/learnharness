/**
 * Build branches (2026-11-13): the pure helpers (command guard, parent
 * context, markers), the workspace (confinement incl. symlinks, locked test
 * file, state round-trip, stage test runs), the store seam (branch link,
 * queued returns) and the terminal service on the pipe fallback.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-build-branch-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_BUILD_SHELL = "bash";

const core = await import("../src/core/build-branch.ts");
const workspace = await import("../src/server/build-workspace.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { BuildTerminal } = await import("../src/server/build-terminal.ts");
import type { LhMessage } from "../src/core/native-messages.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const hasBash = (() => {
	try {
		return fs.existsSync("/bin/bash") || fs.existsSync("/usr/bin/bash");
	} catch {
		return false;
	}
})();

describe("command guard", () => {
	it("flags commands that name places outside the folder", () => {
		assert.equal(core.commandEscape("cat /etc/passwd"), "/etc/passwd");
		assert.equal(core.commandEscape("cd .."), "..");
		assert.equal(core.commandEscape("rm -rf ~"), "~");
		assert.equal(core.commandEscape("ls ../other"), "../other");
		assert.equal(core.commandEscape("type C:\\Windows\\win.ini"), "C:\\Windows\\win.ini");
		assert.equal(core.commandEscape("python3 x.py --out=/tmp/y"), "/tmp/y");
		assert.equal(core.commandEscape("cd"), "cd");
		assert.equal(core.commandEscape("echo hi; cd"), "cd");
		assert.equal(core.commandEscape('cat "$HOME/.ssh/id_rsa"'), "$HOME/.ssh/id_rsa");
	});
	it("allows commands confined to the folder", () => {
		assert.equal(core.commandEscape("python3 server.py"), null);
		assert.equal(core.commandEscape("curl -i -X POST http://localhost:5000/chat -d '{\"a\":1}'"), null);
		assert.equal(core.commandEscape("python3 -m pytest -q tests/test_stage1.py 2>/dev/null"), null);
		assert.equal(core.commandEscape("mkdir -p src && cd src && ls"), null);
	});
});

describe("absolute/home detection", () => {
	it("rejects absolute and home paths", () => {
		for (const p of ["/etc/passwd", "C:\\x", "c:/x", "\\\\server\\share", "~/.ssh", "$HOME/x"]) assert.equal(core.isAbsoluteOrHome(p), true, p);
		for (const p of ["a/b.py", "server.py", "./x"]) assert.equal(core.isAbsoluteOrHome(p), false, p);
	});
});

function assistant(id: string, content: unknown[]): LhMessage {
	return { id, role: "assistant", content, api: "x", provider: "x", model: "x", usage: {}, stopReason: "toolUse", timestamp: 0 } as unknown as LhMessage;
}

const parentMessages: LhMessage[] = [
	{ id: "u1", role: "user", content: "Explain my Flask /chat endpoint end to end", timestamp: 0 } as LhMessage,
	assistant("a1", [{ type: "toolCall", id: "t1", name: "probe_done", arguments: { assessment: { strands: [{ strand: "HTTP anatomy", assessment: "knows JSON, not headers" }], summary: "start at HTTP" } } }]),
	assistant("a2", [{ type: "text", text: "HTTP is plain text." }, { type: "toolCall", id: "t2", name: "quiz", arguments: { nodeId: "http", question: "Where does the JSON go?", options: [{ label: "body" }, { label: "header" }] } }]),
	assistant("a3", [{ type: "text", text: "Now WSGI." }, { type: "toolCall", id: "t3", name: "explain", arguments: { nodeId: "wsgi", prompt: "Who parses bytes?" } }]),
];

describe("parent context", () => {
	it("carries goal, assessment, plan and lesson text up to the node", () => {
		const { text, nodeTitle } = core.buildContextText({
			title: "101",
			messages: parentMessages,
			tree: { nodes: [{ id: "http", title: "HTTP is plain text" }, { id: "wsgi", title: "WSGI chain" }], edges: [], version: 1 },
		}, "http");
		assert.equal(nodeTitle, "HTTP is plain text");
		assert.match(text, /Explain my Flask \/chat endpoint/);
		assert.match(text, /HTTP anatomy: knows JSON, not headers/);
		assert.match(text, /Summary: start at HTTP/);
		assert.match(text, /- http: HTTP is plain text/);
		assert.match(text, /Where does the JSON go\?/);
		assert.match(text, /options: body \| header/);
		assert.doesNotMatch(text, /Now WSGI/, "lesson text stops at the branched step");
	});
	it("finds the node a message belongs to", () => {
		assert.equal(core.nodeAtMessage(parentMessages, "a1"), null);
		assert.equal(core.nodeAtMessage(parentMessages, "a2"), "http");
		assert.equal(core.nodeAtMessage(parentMessages, "a3"), "wsgi");
	});
	it("builds a return marker that tells the teacher how to use it", () => {
		const marker = core.newBuildReturnMessage({ branchId: "b", nodeId: "http", nodeTitle: "HTTP is plain text", summary: "solid: status codes" });
		assert.equal(marker.customType, "build-return");
		assert.match(marker.content, /do not re-teach/);
		assert.match(marker.content, /solid: status codes/);
	});
	it("strips ANSI and carriage-return overwrites", () => {
		assert.equal(core.stripAnsi("\u001b[31mred\u001b[0m\r\nok\rdone\n"), "red\ndone\n");
	});
});

describe("workspace", () => {
	const folder = workspace.allocateFolder("chat_parent", "http");
	it("allocates distinct folders per branch", () => {
		const second = workspace.allocateFolder("chat_parent", "http");
		assert.notEqual(second, folder);
		assert.match(path.basename(folder), /^chat-parent-http-1$/);
		assert.match(path.basename(second), /^chat-parent-http-2$/);
	});
	it("confines paths, including through symlinks", () => {
		assert.throws(() => workspace.resolveInside(folder, "../x"), workspace.WorkspaceError);
		assert.throws(() => workspace.resolveInside(folder, "/etc/passwd"), workspace.WorkspaceError);
		assert.throws(() => workspace.resolveInside(folder, ""), workspace.WorkspaceError);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lh-outside-"));
		fs.symlinkSync(outside, path.join(folder, "link"));
		assert.throws(() => workspace.resolveInside(folder, "link/new.txt"), /symlink/);
		fs.rmSync(outside, { recursive: true, force: true });
		assert.equal(workspace.resolveInside(folder, "src/app.py"), path.join(folder, "src", "app.py"));
	});
	it("writes, reads and lists files; refuses the locked test", () => {
		const state = core.emptyBuildState();
		workspace.writeWorkspaceFile(folder, state, "src/app.py", "print('hi')\n");
		assert.equal(workspace.readWorkspaceFile(folder, "src/app.py"), "print('hi')\n");
		const sha = workspace.writeTestFile(folder, "tests/test_1.py", "assert True\n");
		state.active = { index: 0, hook: "h", concept: "c", tests: "t", testPath: "tests/test_1.py", testSha256: sha, testCommand: "true" };
		assert.throws(() => workspace.writeWorkspaceFile(folder, state, "tests/../tests/test_1.py", "x"), /locked test/);
		const listed = workspace.listFiles(folder).entries.map((e) => e.path);
		assert.ok(listed.includes("src/app.py") && listed.includes("tests/test_1.py"));
	});
	it("round-trips stage state", () => {
		workspace.updateState("chat_branch_a", (s) => {
			s.plan = [{ title: "Bytes", goal: "print raw bytes" }];
		});
		assert.deepEqual(workspace.readState("chat_branch_a").plan, [{ title: "Bytes", goal: "print raw bytes" }]);
		assert.deepEqual(workspace.readState("chat_missing").plan, []);
	});
	it("runs stage tests and detects a tampered test file", { skip: !hasBash }, async () => {
		const f = workspace.allocateFolder("chat_tests", null);
		const sha = workspace.writeTestFile(f, "check.sh", "test -f answer.txt\n");
		workspace.updateState("chat_branch_t", (s) => {
			s.active = { index: 0, hook: "h", concept: "c", tests: "t", testPath: "check.sh", testSha256: sha, testCommand: "bash check.sh" };
		});
		let run = await workspace.runStageTests("chat_branch_t", f, "you");
		assert.equal(run.passed, false);
		fs.writeFileSync(path.join(f, "answer.txt"), "42");
		run = await workspace.runStageTests("chat_branch_t", f, "you");
		assert.equal(run.passed, true);
		fs.writeFileSync(path.join(f, "check.sh"), "true\n");
		run = await workspace.runStageTests("chat_branch_t", f, "ai");
		assert.equal(run.passed, false);
		assert.match(run.output, /was changed after the stage started/);
		const state = workspace.readState("chat_branch_t");
		assert.equal(state.runs.length, 3);
		assert.equal(state.events.filter((e) => e.kind === "test-run").length, 3);
	});
});

describe("store seam", () => {
	it("creates a build chat with its branch link and queues returns on the parent", () => {
		const parent = chatStore.createChat("parent");
		const branch = { parentChatId: parent.id, parentNodeId: "http", parentNodeTitle: "HTTP", folder: "/x", phase: "customize" as const };
		const child = chatStore.createChat("child", "build", branch);
		assert.equal(chatStore.getChat(child.id)?.kind, "build");
		assert.deepEqual(chatStore.getChat(child.id)?.branch, branch);
		chatStore.saveBranch(child.id, { ...branch, phase: "returned" });
		assert.equal(chatStore.getChat(child.id)?.branch?.phase, "returned");
		const entry = { id: "r1", branchId: child.id, nodeId: "http", nodeTitle: "HTTP", summary: "s", createdAt: "now", delivered: false };
		assert.equal(chatStore.queueBuildReturn(parent.id, entry), true);
		assert.equal(chatStore.queueBuildReturn(parent.id, entry), true, "idempotent");
		assert.equal(chatStore.getChat(parent.id)?.buildReturns?.length, 1);
		chatStore.markBuildReturnsDelivered(parent.id, ["r1"]);
		assert.equal(chatStore.getChat(parent.id)?.buildReturns?.[0]?.delivered, true);
		assert.equal(chatStore.queueBuildReturn("chat_gone", entry), false);
		const listed = chatStore.listChats().find((c) => c.id === parent.id) as Record<string, unknown> | undefined;
		assert.ok(listed && !("buildReturns" in listed), "list payload omits queued returns");
	});
});

describe("terminal", { skip: !hasBash }, () => {
	process.env.LH_BUILD_PTY = "off";
	it("runs coach commands with exit codes and attributes learner input", async () => {
		const folder = workspace.allocateFolder("chat_term", null);
		const terminal = new BuildTerminal(folder);
		const seen: string[] = [];
		const { unsubscribe } = terminal.subscribe((c) => seen.push(c.text));
		const ok = await terminal.runAiCommand("echo built-by-ai");
		assert.equal(ok.exitCode, 0);
		assert.equal(ok.running, false);
		assert.match(ok.output, /built-by-ai/);
		const failed = await terminal.runAiCommand("exit 3");
		assert.equal(failed.exitCode, 3);
		terminal.write("echo typed-by-you\r");
		await new Promise((r) => setTimeout(r, 400));
		const transcript = terminal.transcript(0);
		assert.match(transcript, /AI › echo built-by-ai/);
		assert.match(transcript, /\[YOU typed\] \$ echo typed-by-you/);
		assert.ok(seen.join("").includes("built-by-ai"));
		unsubscribe();
		terminal.stop(true);
	});
	it("returns 'still running' for servers and stops them on demand", async () => {
		const folder = workspace.allocateFolder("chat_term", null);
		const terminal = new BuildTerminal(folder);
		const result = await terminal.runAiCommand("echo started; sleep 30", 500);
		assert.equal(result.running, true);
		assert.match(result.output, /started/);
		assert.equal(terminal.runningAiProcesses, 1);
		terminal.stop(true);
		assert.equal(terminal.runningAiProcesses, 0);
	});
	it("rejects nonsense resize values", () => {
		const terminal = new BuildTerminal(TMP_DATA);
		terminal.resize(-1, 5000);
		terminal.resize(80.5, 24);
		terminal.stop(true);
	});
});
