/**
 * BUILD WORKSPACE — the branch folder, its files, stage state and the test
 * runner (docs/superpowers/specs/2026-11-13-workspace-practice-branch-design.md).
 *
 * Layout under the learning-data root:
 *   practice/<parentChatId>-<nodeId|start>-<n>/   the learner's workspace
 *   build-state/<branchChatId>.json                stage plan, locked test, runs
 *
 * Folders are never deleted automatically. Stage state lives beside the chat
 * record (not in it) so mid-turn tool writes never race the turn's
 * write-ahead message persistence.
 *
 * CONFINEMENT: every path is resolved inside the branch folder — relative
 * only, no `..`, no symlink whose target leaves the folder. It catches
 * mistakes; it is not a security boundary (commands can still reach out).
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import {
	branchFolderName,
	emptyBuildState,
	isAbsoluteOrHome,
	stripAnsi,
	tail,
	type BuildState,
	type BuildTestRun,
	type BuildWorkspaceEvent,
} from "../core/build-branch.ts";
import { killProcessTree, shellCommandSpec } from "./build-shell.ts";

export const PRACTICE_ROOT = path.join(/* turbopackIgnore: true */ PATHS.data, "practice");
const STATE_ROOT = path.join(/* turbopackIgnore: true */ PATHS.data, "build-state");

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LISTED = 500;
const SKIPPED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"]);
export const TEST_TIMEOUT_MS = 60_000;
const RUN_OUTPUT_LIMIT = 8_000;
const MAX_EVENTS = 200;
const MAX_RUNS = 100;

export class WorkspaceError extends Error {}

// ─── folders ─────────────────────────────────────────────────────────────────

/** Create the next free `<parent>-<node>-<n>` folder and return its path. */
export function allocateFolder(parentChatId: string, nodeId: string | null, root = PRACTICE_ROOT): string {
	fs.mkdirSync(root, { recursive: true });
	for (let n = 1; n < 10_000; n++) {
		const candidate = path.join(root, branchFolderName(parentChatId, nodeId, n));
		try {
			fs.mkdirSync(candidate); // non-recursive: fails if it exists
			return candidate;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
	throw new WorkspaceError("No free workspace folder name");
}

function realOrSelf(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return path.resolve(p);
	}
}

function within(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `rel` inside `folder`, or throw a WorkspaceError naming why. The
 * nearest existing ancestor's REAL path must stay inside the folder's real
 * path, so a symlink pointing outside is refused even for new files.
 */
export function resolveInside(folder: string, rel: string): string {
	const raw = rel.trim();
	if (!raw || raw.includes("\0")) throw new WorkspaceError("Path is empty");
	if (isAbsoluteOrHome(raw)) throw new WorkspaceError(`Path must be relative to the workspace folder: ${rel}`);
	const root = path.resolve(folder);
	const resolved = path.resolve(root, raw);
	if (resolved === root || !within(root, resolved)) throw new WorkspaceError(`Path leaves the workspace folder: ${rel}`);
	let probe = resolved;
	while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
	if (!within(realOrSelf(root), realOrSelf(probe))) throw new WorkspaceError(`Path leaves the workspace folder (symlink): ${rel}`);
	return resolved;
}

// ─── files ───────────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
	path: string;
	dir: boolean;
	size: number;
}

/** Recursive listing (POSIX-style relative paths), skipping tool caches. */
export function listFiles(folder: string): { entries: WorkspaceEntry[]; truncated: boolean } {
	const entries: WorkspaceEntry[] = [];
	let truncated = false;
	const walk = (dir: string, prefix: string) => {
		let names: fs.Dirent[];
		try {
			names = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		names.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
		for (const entry of names) {
			if (entries.length >= MAX_LISTED) {
				truncated = true;
				return;
			}
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (SKIPPED_DIRS.has(entry.name)) continue;
				entries.push({ path: rel, dir: true, size: 0 });
				walk(path.join(dir, entry.name), rel);
			} else if (entry.isFile()) {
				let size = 0;
				try {
					size = fs.statSync(path.join(dir, entry.name)).size;
				} catch {
					/* raced deletion */
				}
				entries.push({ path: rel, dir: false, size });
			}
		}
	};
	walk(folder, "");
	return { entries, truncated };
}

export function readWorkspaceFile(folder: string, rel: string): string {
	const file = resolveInside(folder, rel);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		throw new WorkspaceError(`No such file: ${rel}`);
	}
	if (!stat.isFile()) throw new WorkspaceError(`Not a file: ${rel}`);
	if (stat.size > MAX_FILE_BYTES) throw new WorkspaceError(`File is too large to open here (${stat.size} bytes): ${rel}`);
	const bytes = fs.readFileSync(file);
	if (bytes.includes(0)) throw new WorkspaceError(`Binary file: ${rel}`);
	return bytes.toString("utf-8");
}

function sha256(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}

/** True when `rel` names the active stage's locked test file. */
export function isLockedTest(folder: string, state: BuildState, rel: string): boolean {
	if (!state.active) return false;
	try {
		return resolveInside(folder, rel) === resolveInside(folder, state.active.testPath);
	} catch {
		return false;
	}
}

