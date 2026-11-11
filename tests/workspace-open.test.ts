import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-open-")));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { POST } = await import("../app/api/chats/[id]/workspace/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { editorCommand } = await import("../src/server/workspace.ts");

const initial = editorCommand.current;
after(() => {
	editorCommand.current = initial;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const open = (id: string) => POST(new Request(`http://test/api/chats/${id}/workspace`, { method: "POST" }), { params: Promise.resolve({ id }) });
const withFolder = () => chatStore.createChat("has folder", undefined, (id) => {
	const dir = path.join(TMP, "workspace", id);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
});

describe("POST /api/chats/:id/workspace — open the chat's folder", () => {
	it("defaults to VS Code's launcher", () => {
		assert.equal(initial, "code");
	});

	it("404s an unknown chat and a chat without a folder", async () => {
		assert.equal((await open("chat_missing")).status, 404);
		const old = chatStore.createChat("born before workspaces");
		assert.equal((await open(old.id)).status, 404);
	});

	it("reports ok with the path when the launcher starts", async () => {
		editorCommand.current = "true";
		const chat = withFolder();
		const res = await open(chat.id);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true, path: chat.workspaceDir });
	});

	it("a missing launcher answers ok:false with the folder path, not an error status", async () => {
		editorCommand.current = "lh-no-such-editor-binary";
		const chat = withFolder();
		const res = await open(chat.id);
		assert.equal(res.status, 200);
		const body = await res.json() as { ok: boolean; path: string; error: string };
		assert.equal(body.ok, false);
		assert.equal(body.path, chat.workspaceDir);
		assert.match(body.error, /lh-no-such-editor-binary/);
	});

	it("a launcher that exits with an error is reported", async () => {
		editorCommand.current = "false";
		const body = await (await open(withFolder().id)).json() as { ok: boolean; error: string };
		assert.equal(body.ok, false);
		assert.match(body.error, /exited with code 1/);
	});

	it("recreates a folder the learner deleted", async () => {
		editorCommand.current = "true";
		const chat = withFolder();
		fs.rmSync(chat.workspaceDir!, { recursive: true });
		assert.equal(((await (await open(chat.id)).json()) as { ok: boolean }).ok, true);
		assert.equal(fs.existsSync(chat.workspaceDir!), true);
	});
});
