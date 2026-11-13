/**
 * BUILD TERMINAL — one shared terminal per build branch
 * (docs/superpowers/specs/2026-11-13-workspace-practice-branch-design.md).
 *
 * The learner types into an interactive shell (a real PTY through
 * @lydell/node-pty when it loads; a pipe-backed shell otherwise, so the
 * feature never dies on a platform without the native module). The coach's
 * commands run as their OWN processes in the same folder and stream into the
 * same terminal view under an "AI ›" banner — exact exit codes, no
 * interference with whatever the learner is running, and long-running
 * servers keep streaming after the tool call returns "still running".
 *
 * Every chunk is sequenced and attributed (you / ai / out / system). The
 * view replays the recent chunks on connect; the coach reads an ANSI-free
 * transcript of what happened since its last turn.
 *
 * Single-process, in-memory: a server restart starts a fresh shell in the
 * same folder (files persist; scrollback does not).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { stripAnsi, tail } from "../core/build-branch.ts";
import { interactiveShellSpec, killProcessTree, shellCommandSpec, shellLabel } from "./build-shell.ts";

export type ChunkSource = "out" | "you" | "ai" | "system";

export interface TerminalChunk {
	seq: number;
	by: ChunkSource;
	/** Display text (may carry ANSI; CRLF line endings for the view). */
	text: string;
}

interface PtyLike {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	onData(fn: (data: string) => void): void;
	onExit(fn: (code: number | null) => void): void;
}

const REPLAY_CHUNKS = 2_000;
const MAX_CHUNKS = 5_000;
const AI_OUTPUT_LIMIT = 6_000;
export const AI_COMMAND_TIMEOUT_MS = 20_000;