/** Write a workspace file; refuses the active stage's locked test. */
export function writeWorkspaceFile(folder: string, state: BuildState, rel: string, content: string): void {
	if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) throw new WorkspaceError(`File is too large (max ${MAX_FILE_BYTES} bytes): ${rel}`);
	if (isLockedTest(folder, state, rel)) throw new WorkspaceError(`${rel} is the active stage's locked test file — it cannot change until the stage ends.`);
	const file = resolveInside(folder, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

/** Write the stage's test file and return its hash (the lock). */
export function writeTestFile(folder: string, rel: string, content: string): string {
	const file = resolveInside(folder, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
	return sha256(content);
}

// ─── stage state ─────────────────────────────────────────────────────────────

function stateFile(branchId: string, root = STATE_ROOT): string {
	if (!/^[A-Za-z0-9_-]+$/.test(branchId)) throw new WorkspaceError(`Invalid branch id: ${branchId}`);
	return path.join(root, `${branchId}.json`);
}

export function readState(branchId: string, root = STATE_ROOT): BuildState {
	try {
		const parsed = JSON.parse(fs.readFileSync(stateFile(branchId, root), "utf-8")) as Partial<BuildState>;
		return { ...emptyBuildState(), ...parsed };
	} catch {
		return emptyBuildState();
	}
}

export function writeState(branchId: string, state: BuildState, root = STATE_ROOT): void {
	fs.mkdirSync(root, { recursive: true });
	writeFileAtomicSync(stateFile(branchId, root), JSON.stringify(state, null, "\t"), { allowInPlaceFallback: true });
}

/** Synchronous read-modify-write of a branch's stage state. */
export function updateState(branchId: string, update: (state: BuildState) => BuildState | void, root = STATE_ROOT): BuildState {
	const state = readState(branchId, root);
	const next = update(state) ?? state;
	writeState(branchId, next, root);
	return next;
}

/** Record a workspace event for the coach's next turn (bounded log). */
export function recordEvent(state: BuildState, by: "you" | "ai", kind: BuildWorkspaceEvent["kind"], detail: string): BuildState {
	const seq = (state.events.at(-1)?.seq ?? state.seenEventSeq) + 1;
	state.events = [...state.events, { seq, at: new Date().toISOString(), by, kind, detail }].slice(-MAX_EVENTS);
	return state;
}

// ─── tests ───────────────────────────────────────────────────────────────────

export interface CommandResult {
	output: string;
	exitCode: number | null;
	timedOut: boolean;
}

/** Run one shell command in `folder` to completion (or timeout) and capture
 *  its combined output. Used for stage tests. */
export function runCommandToCompletion(folder: string, command: string, timeoutMs: number): Promise<CommandResult> {
	return new Promise((resolve) => {
		const spec = shellCommandSpec(folder, command);
		let output = "";
		let settled = false;
		const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: process.platform !== "win32", windowsHide: true });
		const append = (chunk: Buffer) => {
			output += chunk.toString("utf-8");
			if (output.length > RUN_OUTPUT_LIMIT * 4) output = output.slice(-RUN_OUTPUT_LIMIT * 2);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		const finish = (exitCode: number | null, timedOut: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ output: tail(stripAnsi(output), RUN_OUTPUT_LIMIT), exitCode, timedOut });
		};
		const timer = setTimeout(() => {
			killProcessTree(child.pid);
			finish(null, true);
		}, timeoutMs);
		child.on("error", (err) => {
			output += `\n${err.message}`;
			finish(null, false);
		});
		child.on("close", (code) => finish(code, false));
	});
}

/**
 * Run the active stage's tests. Verifies the locked test file is unchanged
 * first: a tampered test fails the run with an explanation instead of
 * silently grading against different tests.
 */
export async function runStageTests(branchId: string, folder: string, by: "you" | "ai", root = STATE_ROOT): Promise<BuildTestRun> {
	const state = readState(branchId, root);
	if (!state.active) throw new WorkspaceError("No stage is active — there are no tests to run yet.");
	const active = state.active;
	let current: string | null = null;
	try {
		current = sha256(fs.readFileSync(resolveInside(folder, active.testPath)));
	} catch {
		current = null;
	}
	let result: CommandResult;
	if (current !== active.testSha256) {
		result = {
			output: current === null
				? `The stage's test file ${active.testPath} is missing. Tests cannot run until the coach restores it.`
				: `The stage's test file ${active.testPath} was changed after the stage started. The coach must restore it before tests can grade the stage.`,
			exitCode: null,
			timedOut: false,
		};
	} else {
		result = await runCommandToCompletion(folder, active.testCommand, TEST_TIMEOUT_MS);
	}
	const run: BuildTestRun = {
		at: new Date().toISOString(),
		stage: active.index,
		by,
		passed: result.exitCode === 0 && !result.timedOut,
		exitCode: result.exitCode,
		output: result.timedOut ? `${result.output}\n[tests timed out after ${TEST_TIMEOUT_MS / 1000}s]` : result.output,
		timedOut: result.timedOut,
	};
	updateState(branchId, (s) => {
		s.runs = [...s.runs, run].slice(-MAX_RUNS);
		recordEvent(s, by, "test-run", `Stage ${active.index + 1} tests ${run.passed ? "PASSED" : "FAILED"} (exit ${run.exitCode ?? "none"})\n${tail(run.output, 2_000)}`);
	}, root);
	return run;
}
