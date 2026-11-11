import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPracticeLike, isWorkspacePath, resolveSettings, sanitizeUserSettings, workspaceFolderName } from "../src/core/index.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";

const ID = "chat_abc_12345678";

describe("workspaceFolderName", () => {
	it("slugs the title and appends the id tail", () => {
		assert.equal(workspaceFolderName("Build your own Shell!", ID), "build-your-own-shell-12345678");
	});
	it("falls back to chat- when nothing usable is left", () => {
		assert.equal(workspaceFolderName("///", ID), "chat-12345678");
		assert.equal(workspaceFolderName("   ", ID), "chat-12345678");
		assert.equal(workspaceFolderName("🚀🚀", ID), "chat-12345678");
	});
	it("never produces a name Windows reserves", () => {
		assert.equal(workspaceFolderName("CON", ID), "chat-12345678");
		assert.equal(workspaceFolderName("nul", ID), "chat-12345678");
	});
	it("caps the slug at 40 characters and leaves no trailing dash, dot or space", () => {
		const name = workspaceFolderName(`${"word ".repeat(40)}`, ID);
		const slug = name.slice(0, -"-12345678".length);
		assert.ok(slug.length <= 40, slug);
		assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
		assert.match(workspaceFolderName("ends with dots... ", ID), /^ends-with-dots-12345678$/);
	});
	it("uses only portable characters for hostile titles", () => {
		assert.match(workspaceFolderName('a/b\\c:d*e?f"g<h>i|j', ID), /^[a-z0-9-]+$/);
	});
});

describe("isWorkspacePath", () => {
	it("accepts absolute and home-anchored paths", () => {
		for (const ok of ["/a/b", "C:\\x", "C:/x", "~/code", "~", "\\\\server\\share"]) assert.equal(isWorkspacePath(ok), true, ok);
	});
	it("rejects relative, empty and NUL-carrying paths", () => {
		for (const bad of ["relative/x", "", "./x", "/a\0b"]) assert.equal(isWorkspacePath(bad), false, JSON.stringify(bad));
	});
});

describe("isPracticeLike", () => {
	it("is true for practice and infinite only", () => {
		assert.equal(isPracticeLike("practice"), true);
		assert.equal(isPracticeLike("infinite"), true);
		assert.equal(isPracticeLike("teach"), false);
		assert.equal(isPracticeLike(undefined), false);
	});
});

describe("agent.workspace setting", () => {
	it("the write parser refuses a relative path and accepts a home-anchored one", () => {
		assert.equal(parseAgentSettingsBody({ workspace: { path: "relative" } }).ok, false);
		assert.equal(parseAgentSettingsBody({ workspace: "x" }).ok, false);
		const ok = parseAgentSettingsBody({ workspace: { path: "  ~/lh  " } });
		assert.deepEqual(ok.ok && ok.settings.workspace, { path: "~/lh" });
	});
	it("an object without a path clears the choice", () => {
		const cleared = parseAgentSettingsBody({ workspace: {} });
		assert.deepEqual(cleared.ok && cleared.settings.workspace, {});
	});
	it("the read side drops a malformed value and resolves to not-chosen", () => {
		const bad = sanitizeUserSettings({ version: 1, agent: { workspace: { path: "relative" } } });
		assert.deepEqual(bad?.agent?.workspace, {});
		assert.deepEqual(resolveSettings(null).agent.workspace, {});
		assert.deepEqual(resolveSettings({ version: 1, agent: { workspace: { path: "/w" } } }).agent.workspace, { path: "/w" });
	});
});
