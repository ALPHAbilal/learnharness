/**
 * THE BUILD COACH'S TOOLS (build branches, 2026-11-13 —
 * docs/superpowers/specs/2026-11-13-workspace-practice-branch-design.md).
 *
 * Mechanics only: what to pass and what happens. The method (customize →
 * stages → return, predict-first, the hint ladder, never writing the
 * learner's solution) lives in prompts/build/.
 *
 * Every workspace path and command is confined to the branch folder
 * (core/build-branch.ts commandEscape + server resolveInside) — refusals
 * come back as {ok:false, error} results the model corrects from.
 *
 * Stage state lives in the branch's state file, not the chat record, so
 * these mid-turn writes never race the turn's write-ahead message persist.
 *
 * These tools carry their own deadlines (terminal 1–60s, tests 60s) instead
 * of the shared 30s server-tool guard: a stage's tests may legitimately run
 * longer, and an aborted run kills what it started.
 */

import { Type, type Static, type TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BuildBranch, BuildReturnEntry, ChatRecord } from "../../core/contracts/chat.ts";
import { commandEscape, tail, WorkspaceError, type BuildState, type BuildTestRun } from "../../core/build-branch.ts";
import { toToolResult } from "../tool-execute.ts";
import { healToolRecord } from "./heal.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";

/** The terminal surface the tools drive (BuildTerminal in production). */
export interface BuildTerminalPort {
	runAiCommand(command: string, timeoutMs?: number): Promise<{ output: string; exitCode: number | null; running: boolean }>;
	transcript(sinceSeq?: number, limit?: number): string;
}

/** The workspace operations the tools drive (src/server/build-workspace.ts
 *  in production — injected, since the agent layer never imports the
 *  server). Every method throws WorkspaceError on a refusal. */
export interface BuildWorkspacePort {
	/** Absolute path inside the folder, or a WorkspaceError. */
	resolveInside(folder: string, rel: string): string;
	exists(absolutePath: string): boolean;
	listFiles(folder: string): { entries: Array<{ path: string; dir: boolean; size: number }>; truncated: boolean };
	readFile(folder: string, rel: string): string;
	/** Refuses the active stage's locked test. */
	writeFile(folder: string, state: BuildState, rel: string, content: string): void;
	/** Writes the stage test and returns its lock hash. */
	writeTestFile(folder: string, rel: string, content: string): string;
	readState(branchId: string): BuildState;
	updateState(branchId: string, update: (state: BuildState) => BuildState | void): BuildState;
	runStageTests(branchId: string, folder: string, by: "you" | "ai"): Promise<BuildTestRun>;
}

export interface BuildToolContext {
	chatId: string;
	chatStore: {
		getChat(id: string): ChatRecord | null;
		saveBranch(id: string, branch: BuildBranch): void;
		queueBuildReturn(parentId: string, entry: BuildReturnEntry): boolean;
	};
	/** The branch's terminal (created on demand). */
	terminal: () => BuildTerminalPort;
	workspace: BuildWorkspacePort;
	/** Stop the branch's processes after a return. */
	stopProcesses?: () => void;
}

export const BUILD_TOOL_NAMES = [
	"set_level", "build_plan", "stage_start", "run_tests", "stage_complete", "terminal_run", "terminal_read",
	"file_list", "file_read", "file_write", "return_to_lesson",
] as const;

const MAX_STAGES = 20;
const TERMINAL_READ_LIMIT = 8_000;
const FILE_READ_LIMIT = 40_000;

type ToolBody<P extends TSchema> = (input: Static<P>, signal?: AbortSignal) => unknown | Promise<unknown>;

/** Execute wrapper: refusals and workspace errors become {ok:false} results. */
function buildExecute<P extends TSchema>(_schema: P, run: ToolBody<P>): AgentTool<any>["execute"] {
	return async (_toolCallId, input: unknown, signal) => {
		try {
			return toToolResult(await run(input as Static<P>, signal));
		} catch (err) {
			if (err instanceof WorkspaceError) return toToolResult({ ok: false, error: err.message });
			throw err;
		}
	};
}

function tool<P extends TSchema>(name: string, description: string, parameters: P, run: ToolBody<P>): AgentTool<any> {
	return { name, label: name, description, parameters, executionMode: "sequential", execute: buildExecute(parameters, run) };
}

