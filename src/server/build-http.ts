/**
 * BUILD BRANCH HTTP SEAM (2026-11-13 — docs/superpowers/specs/
 * 2026-11-13-workspace-practice-branch-design.md). The framework routes
 * under app/api/chats/[id]/build and /workspace are thin wrappers over
 * these handlers (the import law: logic lives in the server seam, tests
 * drive it directly). Same-origin/host checks are the API proxy's.
 */

import { buildContextText, newBuildContextMessage, WorkspaceError } from "../core/build-branch.ts";
import type { BuildBranch, ChatRecord } from "../core/contracts/chat.ts";
import { emit } from "../core/events.ts";
import { readSettings as readSettingsRecord } from "../store/settings.ts";
import { stores } from "./stores.ts";
import {
	allocateFolder,
	listFiles,
	readState,
	readWorkspaceFile,
	recordEvent,
	runStageTests,
	updateState,
	writeWorkspaceFile,
	isLockedTest,
} from "./build-workspace.ts";
import { existingTerminal, terminalFor } from "./build-terminal.ts";
import { buildShellKind, shellLabel } from "./build-shell.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const MAX_INPUT_BYTES = 64 * 1024;

function buildChat(id: string): { chat: ChatRecord & { branch: BuildBranch } } | { error: Response } {
	const chat = stores.chatStore.getChat(id);
	if (!chat) return { error: json({ error: "Not found" }, 404) };
	if (chat.kind !== "build" || !chat.branch) return { error: json({ error: "Not a build branch" }, 400) };
	return { chat: chat as ChatRecord & { branch: BuildBranch } };
}

function closed(chat: { branch: BuildBranch }): Response | null {
	return chat.branch.phase === "returned" ? json({ error: "This branch has returned to the lesson." }, 409) : null;
}

function workspaceError(err: unknown): Response {
	if (err instanceof WorkspaceError) return json({ error: err.message }, 400);
	throw err;
}

// ─── branches of a lesson ────────────────────────────────────────────────────

/** POST /api/chats/:id/build — open a build branch from a teaching step. */
export async function createBuildBranchResponse(parentId: string, req: Request): Promise<Response> {
	const parent = stores.chatStore.getChat(parentId);
	if (!parent) return json({ error: "Not found" }, 404);
	if ((parent.kind ?? "teach") !== "teach") return json({ error: "Build branches open from teaching sessions." }, 400);
	const body = (await req.json().catch(() => ({}))) as { nodeId?: unknown };
	const nodeId = typeof body.nodeId === "string" && body.nodeId ? body.nodeId : null;
	if (nodeId && !parent.tree?.nodes.some((n) => n.id === nodeId)) return json({ error: `Unknown plan step: ${nodeId}` }, 400);

	const { text, nodeTitle } = buildContextText(parent, nodeId);
	const folder = allocateFolder(parent.id, nodeId);
	const branch: BuildBranch = { parentChatId: parent.id, parentNodeId: nodeId, parentNodeTitle: nodeTitle, folder, phase: "customize" };
	const chat = stores.chatStore.createChat(`Build · ${nodeTitle}`.slice(0, 120), "build", branch);
	// The branch keeps the lesson's model; a lesson without one falls back
	// to the strong slot, exactly like a new session.
	const strong = readSettingsRecord()?.models?.strong;
	const settings = parent.settings?.model
		? parent.settings
		: strong?.model ? { model: { provider: strong.model.provider, id: strong.model.id }, thinkingLevel: strong.thinkingLevel } : null;
	if (settings) stores.chatStore.saveSettings(chat.id, settings);
	stores.chatStore.saveMessages(chat.id, [newBuildContextMessage(text, branch)]);
	emit("chats-changed", {});
	return json({ id: chat.id, title: chat.title, folder });
}

/** GET /api/chats/:id/build — the lesson's branches (newest first). */
export function listBuildBranchesResponse(parentId: string): Response {
	if (!stores.chatStore.getChat(parentId)) return json({ error: "Not found" }, 404);
	const branches = stores.chatStore
		.listChats()
		.flatMap((c) => c.branch?.parentChatId === parentId
			? [{ id: c.id, title: c.title, nodeId: c.branch.parentNodeId, nodeTitle: c.branch.parentNodeTitle, phase: c.branch.phase, updatedAt: c.updatedAt }]
			: []);
	return json({ branches });
}

// ─── the workspace ───────────────────────────────────────────────────────────

