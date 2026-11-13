/**
 * BUILD BRANCHES — pure helpers (docs/superpowers/specs/
 * 2026-11-13-workspace-practice-branch-design.md).
 *
 * A build branch is a child session opened from a teaching step: the learner
 * builds the concept with their own hands in a real workspace folder, coached
 * stage by stage (CodeCrafters-style), then returns an evidence summary to
 * the lesson. This module owns the side-effect-free parts: path confinement,
 * the command guard, the parent-lesson context the coach starts from, and
 * the marker constructors. Filesystem/process work lives in src/server.
 * Client-safe: no node: imports (the transcript UI reads nodeAtMessage).
 *
 * CONFINEMENT IS A MISTAKE-CATCHER, NOT A SECURITY BOUNDARY: the coach's
 * prompt forbids leaving the folder; these checks refuse the obvious ways a
 * command or file path names something outside it. A determined command can
 * still escape (shell expansion, scripts) — the UI and docs say so.
 */

import type { BuildBranch, ChatRecord } from "./contracts/chat.ts";
import { newMessageId, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";

/** A refused workspace operation (path outside the folder, locked test,
 *  missing file). Tools report its message to the model; routes map it
 *  to 400. */
export class WorkspaceError extends Error {}

// ─── stage state (persisted by the server beside the branch) ────────────────

export interface BuildStage {
	title: string;
	/** One line: what the learner will make happen. */
	goal: string;
}

export type BuildStageOutcome = "passed" | "passed-shaky" | "skipped";

export interface BuildTestRun {
	at: string;
	stage: number;
	by: "you" | "ai";
	passed: boolean;
	exitCode: number | null;
	/** Bounded, ANSI-free tail of the run's output. */
	output: string;
	timedOut: boolean;
}

/** A learner/AI workspace event the coach has not yet seen. */
export interface BuildWorkspaceEvent {
	seq: number;
	at: string;
	by: "you" | "ai";
	kind: "file-saved" | "test-run";
	detail: string;
}

export interface BuildActiveStage {
	index: number;
	hook: string;
	concept: string;
	tests: string;
	notes?: string;
	testPath: string;
	testSha256: string;
	testCommand: string;
}

export interface BuildState {
	plan: BuildStage[];
	active: BuildActiveStage | null;
	outcomes: Array<{ stage: number; outcome: BuildStageOutcome; evidence: string; at: string }>;
	runs: BuildTestRun[];
	events: BuildWorkspaceEvent[];
	/** Events and terminal output up to these sequence numbers were already
	 *  handed to the coach (build-activity markers). */
	seenEventSeq: number;
	seenTerminalSeq: number;
	/** The terminal instance the seq belongs to (a server restart starts a
	 *  new terminal whose numbering restarts). */
	seenTerminalEpoch?: string;
}

export function emptyBuildState(): BuildState {
	return { plan: [], active: null, outcomes: [], runs: [], events: [], seenEventSeq: 0, seenTerminalSeq: 0 };
}

// ─── naming ──────────────────────────────────────────────────────────────────

/** Folder-name-safe slug (ASCII letters, digits, dash). */
export function slug(value: string, fallback: string): string {
	const s = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	return s || fallback;
}

/** `<parentChatId>-<nodeId|start>-<n>` — the spec's folder layout. */
export function branchFolderName(parentChatId: string, nodeId: string | null, n: number): string {
	return `${slug(parentChatId, "chat")}-${nodeId ? slug(nodeId, "step") : "start"}-${n}`;
}

// ─── path confinement ────────────────────────────────────────────────────────

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;
const HOME_REFERENCE = /^(?:~|\$HOME\b|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE)/i;
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** True when a supplied path is absolute (POSIX or Windows) or
 *  home-relative — never acceptable as a workspace path. Containment of
 *  relative paths (`..`, symlinks) is the server's resolveInside. */
export function isAbsoluteOrHome(rel: string): boolean {
	const raw = rel.trim();
	return raw.startsWith("/") || WINDOWS_ABSOLUTE.test(raw) || HOME_REFERENCE.test(raw);
}

/** Device paths a command may name without leaving the folder. */
const ALLOWED_ABSOLUTE = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);