const relPath = (description: string) => Type.String({ minLength: 1, description });

const setLevelInput = Type.Object({
	level: Type.Union([Type.Literal("guided"), Type.Literal("half"), Type.Literal("scratch")], {
		description: "guided = small blanks inside scaffolded files; half = the learner writes whole functions, starter files give structure; scratch = an empty file, the learner builds everything.",
	}),
	evidence: Type.String({
		minLength: 1,
		description: "What the learner showed in the build probe that supports this level: their answers and anything they did, briefly quoted.",
	}),
	learnerAgreed: Type.Boolean({
		description: "true only if the learner explicitly agreed to this level in their own reply. Proposing a level is not agreement.",
	}),
});

const buildPlanInput = Type.Object({
	stages: Type.Array(
		Type.Object({
			title: Type.String({ minLength: 1, description: "Short stage title, e.g. 'Read the raw bytes'." }),
			goal: Type.String({ minLength: 1, description: "One line: what the learner will make work in this stage." }),
		}),
		{ minItems: 1, maxItems: MAX_STAGES, description: "The ordered stages. The last stage maps the build onto the real tool." },
	),
});

const fileInput = Type.Object({
	path: relPath("Path relative to the workspace folder, e.g. 'server.py' or 'tests/test_stage_1.py'."),
	content: Type.String({ description: "The full file content." }),
});

const stageStartInput = Type.Object({
	stage: Type.Integer({ minimum: 1, description: "The stage number in the build plan (1-based)." }),
	hook: Type.String({ minLength: 1, description: "One line: what the learner will make happen." }),
	concept: Type.String({ minLength: 1, description: "The idea behind the stage — only what it needs." }),
	tests: Type.String({ minLength: 1, description: "Exactly what the tests do and what they expect." }),
	notes: Type.Optional(Type.String({ description: "Scope limits: what is deliberately left for later." })),
	starterFiles: Type.Optional(Type.Array(fileInput, {
		maxItems: 10,
		description: "Scaffolding files (never the stage's answer). A starter file is written only if no file exists at that path yet — the learner's earlier work is never overwritten.",
	})),
	testFile: fileInput,
	testCommand: Type.String({ minLength: 1, description: "Command that runs the tests from the workspace folder; exit 0 = stage complete. E.g. 'python3 tests/test_stage_1.py'." }),
});

const stageCompleteInput = Type.Object({
	outcome: Type.Union([Type.Literal("passed"), Type.Literal("passed-shaky"), Type.Literal("skipped")], {
		description: "passed = tests passed and the learner explained why; passed-shaky = passed without a correct explanation; skipped = moved on without passing (or the tests were wrong).",
	}),
	evidence: Type.String({ minLength: 1, description: "One or two lines of evidence: the run, the learner's explanation, or why it was skipped." }),
});

const terminalRunInput = Type.Object({
	command: Type.String({ minLength: 1, description: "One shell command, run from the workspace folder. Paths must stay inside it." }),
	waitSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "How long to wait for it to finish before returning 'still running' (default 20). Servers keep running." })),
});

const pathInput = Type.Object({ path: relPath("Path relative to the workspace folder.") });
const returnInput = Type.Object({
	summary: Type.String({
		minLength: 1,
		description: "The evidence summary for the lesson's teacher: one line per strand (solid / shaky / gap + evidence), then what the teacher should skip, repair, or watch for.",
	}),
});
const emptyInput = Type.Object({});

