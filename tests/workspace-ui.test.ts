/**
 * The interface seams for workspaces and Infinite sessions, as pure
 * functions: the start refusal's wording, the session-creation body, the
 * settings composers, and the open-folder call.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { WORKSPACE_NOT_CONFIGURED_MESSAGE } from "../src/core/workspace.ts";
import { OPENING_PROMPT_FAILURE } from "../components/opening-prompt.ts";
import { SessionStarter, startFailureMessage } from "../components/start-session.ts";
import { startDraftSession } from "../components/new-session.tsx";
import { composeWorkspacePath, sectionedSegments } from "../components/settings/agent-section.tsx";
import { openWorkspace } from "../components/workspace-chip.tsx";

const store = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
Object.defineProperty(globalThis, "sessionStorage", {
	configurable: true,
	value: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => { store.set(key, value); },
		removeItem: (key: string) => { store.delete(key); },
	},
});
after(() => {
	if (original) Object.defineProperty(globalThis, "sessionStorage", original);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
});

const replying = (status: number, body: unknown) => {
	const bodies: unknown[] = [];
	const fetchLike = (async (_url: string, init?: RequestInit) => {
		bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
	return { bodies, fetchLike };
};

describe("starting a session without a workspace folder", () => {
	it("the workspace refusal surfaces its own message", async () => {
		const { fetchLike } = replying(409, { code: "workspace_not_configured", error: "x" });
		const error = await new SessionStarter().start({ title: "hi" }, fetchLike).then(() => null, (e: unknown) => e);
		assert.equal((error as Error).message, WORKSPACE_NOT_CONFIGURED_MESSAGE);
		assert.equal(startFailureMessage(error), WORKSPACE_NOT_CONFIGURED_MESSAGE);
	});

	it("any other failure keeps the generic message", async () => {
		for (const { fetchLike } of [replying(500, { error: "boom" }), replying(409, { code: "something_else" }), replying(409, "not json object")]) {
			const error = await new SessionStarter().start({ title: "hi" }, fetchLike).then(() => null, (e: unknown) => e);
			assert.equal(startFailureMessage(error), OPENING_PROMPT_FAILURE);
		}
		assert.equal(startFailureMessage("not an error"), OPENING_PROMPT_FAILURE);
	});
});

describe("the session-creation body", () => {
	it("infinite sends kind infinite; teach sends no kind; practice is unchanged", async () => {
		const infinite = replying(200, { id: "chat_1" });
		assert.equal(await startDraftSession("get good at go", infinite.fetchLike, "infinite"), "/chat/chat_1");
		assert.deepEqual(infinite.bodies, [{ title: "get good at go", kind: "infinite" }]);
		const teach = replying(200, { id: "chat_2" });
		await startDraftSession("teach me", teach.fetchLike);
		assert.deepEqual(teach.bodies, [{ title: "teach me" }]);
		const practice = replying(200, { id: "chat_3" });
		await startDraftSession("drill", practice.fetchLike, "practice");
		assert.deepEqual(practice.bodies, [{ title: "drill", kind: "practice" }]);
	});
});

describe("settings composers", () => {
	it("composeWorkspacePath stores a trimmed valid path and keeps the rest of the section", () => {
		assert.deepEqual(composeWorkspacePath({ tools: { demo: false } }, "  ~/code  "), { tools: { demo: false }, workspace: { path: "~/code" } });
	});
	it("an empty entry clears the choice; an invalid one changes nothing", () => {
		assert.deepEqual(composeWorkspacePath({ workspace: { path: "/a" } }, " "), { workspace: {} });
		assert.deepEqual(composeWorkspacePath({ workspace: { path: "/a" } }, "relative"), { workspace: { path: "/a" } });
	});
	it("the prompt view lists Infinite between Practice and Shared when the server sends it", () => {
		const seg = (path: string, shared = false) => ({ path, sourceText: "", overrideText: null, enabled: false, shared });
		const view = {
			teacher: [seg("teacher/20-teaching.md"), seg("shared/10-voice.md", true)],
			prober: [seg("prober/10-probe-doctrine.md")],
			practice: [seg("practice/00-base.md"), seg("shared/10-voice.md", true)],
			infinite: [seg("infinite/00-base.md"), seg("shared/10-voice.md", true)],
		};
		const sections = sectionedSegments(view);
		assert.deepEqual(sections.map((s) => s.id), ["teacher", "prober", "practice", "infinite", "shared"]);
		assert.deepEqual(sections[3]!.segments.map((s) => s.path), ["infinite/00-base.md"]);
		assert.equal(sections[4]!.segments[0]!.usageHint, "Used by Teacher, Practice and Infinite");
		const { infinite: _dropped, ...older } = view;
		assert.deepEqual(sectionedSegments(older).map((s) => s.id), ["teacher", "prober", "practice", "shared"]);
	});
});

describe("openWorkspace", () => {
	it("resolves null when the editor started", async () => {
		const { fetchLike } = replying(200, { ok: true, path: "/w/chat" });
		assert.equal(await openWorkspace("chat_1", "/w/chat", fetchLike), null);
	});
	it("returns the folder path and reason when it did not", async () => {
		const { fetchLike } = replying(200, { ok: false, path: "/w/chat", error: 'Could not start "code"' });
		assert.deepEqual(await openWorkspace("chat_1", "/fallback", fetchLike), { path: "/w/chat", reason: 'Could not start "code"' });
	});
	it("falls back to the known path on a server error or a network failure", async () => {
		const { fetchLike } = replying(404, { error: "This chat has no folder" });
		assert.deepEqual(await openWorkspace("chat_1", "/fallback", fetchLike), { path: "/fallback", reason: "This chat has no folder" });
		const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
		assert.deepEqual(await openWorkspace("chat_1", "/fallback", offline), { path: "/fallback", reason: "The app could not be reached." });
	});
});
