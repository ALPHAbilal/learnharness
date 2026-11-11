import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tool-log-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
const { withToolLog, toolLogDir, toolLogFile, TOOL_LOG_RESULT_MAX_CHARS } = await import("../src/agent/tool-log.ts");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const params = Type.Object({ value: Type.String() });
const echo: AgentTool<typeof params> = {
	name: "echo", label: "echo", description: "echo", parameters: params,
	execute: async (_id, input) => ({ content: [{ type: "text", text: `got ${input.value}` }], details: null }),
};
const boom: AgentTool<typeof params> = {
	name: "boom", label: "boom", description: "boom", parameters: params,
	execute: async () => { throw new Error("exploded"); },
};
const soft: AgentTool<typeof params> = {
	name: "soft", label: "soft", description: "soft", parameters: params,
	execute: async () => ({ content: [{ type: "text", text: "x".repeat(TOOL_LOG_RESULT_MAX_CHARS + 50) }], details: null, isError: true }),
};
const lines = (chatId: string) => fs.readFileSync(toolLogFile(chatId), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("withToolLog", () => {
	it("defaults under the data folder", () => {
		assert.equal(toolLogDir.current, path.join(TMP, "data", "tool-logs"));
	});

	it("appends one line per call with the exact arguments, and passes the result through", async () => {
		const [tool] = withToolLog("chat_a", "teacher", [echo]);
		const result = await tool!.execute("call_1", { value: "hello" });
		assert.equal((result.content[0] as { text: string }).text, "got hello");
		const [line] = lines("chat_a");
		assert.equal(line!.agent, "teacher");
		assert.equal(line!.tool, "echo");
		assert.equal(line!.callId, "call_1");
		assert.deepEqual(line!.args, { value: "hello" });
		assert.equal(line!.isError, false);
		assert.equal(line!.result, "got hello");
		assert.equal(typeof line!.t, "number");
	});

	it("logs a thrown error and rethrows it unchanged", async () => {
		const [tool] = withToolLog("chat_b", "infinite", [boom]);
		await assert.rejects(tool!.execute("call_2", { value: "x" }), /exploded/);
		const [line] = lines("chat_b");
		assert.equal(line!.isError, true);
		assert.equal(line!.result, "exploded");
	});

	it("records error results and cuts long result text", async () => {
		const [tool] = withToolLog("chat_c", "practice", [soft]);
		await tool!.execute("call_3", { value: "x" });
		const [line] = lines("chat_c");
		assert.equal(line!.isError, true);
		assert.ok((line!.result as string).length < TOOL_LOG_RESULT_MAX_CHARS + 60);
		assert.match(line!.result as string, /50 more characters\]$/);
	});

	it("keeps the tool's other fields and appends across calls", async () => {
		const [tool] = withToolLog("chat_d", "teacher", [{ ...echo, executionMode: "sequential" as const } as AgentTool<any>]);
		assert.equal(tool!.name, "echo");
		assert.equal(tool!.executionMode, "sequential");
		assert.equal(tool!.parameters, params);
		await tool!.execute("1", { value: "a" });
		await tool!.execute("2", { value: "b" });
		assert.equal(lines("chat_d").length, 2);
	});

	it("an unwritable log folder never breaks the call", async () => {
		const blocker = path.join(TMP, "blocker");
		fs.writeFileSync(blocker, "file");
		const previous = toolLogDir.current;
		toolLogDir.current = path.join(blocker, "nested");
		try {
			const [tool] = withToolLog("chat_e", "teacher", [echo]);
			const result = await tool!.execute("call_5", { value: "still works" });
			assert.equal((result.content[0] as { text: string }).text, "got still works");
		} finally {
			toolLogDir.current = previous;
		}
	});

	it("sanitizes hostile chat ids into the log folder", () => {
		assert.equal(path.dirname(toolLogFile("../../etc/passwd")), toolLogDir.current);
	});
});