/** GET /api/chats/:id/workspace — branch, stages, recent runs, files. */
export function workspaceStateResponse(id: string): Response {
	const found = buildChat(id);
	if ("error" in found) return found.error;
	const { branch } = found.chat;
	const state = readState(id);
	const { entries, truncated } = listFiles(branch.folder);
	const terminal = existingTerminal(id);
	return json({
		branch,
		shell: shellLabel(buildShellKind()),
		plan: state.plan,
		active: state.active && {
			index: state.active.index,
			hook: state.active.hook,
			concept: state.active.concept,
			tests: state.active.tests,
			notes: state.active.notes ?? null,
			testPath: state.active.testPath,
			testCommand: state.active.testCommand,
		},
		outcomes: state.outcomes,
		runs: state.runs.slice(-5),
		files: entries,
		filesTruncated: truncated,
		terminal: { started: !!terminal, native: terminal?.native ?? null, aiRunning: terminal?.runningAiProcesses ?? 0 },
	});
}

/** GET /api/chats/:id/workspace/file?path= */
export function readFileResponse(id: string, url: URL): Response {
	const found = buildChat(id);
	if ("error" in found) return found.error;
	const rel = url.searchParams.get("path") ?? "";
	try {
		const content = readWorkspaceFile(found.chat.branch.folder, rel);
		return json({ path: rel, content, locked: isLockedTest(found.chat.branch.folder, readState(id), rel) });
	} catch (err) {
		return workspaceError(err);
	}
}

/** PUT /api/chats/:id/workspace/file {path, content} — the learner saves. */
export async function writeFileResponse(id: string, req: Request): Promise<Response> {
	const found = buildChat(id);
	if ("error" in found) return found.error;
	const refusal = closed(found.chat);
	if (refusal) return refusal;
	const body = (await req.json().catch(() => null)) as { path?: unknown; content?: unknown } | null;
	if (!body || typeof body.path !== "string" || typeof body.content !== "string") return json({ error: "Expected {path, content}" }, 400);
	const rel = body.path;
	const content = body.content;
	try {
		updateState(id, (state) => {
			writeWorkspaceFile(found.chat.branch.folder, state, rel, content);
			recordEvent(state, "you", "file-saved", `Saved ${rel} (${content.split("\n").length} lines)`);
		});
		return json({ ok: true });
	} catch (err) {
		return workspaceError(err);
	}
}

/** POST /api/chats/:id/workspace/tests — the learner's Run tests. */
export async function runTestsResponse(id: string): Promise<Response> {
	const found = buildChat(id);
	if ("error" in found) return found.error;
	const refusal = closed(found.chat);
	if (refusal) return refusal;
	try {
		const run = await runStageTests(id, found.chat.branch.folder, "you");
		return json({ run });
	} catch (err) {
		return workspaceError(err);
	}
}

// ─── the terminal ────────────────────────────────────────────────────────────

/** GET /api/chats/:id/workspace/terminal — SSE: replay, then live chunks. */
export function terminalStreamResponse(id: string, req: Request): Response {
	const found = buildChat(id);
	if ("error" in found) return found.error;
	const { branch } = found.chat;
	const terminal = terminalFor(id, branch.folder);
	if (branch.phase !== "returned") terminal.ensureShell();
	const encoder = new TextEncoder();
	let teardown: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let done = false;
			let unsubscribe: (() => void) | undefined;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			const stop = () => {
				if (done) return;
				done = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			const frame = (chunk: string) => {
				if (done) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					stop();
				}
			};
			const sub = terminal.subscribe((chunk) => frame(`data: ${JSON.stringify({ seq: chunk.seq, text: chunk.text })}\n\n`));
			unsubscribe = sub.unsubscribe;
			frame(`event: replay\ndata: ${JSON.stringify({ text: sub.replay.map((c) => c.text).join(""), native: terminal.native })}\n\n`);
			heartbeat = setInterval(() => frame(": ping\n\n"), 25_000);
			req.signal?.addEventListener("abort", stop, { once: true });
			teardown = stop;
		},
		cancel() {
			teardown?.();
		},
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}

/** POST /api/chats/:id/workspace/terminal — {data} keystrokes or {cols, rows}. */
export async function terminalInputResponse(id: string, req: Request): Promise<Response> {
	const found = buildChat(id);
	if ("error" in found) return found.error;
	const refusal = closed(found.chat);
	if (refusal) return refusal;
	const body = (await req.json().catch(() => null)) as { data?: unknown; cols?: unknown; rows?: unknown } | null;
	if (!body) return json({ error: "Expected JSON" }, 400);
	const terminal = terminalFor(id, found.chat.branch.folder);
	if (typeof body.data === "string") {
		if (Buffer.byteLength(body.data, "utf-8") > MAX_INPUT_BYTES) return json({ error: "Input too large" }, 413);
		terminal.write(body.data);
	}
	if (typeof body.cols === "number" && typeof body.rows === "number") terminal.resize(body.cols, body.rows);
	return json({ ok: true });
}
