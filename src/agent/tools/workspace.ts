/**
 * THE WORKSPACE TOOLS — run_command and write_file.
 *
 * Every chat born with a workspace folder (ChatRecord.workspaceDir) gives
 * its agents these two tools next to the read-only file set (read, ls,
 * find, grep). The learner writes and runs code in that folder in their
 * own editor; the agent checks the work by running it there, and can lay
 * down files (a challenge file, a test, starter scaffolding).
 *
 * NOT A SANDBOX (owner decision): commands run through the system shell
 * with the learner's own user permissions. The safeguards here are
 * operational only — a time limit, an output limit, the app's own
 * credentials kept out of the child environment, and the existing
 * sensitive-path guard on writes. The per-chat tool log (tool-log.ts)
 * records every call; it shows what happened, it prevents nothing.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { isKnownAuthKey, isProviderEnvVar } from "../../core/auth-keys.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { healToolRecord } from "./heal.ts";

export const RUN_COMMAND_TOOL = "run_command";
export const WRITE_FILE_TOOL = "write_file";

/** Default and ceiling for one command's run time. */
export const COMMAND_DEFAULT_TIMEOUT_S = 60;
export const COMMAND_MAX_TIMEOUT_S = 600;
/** Per-stream output ceiling handed to the model; the TAIL is kept, since
 *  the end of a build or test run is where the failure is. */
export const COMMAND_OUTPUT_MAX_CHARS = 30_000;
/** After the time limit, how long a killed process may take to exit before
 *  the call settles without it. */
const KILL_GRACE_MS = 2_000;

const runCommandInput = Type.Object({
	command: Type.String({ minLength: 1, description: "The shell command line to run in this chat's folder." }),
	timeoutSeconds: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: COMMAND_MAX_TIMEOUT_S,
		description: `Time limit in seconds (default ${COMMAND_DEFAULT_TIMEOUT_S}, at most ${COMMAND_MAX_TIMEOUT_S}). The command is killed when it runs out.`,
	})),
});

const writeFileInput = Type.Object({
	path: Type.String({ minLength: 1, description: "File to write. A relative path is inside this chat's folder; an absolute path is used as given." }),
	content: Type.String({ description: "The complete new contents of the file." }),
});

/** A rolling tail buffer: keeps at most `max` characters, counts the rest. */
class Tail {
	private text = "";
	dropped = 0;
	constructor(private readonly max: number) {}
	push(chunk: string): void {
		this.text += chunk;
		if (this.text.length > this.max) {
			this.dropped += this.text.length - this.max;
			this.text = this.text.slice(-this.max);
		}
	}
	render(label: string): string {
		if (!this.text) return `${label}: (empty)`;
		const note = this.dropped > 0 ? ` (first ${this.dropped} characters cut; showing the last ${this.text.length})` : "";
		return `${label}${note}:\n${this.text.replace(/\n$/, "")}`;
	}
}

/** The child's environment: the server's, minus the app's own credentials.
 *  Provider keys live in process.env for the model clients; a learner's
 *  program (or an `env` call) must not see or print them. */
export function commandEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(source)) {
		if (isKnownAuthKey(name) || isProviderEnvVar(name) || name === "LH_AUTH_FILE") continue;
		env[name] = value;
	}
	return env;
}

/** Stop a whole command tree. POSIX: the child leads its own process group
 *  (spawned detached), so the group signal reaches the shell's children.
 *  Windows: taskkill walks the tree. */
function killTree(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		else process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/** `details` is what the record keeps and the transcript card shows, so it
 *  carries the same text the model saw next to the call's facts. */
function textResult(text: string, details: Record<string, unknown>, isError = false): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text }], details: { text, ...details }, ...(isError ? { isError: true } : {}) };
}

/** run_command — one shell command in the chat's folder. A non-zero exit is
 *  an ordinary result (failing code is information, not a tool failure);
 *  only a command that could not start or ran out of time is an error. */
