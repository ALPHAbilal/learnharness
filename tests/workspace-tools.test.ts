/**
 * THE WORKSPACE TOOLS (run_command, write_file): real processes and real
 * files in a temporary chat folder. HOME is redirected first so the shared
 * sensitive-path guard reads only synthetic locations.
 */
import assert from "node:assert/strict";
import fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-workspace-tools-")));
const home = path.join(root, "home");
const dir = path.join(root, "workspace", "chat one");
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR", "OPENROUTER_API_KEY"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: path.join(root, "auth.json"), LH_DATA_DIR: path.join(root, "data"), OPENROUTER_API_KEY: "sk-secret-value" });
for (const directory of [home, dir]) await fs.mkdir(directory, { recursive: true });

const { runCommandTool, writeFileTool, workspaceTools, workspaceInstructions, commandEnvironment, COMMAND_OUTPUT_MAX_CHARS } = await import("../src/agent/tools/workspace.ts");

after(async () => {
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await fs.rm(root, { recursive: true, force: true });
});

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? "").join("\n");
const run = (command: string, timeoutSeconds?: number, signal?: AbortSignal) =>
	runCommandTool(dir).execute("call_1", { command, ...(timeoutSeconds ? { timeoutSeconds } : {}) }, signal);
const write = (target: string, content: string) => writeFileTool(dir).execute("call_2", { path: target, content });

describe("run_command", () => {
	it("runs in the chat's folder and reports exit code and output", async () => {
		const result = await run("echo hi && pwd");
		assert.notEqual(result.isError, true);
		assert.match(text(result), /^exit code: 0/);
		assert.match(text(result), /hi/);
		assert.ok(text(result).includes(dir), "cwd is the chat folder");
	});

	it("a failing command is an ordinary result carrying its exit code and stderr", async () => {
		const result = await run("echo oops 1>&2; exit 3");
		assert.notEqual(result.isError, true);
		assert.match(text(result), /^exit code: 3/);
		assert.match(text(result), /stderr:\noops/);
	});

	it("kills a command that outlives its time limit, children included", async () => {
		const started = Date.now();
		const result = await run("sleep 30; echo late", 1);
		assert.equal(result.isError, true);
		assert.match(text(result), /did not finish within 1s and was killed/);
		assert.ok(Date.now() - started < 5_000, "settles promptly");
		assert.doesNotMatch(text(result), /late/);
	});

	it("cuts oversized output to its tail and says so", async () => {
		const result = await run(`node -e "process.stdout.write('a'.repeat(${COMMAND_OUTPUT_MAX_CHARS}) + 'TAILMARK')"`);
		const body = text(result);
		assert.match(body, /first \d+ characters cut/);
		assert.ok(body.includes("TAILMARK"), "the end survives");
		assert.ok(body.length < COMMAND_OUTPUT_MAX_CHARS + 500);
	});

	it("stops when the turn is aborted", async () => {
		const controller = new AbortController();
		const pending = run("sleep 30", 60, controller.signal);
		setTimeout(() => controller.abort(), 200);
		const result = await pending;
		assert.equal(result.isError, true);
		assert.match(text(result), /Operation aborted/);
	});

	it("does not hand the app's provider keys to the command", async () => {
		assert.equal(commandEnvironment({ OPENROUTER_API_KEY: "x", PATH: "/bin", LH_AUTH_FILE: "/a" }).OPENROUTER_API_KEY, undefined);
		assert.equal(commandEnvironment({ PATH: "/bin" }).PATH, "/bin");
		const result = await run("echo key=[$OPENROUTER_API_KEY]");
		assert.match(text(result), /key=\[\]/);
	});

	it("a missing folder is reported, not thrown", async () => {
		const result = await runCommandTool(path.join(root, "gone")).execute("call_3", { command: "echo hi" });
		assert.equal(result.isError, true);
		assert.match(text(result), /could not be started/);
	});
});

describe("write_file", () => {
	it("a relative path lands in the chat's folder, creating parents", async () => {
		const result = await write("src/deep/main.py", "print('hi')\n");
		assert.notEqual(result.isError, true);
		assert.equal(await fs.readFile(path.join(dir, "src", "deep", "main.py"), "utf-8"), "print('hi')\n");
		assert.match(text(result), /Wrote 12 bytes/);
	});

	it("replaces an existing file whole", async () => {
		await write("a.txt", "one");
		await write("a.txt", "two");
		assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf-8"), "two");
	});

	it("an absolute path outside the folder is written as given", async () => {
		const outside = path.join(root, "elsewhere", "note.md");
		const result = await write(outside, "x");
		assert.notEqual(result.isError, true);
		assert.equal(fsSync.existsSync(outside), true);
	});

	it("refuses protected locations: .env files and private home folders", async () => {
		const env = await write(".env", "SECRET=1");
		assert.equal(env.isError, true);
		assert.match(text(env), /Access denied/);
		assert.equal(fsSync.existsSync(path.join(dir, ".env")), false);
		const ssh = await write(path.join(home, ".ssh", "authorized_keys"), "key");
		assert.equal(ssh.isError, true);
		assert.equal(fsSync.existsSync(path.join(home, ".ssh", "authorized_keys")), false);
	});

	it("an unwritable target is reported, not thrown", async () => {
		await write("blocker", "i am a file");
		const result = await write("blocker/child.txt", "x");
		assert.equal(result.isError, true);
		assert.match(text(result), /Could not write/);
	});
});

describe("the registry and its instructions", () => {
	it("exposes exactly the two tools, healed", () => {
		assert.deepEqual(Object.keys(workspaceTools(dir)).sort(), ["run_command", "write_file"]);
	});
	it("the instruction block names the folder and both tools", () => {
		const block = workspaceInstructions(dir);
		assert.ok(block.includes(dir));
		assert.match(block, /run_command/);
		assert.match(block, /write_file/);
	});
});
