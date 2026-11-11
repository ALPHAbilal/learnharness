/**
 * The workspace tools in the transcript: every command the agent ran and
 * every file it wrote renders as the quiet tool-call card, with the
 * command or path as the headline and the real output on expand.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { runCommandTool, writeFileTool } from "../src/agent/tools/workspace.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-card-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("workspace tool cards", () => {
	it("both tools are registered on the tool-call card", () => {
		assert.equal(artifactRenderers.run_command, ToolCallCard);
		assert.equal(artifactRenderers.write_file, ToolCallCard);
	});

	it("a command's card headlines the command and shows its real output", async () => {
		const input = { command: "echo card-output" };
		const result = await runCommandTool(dir).execute("call_1", input);
		const html = renderToStaticMarkup(<ToolCallCard part={{ type: "tool-run_command", state: "output-available", toolCallId: "call_1", input, output: result.details }} />);
		assert.match(html, /data-tool="run_command"/);
		assert.match(html, /echo card-output<\/span>/, "the command is the collapsed headline");
		assert.match(html, /exit code: 0/);
		assert.match(html, /card-output/);
	});

	it("a written file's card headlines the path and reports the write", async () => {
		const input = { path: "notes/challenge.md", content: "# Challenge" };
		const result = await writeFileTool(dir).execute("call_2", input);
		const html = renderToStaticMarkup(<ToolCallCard part={{ type: "tool-write_file", state: "output-available", toolCallId: "call_2", input, output: result.details }} />);
		assert.match(html, /notes\/challenge\.md<\/span>/);
		assert.match(html, /Wrote 11 bytes/);
	});
});
