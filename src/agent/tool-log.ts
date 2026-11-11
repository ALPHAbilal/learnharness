/**
 * tool-log — the per-chat record of every tool call an agent makes.
 *
 * Owner decision (workspaces): the agent has full access to the learner's
 * machine through run_command and write_file, so every call is written
 * down exactly as it was made. The log lets the learner see afterwards
 * what the agent did. It is a record, not a control: it prevents nothing.
 *
 * Artifact: one JSONL file per chat at data/tool-logs/<chatId>.jsonl.
 * Each line: {"t":<epoch ms>,"agent":…,"tool":…,"callId":…,"args":<exact
 * arguments>,"isError":<bool>,"result":<model-facing text, cut>}.
 * Writing lives in the agent layer by the provider-events precedent: a
 * config-anchored append, no store adapter.
 *
 * A logging failure never fails the tool call.
 */
import * as fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { PATHS } from "../../config.ts";

/** How much of a result's text one log line keeps. */
export const TOOL_LOG_RESULT_MAX_CHARS = 4_000;

/** Test seam (the toolTimeoutMs idiom): redirect the output directory. */
export const toolLogDir = { current: path.join(PATHS.data, "tool-logs") };

/** The log file for one chat. */
export function toolLogFile(chatId: string): string {
	// chat ids are app-minted (chat_<base36>_<hex>) — sanitize against any
	// future id scheme carrying path-hostile characters.
	const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(/* turbopackIgnore: true */ toolLogDir.current, `${safe}.jsonl`);
}

function resultText(result: AgentToolResult<unknown> | undefined): string {
	const text = (result?.content ?? [])
		.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
		.join("\n");
	return text.length > TOOL_LOG_RESULT_MAX_CHARS
		? `${text.slice(0, TOOL_LOG_RESULT_MAX_CHARS)}… [${text.length - TOOL_LOG_RESULT_MAX_CHARS} more characters]`
		: text;
}

function append(chatId: string, line: Record<string, unknown>): void {
	try {
		const file = toolLogFile(chatId);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...line })}\n`, "utf-8");
	} catch {
		// The log must never break a turn.
	}
}

/** Wrap each tool so its calls are logged. Everything else about the tool
 *  (schema, argument healing, execution mode) is untouched; the result and
 *  any thrown error pass through unchanged. */
export function withToolLog(chatId: string, agent: string, tools: readonly AgentTool<any>[]): AgentTool<any>[] {
	return tools.map((tool) => ({
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const entry = { agent, tool: tool.name, callId: toolCallId, args: params as unknown };
			try {
				const result = await tool.execute(toolCallId, params, signal, onUpdate);
				append(chatId, { ...entry, isError: result.isError === true, result: resultText(result) });
				return result;
			} catch (error) {
				append(chatId, { ...entry, isError: true, result: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		},
	}));
}
