/**
 * WORKSPACES at chat birth: POST /api/chats refuses until the learner has
 * chosen a workspace folder, then gives every new chat its own folder
 * under it and stamps the path on the record. Drives the real route under
 * an isolated LH_DATA_DIR (the birth-stamp discipline: the seam is set
 * before any config-loading import).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-workspace-")));
const DATA = path.join(TMP, "data");
const WORKSPACE = path.join(TMP, "my code");
process.env.LH_DATA_DIR = DATA;
delete process.env.LH_WORKSPACE_DIR;

const { POST } = await import("../app/api/chats/route.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { fileAccessPolicy } = await import("../src/server/file-access.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
	delete process.env.LH_WORKSPACE_DIR;
	writeSettings({ version: 1 });
});

function post(body: Record<string, unknown>): Promise<Response> {
	return POST(new Request("http://test/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}));
}

describe("POST /api/chats — the chat's folder", () => {
	it("refuses with workspace_not_configured and creates nothing while no folder is chosen", async () => {
		const before = chatStore.listChats().length;
		const res = await post({ title: "build a shell" });
		assert.equal(res.status, 409);
		const body = await res.json() as { code?: string; error?: string };
		assert.equal(body.code, "workspace_not_configured");
		assert.match(body.error ?? "", /workspace folder/i);
		assert.equal(chatStore.listChats().length, before);
	});

	it("creates the chat's folder under the chosen workspace and stamps it on the record", async () => {
		writeSettings({ version: 1, agent: { workspace: { path: WORKSPACE } } });
		const res = await post({ title: "Build your own Shell!" });
		assert.equal(res.status, 200);
		const { id } = await res.json() as { id: string };
		const record = chatStore.getChat(id)!;
		assert.ok(record.workspaceDir, "the record carries its folder");
		assert.equal(path.dirname(record.workspaceDir!), WORKSPACE);
		assert.match(path.basename(record.workspaceDir!), /^build-your-own-shell-[a-z0-9]+$/);
		assert.equal(fs.statSync(record.workspaceDir!).isDirectory(), true);
	});

	it("two chats with the same title get different folders", async () => {
		writeSettings({ version: 1, agent: { workspace: { path: WORKSPACE } } });
		const a = await (await post({ title: "same" })).json() as { id: string };
		const b = await (await post({ title: "same" })).json() as { id: string };
		assert.notEqual(chatStore.getChat(a.id)!.workspaceDir, chatStore.getChat(b.id)!.workspaceDir);
	});

	it("kind infinite lands on the record; unknown kinds read as teach", async () => {
		writeSettings({ version: 1, agent: { workspace: { path: WORKSPACE } } });
		const inf = await (await post({ title: "pointers", kind: "infinite" })).json() as { id: string };
		assert.equal(chatStore.getChat(inf.id)!.kind, "infinite");
		const odd = await (await post({ title: "pointers", kind: "bogus" })).json() as { id: string };
		assert.equal(chatStore.getChat(odd.id)!.kind, undefined);
	});

	it("a workspace path that is a file fails readably and leaves no chat behind", async () => {
		const file = path.join(TMP, "not-a-folder");
		fs.writeFileSync(file, "x");
		writeSettings({ version: 1, agent: { workspace: { path: file } } });
		const before = chatStore.listChats().length;
		const res = await post({ title: "nope" });
		assert.equal(res.status, 500);
		assert.match(((await res.json()) as { error: string }).error, /Could not create the chat's folder/);
		assert.equal(chatStore.listChats().length, before);
	});

	it("LH_WORKSPACE_DIR overrides the setting", async () => {
		const override = path.join(TMP, "from-env");
		process.env.LH_WORKSPACE_DIR = override;
		const { id } = await (await post({ title: "env" })).json() as { id: string };
		assert.equal(path.dirname(chatStore.getChat(id)!.workspaceDir!), override);
	});

	it("a restricted file-access policy still includes the workspace folder", () => {
		writeSettings({ version: 1, agent: { workspace: { path: WORKSPACE }, fileAccess: { restricted: true, folders: [] } } });
		assert.deepEqual(fileAccessPolicy().folders, [WORKSPACE]);
		writeSettings({ version: 1, agent: { workspace: { path: WORKSPACE } } });
		assert.deepEqual(fileAccessPolicy().folders, []);
	});
});