const ESC = "\u001b";
const AI_COLOR = `${ESC}[38;5;141m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): {
	write(d: string): void; resize(c: number, r: number): void; kill(): void;
	onData(fn: (d: string) => void): void; onExit(fn: (e: { exitCode: number }) => void): void;
} };

let ptyModule: PtyModule | null | undefined;
/** Lazy, failure-tolerant native load. `LH_BUILD_PTY=off` forces pipes. */
function loadPty(): PtyModule | null {
	if (ptyModule !== undefined) return ptyModule;
	if (process.env.LH_BUILD_PTY === "off") return (ptyModule = null);
	try {
		const require = createRequire(import.meta.url);
		ptyModule = require("@lydell/node-pty") as PtyModule;
	} catch (err) {
		console.warn("[build-terminal] native PTY unavailable, using a pipe shell:", (err as Error).message);
		ptyModule = null;
	}
	return ptyModule;
}

function toCrlf(text: string): string {
	return text.replace(/\r?\n/g, "\r\n");
}

/** A pipe-backed interactive shell: local line editing + echo, since
 *  there is no TTY to do it. */
function pipeShell(folder: string): PtyLike {
	const spec = interactiveShellSpec(folder);
	const args = spec.file === "bash" ? ["-i"] : spec.args;
	const child = spawn(spec.file, args, { cwd: spec.cwd, env: spec.env, detached: process.platform !== "win32", windowsHide: true });
	const dataFns: Array<(d: string) => void> = [];
	const emit = (d: string) => dataFns.forEach((fn) => fn(d));
	child.stdout?.on("data", (b: Buffer) => emit(toCrlf(b.toString("utf-8"))));
	child.stderr?.on("data", (b: Buffer) => emit(toCrlf(b.toString("utf-8"))));
	let line = "";
	return {
		write(data) {
			for (const ch of data) {
				if (ch === "\r" || ch === "\n") {
					emit("\r\n");
					child.stdin?.write(`${line}\n`);
					line = "";
				} else if (ch === "\u007f" || ch === "\b") {
					if (line) {
						line = line.slice(0, -1);
						emit("\b \b");
					}
				} else if (ch === "\u0003") {
					line = "";
					emit("^C\r\n");
				} else if (ch >= " ") {
					line += ch;
					emit(ch);
				}
			}
		},
		resize() {},
		kill() {
			killProcessTree(child.pid);
		},
		onData(fn) {
			dataFns.push(fn);
		},
		onExit(fn) {
			child.on("close", (code) => fn(code));
		},
	};
}

function ptyShell(mod: PtyModule, folder: string, cols: number, rows: number): PtyLike {
	const spec = interactiveShellSpec(folder);
	const term = mod.spawn(spec.file, spec.args, { name: "xterm-256color", cols, rows, cwd: spec.cwd, env: spec.env });
	return {
		write: (d) => term.write(d),
		resize: (c, r) => term.resize(c, r),
		kill: () => {
			try {
				term.kill();
			} catch {
				/* already exited */
			}
		},
		onData: (fn) => term.onData(fn),
		onExit: (fn) => term.onExit((e) => fn(e.exitCode)),
	};
}

export class BuildTerminal {
	readonly folder: string;
	private shell: PtyLike | null = null;
	private chunks: TerminalChunk[] = [];
	private seq = 0;
	private listeners = new Set<(chunk: TerminalChunk) => void>();
	private inputLine = "";
	private cols = 100;
	private rows = 30;
	private aiProcesses = new Set<ChildProcess>();
	readonly native: boolean;

	constructor(folder: string) {
		this.folder = folder;
		this.native = loadPty() !== null;
	}

	/** The last sequence number written. */
	get lastSeq(): number {
		return this.seq;
	}

	private push(by: ChunkSource, text: string): void {
		if (!text) return;
		const chunk = { seq: ++this.seq, by, text };
		this.chunks.push(chunk);
		if (this.chunks.length > MAX_CHUNKS) this.chunks.splice(0, this.chunks.length - MAX_CHUNKS);
		for (const fn of this.listeners) {
			try {
				fn(chunk);
			} catch {
				/* a broken view must not break the terminal */
			}
		}
	}

	/** Start the learner's shell if it is not running. */
	ensureShell(): void {
		if (this.shell) return;
		const mod = loadPty();
		let shell: PtyLike;
		try {
			shell = mod ? ptyShell(mod, this.folder, this.cols, this.rows) : pipeShell(this.folder);
		} catch (err) {
			this.push("system", toCrlf(`${DIM}[terminal] could not start ${shellLabel()}: ${(err as Error).message}${RESET}\n`));
			shell = pipeShell(this.folder);
		}
		this.shell = shell;
		this.push("system", toCrlf(`${DIM}[terminal] ${shellLabel()} in ${this.folder}${RESET}\n`));
		shell.onData((d) => this.push("out", d));
		shell.onExit((code) => {
			if (this.shell !== shell) return;
			this.shell = null;
			this.push("system", toCrlf(`\n${DIM}[terminal] shell exited (${code ?? "signal"}) — type to start a new one${RESET}\n`));
		});
	}

	/** Learner keystrokes. Completed lines are recorded as `you` commands. */
	write(data: string): void {
		this.ensureShell();
		// Line tracking ignores escape sequences (arrows, function keys);
		// history recalls are still visible in the shell's own echo.
		// eslint-disable-next-line no-control-regex
		const typed = data.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001bO.|\u001b./g, "");
		for (const ch of typed) {
			if (ch === "\r" || ch === "\n") {
				const line = this.inputLine.trim();
				if (line) this.recordCommand(line);
				this.inputLine = "";
			} else if (ch === "\u007f" || ch === "\b") this.inputLine = this.inputLine.slice(0, -1);
			else if (ch === "\u0003" || ch === "\u0015") this.inputLine = "";
			else if (ch >= " ") this.inputLine += ch;
		}
		this.shell!.write(data);
	}

	/** Attributed record of a learner command (transcript only — the shell
	 *  echoes it on screen itself). */
	private commands: Array<{ seq: number; line: string }> = [];
	private recordCommand(line: string): void {
		this.commands.push({ seq: this.seq, line });
		if (this.commands.length > 500) this.commands.splice(0, this.commands.length - 500);
	}

	resize(cols: number, rows: number): void {
		if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || rows < 3 || cols > 500 || rows > 300) return;
		this.cols = cols;
		this.rows = rows;
		this.shell?.resize(cols, rows);
	}

	/** Subscribe to new chunks; returns the replay and an unsubscribe. */
	subscribe(fn: (chunk: TerminalChunk) => void): { replay: TerminalChunk[]; unsubscribe: () => void } {
		this.listeners.add(fn);
		return { replay: this.chunks.slice(-REPLAY_CHUNKS).filter((c) => c.text), unsubscribe: () => this.listeners.delete(fn) };
	}

	/**
	 * ANSI-free transcript after `sinceSeq`: shell output as it appeared,
	 * learner commands marked `YOU $`, coach commands marked `AI $`.
	 */
	transcript(sinceSeq = 0, limit = 8_000): string {
		// A command recorded at seq N was typed after chunk N: it precedes
		// the first chunk numbered above N.
		const commands = this.commands.filter((c) => c.seq >= sinceSeq);
		let next = 0;
		const parts: string[] = [];
		for (const chunk of this.chunks) {
			if (chunk.seq <= sinceSeq) continue;
			while (next < commands.length && commands[next]!.seq < chunk.seq) parts.push(`\n[YOU typed] $ ${commands[next++]!.line}\n`);
			if (chunk.by !== "system") parts.push(chunk.text);
		}
		while (next < commands.length) parts.push(`\n[YOU typed] $ ${commands[next++]!.line}\n`);
		return tail(stripAnsi(parts.join("")).replace(/\n{3,}/g, "\n\n").trim(), limit);
	}

	/**
	 * Run a coach command as its own process in the folder, streaming into
	 * the shared view. Resolves on exit, or after `timeoutMs` with
	 * `running: true` (the process keeps streaming until it exits or the
	 * branch stops).
	 */
	runAiCommand(command: string, timeoutMs = AI_COMMAND_TIMEOUT_MS): Promise<{ output: string; exitCode: number | null; running: boolean }> {
		return new Promise((resolve) => {
			this.push("ai", toCrlf(`\n${AI_COLOR}AI ›${RESET} ${command}\n`));
			const spec = shellCommandSpec(this.folder, command);
			let output = "";
			let settled = false;
			let child: ChildProcess;
			try {
				child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			} catch (err) {
				const message = (err as Error).message;
				this.push("ai", toCrlf(`${message}\n`));
				resolve({ output: message, exitCode: null, running: false });
				return;
			}
			this.aiProcesses.add(child);
			const onData = (b: Buffer) => {
				const text = b.toString("utf-8");
				output += text;
				if (output.length > AI_OUTPUT_LIMIT * 4) output = output.slice(-AI_OUTPUT_LIMIT * 2);
				this.push("ai", toCrlf(text));
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			const settle = (exitCode: number | null, running: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ output: tail(stripAnsi(output), AI_OUTPUT_LIMIT), exitCode, running });
			};
			const timer = setTimeout(() => settle(null, true), timeoutMs);
			child.on("error", (err) => {
				output += `\n${err.message}`;
				this.aiProcesses.delete(child);
				settle(null, false);
			});
			child.on("close", (code) => {
				this.aiProcesses.delete(child);
				this.push("ai", toCrlf(`${DIM}[AI command exited ${code ?? "by signal"}]${RESET}\n`));
				settle(code, false);
			});
		});
	}

	/** Number of coach-started processes still running. */
	get runningAiProcesses(): number {
		return this.aiProcesses.size;
	}

	/** Stop the coach's processes (and optionally the learner's shell). */
	stop(includeShell: boolean): void {
		for (const child of this.aiProcesses) killProcessTree(child.pid);
		this.aiProcesses.clear();
		if (includeShell && this.shell) {
			const shell = this.shell;
			this.shell = null;
			shell.kill();
			this.push("system", toCrlf(`\n${DIM}[terminal] stopped${RESET}\n`));
		}
	}
}

// ─── registry (process-global, survives Next dev module reloads) ─────────────

const REGISTRY_KEY = Symbol.for("learnharness.buildTerminals");
const registry: Map<string, BuildTerminal> =
	((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] as Map<string, BuildTerminal> | undefined) ??
	((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = new Map<string, BuildTerminal>());

/** The branch's terminal, created on first use. */
export function terminalFor(branchId: string, folder: string): BuildTerminal {
	let terminal = registry.get(branchId);
	if (!terminal || terminal.folder !== folder) {
		terminal?.stop(true);
		terminal = new BuildTerminal(folder);
		registry.set(branchId, terminal);
	}
	return terminal;
}

/** The branch's terminal if one exists (no shell started). */
export function existingTerminal(branchId: string): BuildTerminal | undefined {
	return registry.get(branchId);
}

/** Stop everything a branch started (on return or deletion). */
export function stopBranchProcesses(branchId: string): void {
	const terminal = registry.get(branchId);
	if (!terminal) return;
	terminal.stop(true);
	registry.delete(branchId);
}