export function runCommandTool(dir: string): AgentTool<typeof runCommandInput> {
	return {
		name: RUN_COMMAND_TOOL,
		label: RUN_COMMAND_TOOL,
		description:
			`Run a shell command in this chat's folder (${dir}) and get its exit code, stdout and stderr. ` +
			`Use it to run or test the learner's code. Runs with the learner's own permissions; not sandboxed. ` +
			`Time limit ${COMMAND_DEFAULT_TIMEOUT_S}s by default (timeoutSeconds, at most ${COMMAND_MAX_TIMEOUT_S}); ` +
			`each output stream is cut to its last ${COMMAND_OUTPUT_MAX_CHARS} characters. Not for interactive programs: stdin is closed.`,
		parameters: runCommandInput,
		executionMode: "sequential",
		execute: (_toolCallId, input, signal) => new Promise((resolve) => {
			const timeoutSeconds = input.timeoutSeconds ?? COMMAND_DEFAULT_TIMEOUT_S;
			const stdout = new Tail(COMMAND_OUTPUT_MAX_CHARS);
			const stderr = new Tail(COMMAND_OUTPUT_MAX_CHARS);
			const started = Date.now();
			let ended: "timeout" | "aborted" | null = null;
			let settled = false;
			const child = spawn(input.command, {
				cwd: dir,
				shell: true,
				env: commandEnvironment() as NodeJS.ProcessEnv,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			const settle = (result: AgentToolResult<Record<string, unknown>>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (graceTimer) clearTimeout(graceTimer);
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const body = () => `${stdout.render("stdout")}\n\n${stderr.render("stderr")}`;
			const details = (extra: Record<string, unknown>) => ({ command: input.command, cwd: dir, durationMs: Date.now() - started, ...extra });
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const stop = (why: "timeout" | "aborted") => {
				if (ended) return;
				ended = why;
				killTree(child.pid);
				// A process that ignores the kill must not hold the turn.
				graceTimer = setTimeout(() => settle(textResult(
					why === "timeout"
						? `The command did not finish within ${timeoutSeconds}s and was killed.\n\n${body()}`
						: `Operation aborted.\n\n${body()}`,
					details({ [why]: true }), true)), KILL_GRACE_MS);
			};
			const timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
			const onAbort = () => stop("aborted");
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout?.setEncoding("utf-8").on("data", (chunk: string) => stdout.push(chunk));
			child.stderr?.setEncoding("utf-8").on("data", (chunk: string) => stderr.push(chunk));
			child.once("error", (error) => settle(textResult(`The command could not be started: ${error.message}`, details({ startError: error.message }), true)));
			child.once("close", (code, killSignal) => {
				if (ended === "timeout") {
					settle(textResult(`The command did not finish within ${timeoutSeconds}s and was killed.\n\n${body()}`, details({ timeout: true }), true));
				} else if (ended === "aborted") {
					settle(textResult(`Operation aborted.\n\n${body()}`, details({ aborted: true }), true));
				} else {
					const exit = code ?? `killed by ${killSignal ?? "a signal"}`;
					settle(textResult(`exit code: ${exit}\n\n${body()}`, details({ exitCode: code, signal: killSignal })));
				}
			});
		}),
	};
}

/** write_file — create or replace one text file. Relative paths are inside
 *  the chat's folder; parent folders are created. The same protected
 *  locations the read tools refuse (credentials, .env files, private home
 *  folders) and the learner's own file-access restriction are honored. */
export function writeFileTool(dir: string): AgentTool<typeof writeFileInput> {
	return {
		name: WRITE_FILE_TOOL,
		label: WRITE_FILE_TOOL,
		description:
			`Create or replace a text file. A relative path is inside this chat's folder (${dir}); an absolute path is used as given. ` +
			`Parent folders are created. The whole file is replaced with content — read it first if it exists and you mean to keep parts of it.`,
		parameters: writeFileInput,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const absolute = path.isAbsolute(input.path) ? path.resolve(input.path) : path.resolve(dir, input.path);
			let target: string;
			try {
				target = resolveSourcePath(absolute);
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error), { path: absolute }, true);
			}
			try {
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, input.content, "utf-8");
			} catch (error) {
				return textResult(`Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`, { path: target }, true);
			}
			const bytes = Buffer.byteLength(input.content, "utf-8");
			return textResult(`Wrote ${bytes} bytes to ${target}`, { path: target, bytes });
		},
	};
}

/** Both tools for one chat folder, argument-healed like every registry. */
export function workspaceTools(dir: string): Record<string, AgentTool<any>> {
	return healToolRecord({
		[RUN_COMMAND_TOOL]: runCommandTool(dir),
		[WRITE_FILE_TOOL]: writeFileTool(dir),
	});
}

/** The system-prompt block a chat with a folder appends. Composed in code,
 *  not a prompt fragment: it only exists when the chat has a folder, and it
 *  names that folder. */
export function workspaceInstructions(dir: string): string {
	return [
		"# This chat's folder",
		"",
		`This chat has its own folder on the learner's computer: \`${dir}\``,
		"",
		"The learner writes and runs code there in their own editor (VS Code). You work in the same folder:",
		"",
		`- \`read\`, \`ls\`, \`find\`, \`grep\` — look at what the learner wrote. Give these tools the absolute path above; their relative paths start at the learner's home folder, not here.`,
		`- \`${RUN_COMMAND_TOOL}\` — run a shell command in the folder: run the learner's program, a test, a build.`,
		`- \`${WRITE_FILE_TOOL}\` — create or replace a file. A relative path lands in the folder.`,
		"",
		"Rules:",
		"",
		"- Check work by reading the files and running them. Never ask the learner to paste code that is already in the folder.",
		"- The learner's solution is theirs to write. Use `write_file` for what surrounds it: a challenge description, starter scaffolding, a test, sample input. Never write the solution the learner is meant to produce, and never overwrite the learner's own file to fix it for them.",
		"- Commands run with the learner's own permissions, without a sandbox. Run what the work needs and nothing destructive: no deleting outside the folder, no installing system software, no changing the learner's settings, unless the learner asked for exactly that.",
		"- Every tool call is saved to a log the learner can read.",
	].join("\n");
}