export function buildTools(ctx: BuildToolContext): Record<string, AgentTool<any>> {
	const branchOf = (): BuildBranch => {
		const branch = ctx.chatStore.getChat(ctx.chatId)?.branch;
		if (!branch) throw new WorkspaceError("This session is not a build branch.");
		return branch;
	};
	const ws = ctx.workspace;
	const state = (): BuildState => ws.readState(ctx.chatId);
	const update = (fn: (s: BuildState) => BuildState | void) => ws.updateState(ctx.chatId, fn);
	const refuseIfReturned = (branch: BuildBranch) => {
		if (branch.phase === "returned") throw new WorkspaceError("This branch has already returned to the lesson.");
	};

	return healToolRecord({
		set_level: tool("set_level",
			"Record the build level the learner agreed to, with the hands-on evidence from your build probe. Required before build_plan. Call it only after the learner said yes to the level in their own words; re-call it if they later ask for easier or harder.",
			setLevelInput,
			({ level, evidence, learnerAgreed }) => {
				refuseIfReturned(branchOf());
				if (level !== "guided" && level !== "half" && level !== "scratch") {
					return { ok: false, error: `Unknown level "${String(level)}". Use guided, half or scratch.` };
				}
				if (!evidence?.trim()) return { ok: false, error: "Give the evidence from the build probe that supports this level." };
				if (learnerAgreed !== true) {
					return { ok: false, error: "The learner has not agreed to a level yet. Propose the level with your reasons, wait for their reply, and call set_level once they agree." };
				}
				const next = update((s) => {
					s.calibration = { level, evidence: evidence.trim(), at: new Date().toISOString() };
				});
				return { ok: true, level: next.calibration!.level, note: "Level recorded. Now shape the build plan to this level and call build_plan." };
			}),

		build_plan: tool("build_plan",
			"Set or replace the build plan: the ordered stages the learner sees in the stage panel. Refused until set_level has recorded the agreed level. Call at the end of the customize phase, then present the plan and wait for the learner's acceptance; re-call to apply requested changes.",
			buildPlanInput,
			({ stages }) => {
				refuseIfReturned(branchOf());
				if (!state().calibration) {
					return {
						ok: false,
						error: "No build level is set. First run the build probe (hands-on questions, one at a time), propose a level (guided / half / scratch) with your reasons, get the learner's yes, then call set_level.",
					};
				}
				const next = update((s) => {
					s.plan = stages.map((st) => ({ title: st.title.trim(), goal: st.goal.trim() }));
				});
				return { ok: true, stages: next.plan.length, active: next.active ? next.active.index + 1 : null };
			}),

		stage_start: tool("stage_start",
			"Pose a stage of the build plan: writes the starter files (only where no file exists yet) and the test file, which is then LOCKED until the stage ends. One stage at a time. The first stage moves the branch from customize to build.",
			stageStartInput,
			(input) => {
				const branch = branchOf();
				refuseIfReturned(branch);
				const current = state();
				if (current.plan.length === 0) return { ok: false, error: "Set the build plan with build_plan first, and get the learner's acceptance." };
				if (current.active) return { ok: false, error: `Stage ${current.active.index + 1} is still active — end it with stage_complete first.` };
				const index = input.stage - 1;
				if (index >= current.plan.length) return { ok: false, error: `The plan has ${current.plan.length} stages; there is no stage ${input.stage}.` };
				const escape = commandEscape(input.testCommand);
				if (escape) return { ok: false, error: `The test command names something outside the workspace folder (${escape}). Use paths relative to the folder.` };
				// Validate every path before writing anything.
				ws.resolveInside(branch.folder, input.testFile.path);
				for (const f of input.starterFiles ?? []) ws.resolveInside(branch.folder, f.path);
				const written: string[] = [];
				const kept: string[] = [];
				for (const f of input.starterFiles ?? []) {
					if (ws.exists(ws.resolveInside(branch.folder, f.path))) kept.push(f.path);
					else {
						ws.writeFile(branch.folder, current, f.path, f.content);
						written.push(f.path);
					}
				}
				const testSha256 = ws.writeTestFile(branch.folder, input.testFile.path, input.testFile.content);
				update((s) => {
					s.active = {
						index,
						hook: input.hook,
						concept: input.concept,
						tests: input.tests,
						...(input.notes ? { notes: input.notes } : {}),
						testPath: input.testFile.path,
						testSha256,
						testCommand: input.testCommand,
					};
				});
				if (branch.phase === "customize") ctx.chatStore.saveBranch(ctx.chatId, { ...branch, phase: "build" });
				return {
					ok: true,
					stage: input.stage,
					title: current.plan[index]!.title,
					starterFilesWritten: written,
					starterFilesKeptExisting: kept,
					lockedTest: input.testFile.path,
				};
			}),

		run_tests: tool("run_tests",
			"Run the active stage's tests (the same run as the learner's Run tests button). Returns pass/fail and the output.",
			emptyInput,
			async () => {
				const branch = branchOf();
				const run = await ws.runStageTests(ctx.chatId, branch.folder, "ai");
				return { ok: true, stage: run.stage + 1, passed: run.passed, exitCode: run.exitCode, timedOut: run.timedOut, output: run.output };
			}),

		stage_complete: tool("stage_complete",
			"End the active stage with its outcome and evidence. Unlocks the test file. The next stage_start may follow.",
			stageCompleteInput,
			({ outcome, evidence }) => {
				refuseIfReturned(branchOf());
				const current = state();
				if (!current.active) return { ok: false, error: "No stage is active." };
				const index = current.active.index;
				const next = update((s) => {
					s.outcomes = [...s.outcomes.filter((o) => o.stage !== index), { stage: index, outcome, evidence, at: new Date().toISOString() }];
					s.active = null;
				});
				const remaining = next.plan.length - next.outcomes.length;
				return { ok: true, stage: index + 1, outcome, stagesRemaining: Math.max(0, remaining) };
			}),

		terminal_run: tool("terminal_run",
			"Run one command in the workspace folder; the learner sees it live in the shared terminal as 'AI ›'. Returns its output and exit code, or running:true if it is still going after waitSeconds (servers keep running). For setup and announced demonstrations — not for doing the learner's work.",
			terminalRunInput,
			async ({ command, waitSeconds }, signal) => {
				refuseIfReturned(branchOf());
				const escape = commandEscape(command);
				if (escape) return { ok: false, error: `The command names something outside the workspace folder (${escape}). Use paths relative to the folder.` };
				if (signal?.aborted) return { ok: false, error: "Aborted." };
				const result = await ctx.terminal().runAiCommand(command, (waitSeconds ?? 20) * 1000);
				return { ok: true, exitCode: result.exitCode, running: result.running, output: result.output };
			}),

		terminal_read: tool("terminal_read",
			"Read the recent shared-terminal transcript: what the learner typed ([YOU typed]), your commands (AI ›), and the output.",
			emptyInput,
			() => ({ ok: true, transcript: ctx.terminal().transcript(0, TERMINAL_READ_LIMIT) || "(the terminal is empty)" })),

		file_list: tool("file_list",
			"List the workspace files (relative paths).",
			emptyInput,
			() => {
				const { entries, truncated } = ws.listFiles(branchOf().folder);
				const active = state().active;
				return {
					ok: true,
					files: entries.map((e) => (e.dir ? `${e.path}/` : `${e.path} (${e.size} bytes)${active && e.path === active.testPath ? " [locked test]" : ""}`)),
					...(truncated ? { truncated: true } : {}),
				};
			}),

		file_read: tool("file_read",
			"Read one workspace file.",
			pathInput,
			({ path }) => ({ ok: true, path, content: tail(ws.readFile(branchOf().folder, path), FILE_READ_LIMIT) })),

		file_write: tool("file_write",
			"Write one workspace file (created with parent folders as needed). The active stage's test file is locked and refused. Never use this to write the learner's solution.",
			fileInput,
			({ path, content }) => {
				const branch = branchOf();
				refuseIfReturned(branch);
				ws.writeFile(branch.folder, state(), path, content);
				return { ok: true, path, bytes: Buffer.byteLength(content, "utf-8") };
			}),

		return_to_lesson: tool("return_to_lesson",
			"End the branch and send the learner back to the lesson with your evidence summary for its teacher. Stops the branch's running processes.",
			returnInput,
			({ summary }) => {
				const branch = branchOf();
				refuseIfReturned(branch);
				const calibration = state().calibration;
				const levelLine = calibration ? `Build level: ${calibration.level} (agreed with the learner; evidence: ${calibration.evidence})\n\n` : "";
				const entry: BuildReturnEntry = {
					id: `ret_${ctx.chatId}`,
					branchId: ctx.chatId,
					nodeId: branch.parentNodeId,
					nodeTitle: branch.parentNodeTitle,
					summary: `${levelLine}${summary.trim()}`,
					createdAt: new Date().toISOString(),
					delivered: false,
				};
				if (!ctx.chatStore.queueBuildReturn(branch.parentChatId, entry)) {
					return { ok: false, error: "The parent lesson no longer exists — there is nowhere to return the summary." };
				}
				update((s) => {
					s.active = null;
				});
				ctx.chatStore.saveBranch(ctx.chatId, { ...branch, phase: "returned", returnedAt: entry.createdAt });
				ctx.stopProcesses?.();
				return { ok: true, returned: true, note: "The learner is being sent back to the lesson. Say one short closing line and end your turn." };
			}),

		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
	});
}
