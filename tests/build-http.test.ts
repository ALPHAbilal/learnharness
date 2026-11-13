/**
 * Build-branch HTTP seam (2026-11-13): open a branch from a lesson step,
 * list it, read workspace state, save/read files (confined, locked test
 * refused, saves recorded for the coach), and closed-branch refusals.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-build-http-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");
process.env.LH_BUILD_SHELL = "bash";
process.env.LH_BUILD_PTY = "off";

const http = await import("../src/server/build-http.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { updateState, readState } = await import("../src/server/build-workspace.ts");
const { stopBranchProcesses } = await import("../src/server/build-terminal.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const req = (body?: unknown, method = "POST") =>
	new Request("http://test/x", { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function lesson() {
	const parent = chatStore.createChat("Flask lesson");
	chatStore.saveTree(parent.id, { nodes: [{ id: "http", title: "HTTP is plain text" }], edges: [], version: 1 });
	chatStore.saveSettings(parent.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(parent.id, [{ id: "u1", role: "user", content: "Explain my Flask /chat endpoint", timestamp: 0 } as never]);
	return parent;
}

describe("build branch routes", () => {
	it("opens a branch with context, folder and the lesson's model", async () => {
		const parent = lesson();
		const res = await http.createBuildBranchResponse(parent.id, req({ nodeId: "http" }));
		assert.equal(res.status, 200);
		const { id, folder } = (await res.json()) as { id: string; folder: string };
		const child = chatStore.getChat(id)!;
		assert.equal(child.kind, "build");
		assert.equal(child.title, "Build · HTTP is plain text");
		assert.equal(child.branch?.phase, "customize");
		assert.ok(fs.existsSync(folder));
		assert.deepEqual(child.settings?.model, { provider: "openrouter", id: "z-ai/glm-5.3-flash" });
		assert.equal(child.messages[0]?.role, "custom");
		assert.match(String((child.messages[0] as { content: string }).content), /Explain my Flask \/chat endpoint/);

		const listed = (await http.listBuildBranchesResponse(parent.id).json()) as { branches: Array<{ id: string; nodeId: string }> };
		assert.deepEqual(listed.branches.map((b) => [b.id, b.nodeId]), [[id, "http"]]);
	});

	it("refuses unknown steps, non-teaching parents and missing chats", async () => {
		const parent = lesson();
		assert.equal((await http.createBuildBranchResponse(parent.id, req({ nodeId: "nope" }))).status, 400);
		assert.equal((await http.createBuildBranchResponse("chat_missing", req({}))).status, 404);
		const practice = chatStore.createChat("p", "practice");
		assert.equal((await http.createBuildBranchResponse(practice.id, req({}))).status, 400);
		assert.equal(http.workspaceStateResponse(parent.id).status, 400, "a lesson is not a workspace");
	});

	it("saves and reads files, records saves, refuses the locked test and escapes", async () => {
		const parent = lesson();
		const { id } = (await (await http.createBuildBranchResponse(parent.id, req({ nodeId: "http" }))).json()) as { id: string };
		assert.equal((await http.writeFileResponse(id, req({ path: "server.py", content: "print(1)\n" }, "PUT"))).status, 200);
		const read = (await http.readFileResponse(id, new URL("http://test/x?path=server.py")).json()) as { content: string; locked: boolean };
		assert.equal(read.content, "print(1)\n");
		assert.equal(read.locked, false);
		assert.match(readState(id).events.at(-1)!.detail, /Saved server\.py/);
		assert.equal((await http.writeFileResponse(id, req({ path: "../x.py", content: "" }, "PUT"))).status, 400);
		assert.equal(http.readFileResponse(id, new URL("http://test/x?path=/etc/passwd")).status, 400);

		fs.writeFileSync(path.join(chatStore.getChat(id)!.branch!.folder, "t.sh"), "true\n");
		updateState(id, (s) => {
			s.active = { index: 0, hook: "h", concept: "c", tests: "t", testPath: "t.sh", testSha256: "x", testCommand: "bash t.sh" };
		});
		assert.equal((await http.writeFileResponse(id, req({ path: "t.sh", content: "false" }, "PUT"))).status, 400);
		const state = (await http.workspaceStateResponse(id).json()) as { active: { testPath: string }; files: Array<{ path: string }> };
		assert.equal(state.active.testPath, "t.sh");
		assert.ok(state.files.some((f) => f.path === "server.py"));
	});

	it("streams the terminal and refuses input once the branch has returned", async () => {
		const parent = lesson();
		const { id } = (await (await http.createBuildBranchResponse(parent.id, req({}))).json()) as { id: string };
		const controller = new AbortController();
		const res = http.terminalStreamResponse(id, new Request("http://test/x", { signal: controller.signal }));
		assert.equal(res.headers.get("Content-Type"), "text/event-stream");
		const reader = res.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		assert.match(first, /event: replay/);
		assert.equal((await http.terminalInputResponse(id, req({ cols: 120, rows: 40 }))).status, 200);
		controller.abort();
		await reader.cancel();

		const branch = chatStore.getChat(id)!.branch!;
		chatStore.saveBranch(id, { ...branch, phase: "returned" });
		assert.equal((await http.terminalInputResponse(id, req({ data: "ls\r" }))).status, 409);
		assert.equal((await http.writeFileResponse(id, req({ path: "a.py", content: "" }, "PUT"))).status, 409);
		assert.equal((await http.runTestsResponse(id)).status, 409);
		stopBranchProcesses(id);
	});
});