function stripQuotes(token: string): string {
	return token.replace(/^['"]+|['"]+$/g, "");
}

function escapingPathToken(token: string): boolean {
	const t = stripQuotes(token);
	if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URLs (http://localhost:5000/chat)
	if (ALLOWED_ABSOLUTE.has(t)) return false;
	if (t.startsWith("/") || WINDOWS_ABSOLUTE.test(t) || HOME_REFERENCE.test(t)) return true;
	return PARENT_SEGMENT.test(t);
}

/**
 * The coach's command guard. Returns the first offending token (absolute
 * path, home reference, `..` segment, bare `cd`), or null when the command
 * only names things relative to the working folder. Option values
 * (`--file=/x`) are checked too.
 */
export function commandEscape(command: string): string | null {
	const tokens = command.split(/[\s;|&()<>`]+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const candidates = [token];
		const eq = token.indexOf("=");
		if (eq > 0) candidates.push(token.slice(eq + 1));
		for (const candidate of candidates) if (escapingPathToken(candidate)) return stripQuotes(candidate);
	}
	// A bare `cd` (or `cd` as the last word) changes to the home directory.
	if (/(?:^|[;&|]\s*)cd\s*(?:$|[;&|])/.test(command.trim())) return "cd";
	return null;
}

// ─── the parent-lesson context the coach starts from ────────────────────────

const LESSON_TEXT_LIMIT = 16_000;
const TEACHING_CALLS = new Set(["quiz", "explain"]);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
		.map((b) => b.text)
		.join("\n");
}

function nodeIdOf(args: unknown): string | null {
	const id = (args as { nodeId?: unknown } | null)?.nodeId;
	return typeof id === "string" && id ? id : null;
}

/** The plan node a transcript message belongs to: the last node-tagged
 *  teaching call at or before it. Null before the plan's first step. */
export function nodeAtMessage(messages: readonly LhMessage[], messageId: string): string | null {
	let current: string | null = null;
	for (const m of messages) {
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "toolCall" && TEACHING_CALLS.has(block.name)) current = nodeIdOf(block.arguments) ?? current;
			}
		}
		if (m.id === messageId) return current;
	}
	return current;
}

function describeCall(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ["question", "prompt", "explanation"]) {
		if (typeof a[key] === "string" && a[key]) parts.push(`${key}: ${a[key] as string}`);
	}
	if (Array.isArray(a.options)) {
		const labels = a.options.map((o) => (o && typeof o === "object" ? (o as { label?: unknown }).label : o)).filter((l) => typeof l === "string");
		if (labels.length) parts.push(`options: ${labels.join(" | ")}`);
	}
	return `[${name}] ${parts.join("\n")}`.trim();
}

/** The learner's first message — the lesson's stated goal. */
function lessonGoal(messages: readonly LhMessage[]): string {
	for (const m of messages) if (m.role === "user") return textOf(m.content).trim();
	return "";
}

function probeAssessment(messages: readonly LhMessage[]): string {
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.name !== "probe_done") continue;
			const assessment = (block.arguments as { assessment?: { strands?: unknown; summary?: unknown } } | null)?.assessment;
			const strands = Array.isArray(assessment?.strands) ? assessment!.strands as Array<{ strand?: unknown; assessment?: unknown }> : [];
			const lines = strands
				.filter((s) => typeof s?.strand === "string")
				.map((s) => `- ${s.strand as string}: ${typeof s.assessment === "string" ? s.assessment : ""}`);
			if (typeof assessment?.summary === "string" && assessment.summary) lines.push(`Summary: ${assessment.summary}`);
			return lines.join("\n");
		}
	}
	return "";
}

/**
 * The context a build coach starts from: the lesson goal, the main
 * session's probe assessment (never re-probed), the plan, the step the
 * learner branched at, and the lesson as taught up to and including that
 * step (bounded to its most recent part).
 */
export function buildContextText(parent: Pick<ChatRecord, "messages" | "tree" | "title">, nodeId: string | null): { text: string; nodeTitle: string } {
	const nodes = parent.tree?.nodes ?? [];
	const node = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
	const nodeTitle = node?.title ?? (nodeId ?? "Lesson start");

	// Lesson text through the LAST message tagged with the node (or all of it).
	const messages = parent.messages;
	let end = messages.length;
	if (nodeId) {
		let lastTagged = -1;
		messages.forEach((m, i) => {
			if (m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && TEACHING_CALLS.has(b.name) && nodeIdOf(b.arguments) === nodeId)) lastTagged = i;
		});
		if (lastTagged >= 0) end = lastTagged + 1;
	}
	const lesson: string[] = [];
	for (const m of messages.slice(0, end)) {
		if (m.role === "user") {
			const t = textOf(m.content).trim();
			if (t) lesson.push(`LEARNER: ${t}`);
		} else if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "text" && block.text.trim()) lesson.push(`TUTOR: ${block.text.trim()}`);
				else if (block.type === "toolCall" && (TEACHING_CALLS.has(block.name) || block.name === "probe")) lesson.push(`TUTOR ${describeCall(block.name, block.arguments)}`);
			}
		}
	}
	let lessonText = lesson.join("\n\n");
	if (lessonText.length > LESSON_TEXT_LIMIT) lessonText = `[…earlier lesson text omitted…]\n${lessonText.slice(-LESSON_TEXT_LIMIT)}`;

	const sections = [
		"[Build branch context] — the learner opened this hands-on build branch from their lesson. This is injected session context, not the learner speaking.",
		`Lesson: ${parent.title}`,
		`Lesson goal (the learner's opening message):\n${lessonGoal(messages) || "(none recorded)"}`,
		`Main session probe assessment (already established — do not re-probe these):\n${probeAssessment(messages) || "(the main session has no probe assessment yet)"}`,
		nodes.length ? `Lesson plan:\n${nodes.map((n) => `- ${n.id}: ${n.title}${n.summary ? ` — ${n.summary}` : ""}`).join("\n")}` : "Lesson plan: (none yet)",
		`Branched at step: ${nodeTitle}${nodeId ? ` (${nodeId})` : ""}`,
		`The lesson so far, up to that step:\n${lessonText || "(nothing taught yet)"}`,
	];
	return { text: sections.join("\n\n"), nodeTitle };
}

// ─── markers ─────────────────────────────────────────────────────────────────

/** message[0] of a build session: the parent context. Displayed as a
 *  collapsible card; flattened to user-role text for the model. */
export function newBuildContextMessage(text: string, branch: BuildBranch): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "build-context",
		content: text,
		display: true,
		details: { parentChatId: branch.parentChatId, nodeId: branch.parentNodeId, nodeTitle: branch.parentNodeTitle, folder: branch.folder },
		timestamp: Date.now(),
	};
}

/** Workspace activity since the coach's last turn (terminal lines, saves,
 *  test runs). Model-facing only. */
export function newBuildActivityMessage(text: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "build-activity",
		content: text,
		display: false,
		details: null,
		timestamp: Date.now(),
	};
}

/** A returned branch's evidence summary, delivered into the parent lesson. */
export function newBuildReturnMessage(entry: { branchId: string; nodeId: string | null; nodeTitle: string; summary: string }): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "build-return",
		content: [
			`[Build branch returned] — the learner practised "${entry.nodeTitle}" hands-on in a build branch. The coach's evidence summary follows (injected context, not the learner speaking).`,
			"Use it to repair gaps or move faster; do not re-teach what the evidence shows is solid.",
			"",
			entry.summary,
		].join("\n"),
		display: true,
		details: { branchId: entry.branchId, nodeId: entry.nodeId, nodeTitle: entry.nodeTitle, summary: entry.summary },
		timestamp: Date.now(),
	};
}

/** Strip ANSI escape sequences and carriage-return overwrites. */
export function stripAnsi(text: string): string {
	return text
		// eslint-disable-next-line no-control-regex
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		// eslint-disable-next-line no-control-regex
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		// eslint-disable-next-line no-control-regex
		.replace(/\u001b[@-Z\\-_]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/[^\n]*\r(?!\n)/g, "");
}

/** Keep the last `limit` characters, marking the cut. */
export function tail(text: string, limit: number): string {
	return text.length <= limit ? text : `[…${text.length - limit} earlier characters omitted…]\n${text.slice(-limit)}`;
}
