"use client";

/**
 * THE BUILD WORKSPACE PANEL (2026-11-13 — docs/superpowers/specs/
 * 2026-11-13-workspace-practice-branch-design.md): beside the coach chat
 * of a build session — the stage plan and active stage, the file list, the
 * editor, the shared terminal, Run tests and Done.
 *
 * State is polled from GET /workspace (cheap, local); actions refresh it
 * immediately. A clean open file reloads when it changes on disk (the
 * coach wrote it); a dirty one is never clobbered.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
	CheckCircle2Icon,
	CircleDashedIcon,
	CircleDotIcon,
	FileIcon,
	FolderIcon,
	LockIcon,
	PlayIcon,
	SaveIcon,
	SkipForwardIcon,
	TriangleAlertIcon,
	Undo2Icon,
	XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CodeEditor } from "./code-editor";
import { TerminalView } from "./terminal-view";

interface WorkspaceFile {
	path: string;
	dir: boolean;
	size: number;
	mtimeMs: number;
}

interface WorkspaceState {
	branch: { parentChatId: string; parentNodeTitle: string; folder: string; phase: "customize" | "build" | "returned" };
	shell: string;
	level: "guided" | "half" | "scratch" | null;
	plan: Array<{ title: string; goal: string }>;
	active: { index: number; hook: string; concept: string; tests: string; notes: string | null; testPath: string; testCommand: string } | null;
	outcomes: Array<{ stage: number; outcome: "passed" | "passed-shaky" | "skipped"; evidence: string }>;
	runs: Array<{ at: string; stage: number; by: "you" | "ai"; passed: boolean; exitCode: number | null; output: string; timedOut: boolean }>;
	files: WorkspaceFile[];
	filesTruncated: boolean;
}

const POLL_MS = 2000;
export const BUILD_DONE_PROMPT = "I'm done with this build — please wrap up and send me back to the lesson.";

export function WorkspacePanel({ chatId, busy, onDone }: { chatId: string; busy: boolean; onDone: () => void }) {
	const router = useRouter();
	const [state, setState] = useState<WorkspaceState | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [doc, setDoc] = useState<{ key: string; path: string; saved: string; mtimeMs: number; locked: boolean } | null>(null);
	const [draft, setDraft] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);
	const [showRun, setShowRun] = useState(false);
	const docSeq = useRef(0);
	const base = `/api/chats/${encodeURIComponent(chatId)}/workspace`;

	const refresh = useCallback(async (): Promise<WorkspaceState | null> => {
		try {
			const res = await fetch(base, { cache: "no-store" });
			if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
			const next = (await res.json()) as WorkspaceState;
			setState(next);
			setLoadError(null);
			return next;
		} catch (err) {
			setLoadError((err as Error).message);
			return null;
		}
	}, [base]);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), POLL_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	const dirty = doc !== null && draft !== doc.saved;
	const files = useMemo(() => state?.files.filter((f) => !f.dir) ?? [], [state]);

	const openFile = useCallback(async (path: string, mtimeMs: number) => {
		const res = await fetch(`${base}/file?path=${encodeURIComponent(path)}`, { cache: "no-store" });
		const body = (await res.json().catch(() => ({}))) as { content?: string; locked?: boolean; error?: string };
		if (!res.ok || typeof body.content !== "string") {
			setNotice(body.error ?? `Could not open ${path}`);
			return;
		}
		setDoc({ key: `${path}#${++docSeq.current}`, path, saved: body.content, mtimeMs, locked: !!body.locked });
		setDraft(body.content);
		setSelected(path);
	}, [base]);

	// Pick a first file; reload a clean open file that changed on disk.
	useEffect(() => {
		if (!state) return;
		if (!selected) {
			const first = files.find((f) => !/(^|\/)tests?\//.test(f.path) && !/test/i.test(f.path)) ?? files[0];
			if (first) void openFile(first.path, first.mtimeMs);
			return;
		}
		const entry = files.find((f) => f.path === selected);
		if (!entry) return;
		const locked = state.active?.testPath === selected;
		if (doc && doc.path === selected && !dirty && (entry.mtimeMs !== doc.mtimeMs || locked !== doc.locked)) void openFile(selected, entry.mtimeMs);
	}, [state, files, selected, doc, dirty, openFile]);

	const save = useCallback(async () => {
		if (!doc || doc.locked || !dirty) return;
		const content = draft;
		const res = await fetch(`${base}/file`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: doc.path, content }) });
		if (!res.ok) {
			setNotice(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Save failed");
			return;
		}
		setNotice(null);
		// Adopt the server's mtime for the saved file so the poll does not
		// mistake our own save for an outside change (and reset the editor).
		const next = await refresh();
		const mtimeMs = next?.files.find((f) => f.path === doc.path)?.mtimeMs ?? doc.mtimeMs;
		setDoc((d) => (d && d.path === doc.path ? { ...d, saved: content, mtimeMs } : d));
	}, [base, doc, dirty, draft, refresh]);

	const runTests = useCallback(async () => {
		if (testing) return;
		if (dirty) await save();
		setTesting(true);
		try {
			const res = await fetch(`${base}/tests`, { method: "POST" });
			if (!res.ok) setNotice(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Tests could not run");
			else setShowRun(true);
		} finally {
			setTesting(false);
			void refresh();
		}
	}, [base, dirty, refresh, save, testing]);

	const returned = state?.branch.phase === "returned";
	// After the coach returns the branch, go back once its closing turn ends.
	useEffect(() => {
		if (!returned || busy || !state) return;
		const timer = setTimeout(() => router.push(`/chat/${encodeURIComponent(state.branch.parentChatId)}`), 3500);
		return () => clearTimeout(timer);
	}, [returned, busy, state, router]);

	if (!state) {
		return (
			<aside className="flex w-[56%] min-w-[480px] shrink-0 items-center justify-center border-l border-border text-sm text-muted-foreground">
				{loadError ? `Workspace unavailable: ${loadError}` : "Opening the workspace…"}
			</aside>
		);
	}

	const outcomeOf = (index: number) => state.outcomes.find((o) => o.stage === index)?.outcome;
	const lastRun = state.runs.at(-1);

	return (
		<aside data-testid="build-workspace" className="flex w-[56%] min-w-[480px] shrink-0 flex-col border-l border-border bg-background">
			{/* Header: where this is, Run tests, Done */}
			<div className="flex h-15 shrink-0 items-center gap-2 border-b border-border px-3">
				<div className="min-w-0 flex-1">
					<div className="truncate font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
						Workspace · {state.shell} · {state.branch.phase === "customize" ? (state.level ? "planning the build" : "finding your level") : state.branch.phase}
						{state.level && <span data-testid="build-level"> · level: {state.level}</span>}
					</div>
					<div className="truncate font-mono text-[11px] text-muted-foreground/80" title={state.branch.folder}>{state.branch.folder}</div>
				</div>
				<Button size="sm" variant="outline" disabled={!state.active || testing || returned} onClick={() => void runTests()} data-testid="build-run-tests">
					<PlayIcon className="size-3.5" /> {testing ? "Running…" : "Run tests"}
				</Button>
				<Button size="sm" disabled={busy || returned} onClick={onDone} data-testid="build-done">
					<Undo2Icon className="size-3.5" /> Done
				</Button>
			</div>

			{returned && (
				<div className="flex shrink-0 items-center gap-2 border-b border-border bg-primary/10 px-3 py-2 text-sm">
					<CheckCircle2Icon className="size-4 text-primary" />
					<span className="flex-1">This build has returned to the lesson.</span>
					<Button size="xs" variant="outline" onClick={() => router.push(`/chat/${encodeURIComponent(state.branch.parentChatId)}`)}>Back to lesson</Button>
				</div>
			)}

			{/* Stages */}
			<div className="shrink-0 border-b border-border px-3 py-2" data-testid="build-stages">
				{state.plan.length === 0 ? (
					<p className="text-xs text-muted-foreground">No build plan yet — the coach first checks what you can build (a few short questions), agrees a level with you, then plans the stages.</p>
				) : (
					<ol className="flex flex-wrap gap-1.5">
						{state.plan.map((stage, i) => {
							const outcome = outcomeOf(i);
							const active = state.active?.index === i;
							const Icon = active ? CircleDotIcon : outcome === "passed" ? CheckCircle2Icon : outcome === "passed-shaky" ? TriangleAlertIcon : outcome === "skipped" ? SkipForwardIcon : CircleDashedIcon;
							return (
								<li
									key={i}
									title={stage.goal}
									className={cn(
										"flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
										active ? "border-primary text-foreground" : outcome ? "border-border text-muted-foreground" : "border-dashed border-border text-muted-foreground/70",
									)}
								>
									<Icon className={cn("size-3", active && "text-primary", outcome === "passed" && "text-emerald-500", outcome === "passed-shaky" && "text-amber-500")} />
									{i + 1}. {stage.title}
								</li>
							);
						})}
					</ol>
				)}
				{state.active && (
					<div className="mt-2 space-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs" data-testid="build-active-stage">
						<div className="font-medium text-foreground">Stage {state.active.index + 1}: {state.active.hook}</div>
						<div className="text-muted-foreground"><span className="font-medium text-foreground/80">Concept · </span>{state.active.concept}</div>
						<div className="text-muted-foreground"><span className="font-medium text-foreground/80">Tests · </span>{state.active.tests}</div>
						{state.active.notes && <div className="text-muted-foreground"><span className="font-medium text-foreground/80">Notes · </span>{state.active.notes}</div>}
					</div>
				)}
			</div>

			{/* Files + editor */}
			<div className="flex min-h-0 flex-1">
				<nav className="w-44 shrink-0 overflow-y-auto border-r border-border py-1 text-xs" data-testid="build-files">
					{state.files.length === 0 && <p className="px-3 py-2 text-muted-foreground">No files yet.</p>}
					{state.files.map((f) => {
						const depth = f.path.split("/").length - 1;
						const name = f.path.split("/").pop();
						const isTest = state.active?.testPath === f.path;
						return f.dir ? (
							<div key={f.path} className="flex items-center gap-1 px-2 py-0.5 text-muted-foreground" style={{ paddingLeft: 8 + depth * 12 }}>
								<FolderIcon className="size-3 shrink-0" /> {name}
							</div>
						) : (
							<button
								key={f.path}
								type="button"
								onClick={() => {
									if (dirty && !window.confirm(`Discard unsaved changes to ${doc?.path}?`)) return;
									void openFile(f.path, f.mtimeMs);
								}}
								className={cn("flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-accent", selected === f.path && "bg-accent text-foreground")}
								style={{ paddingLeft: 8 + depth * 12 }}
							>
								{isTest ? <LockIcon className="size-3 shrink-0 text-amber-500" /> : <FileIcon className="size-3 shrink-0 text-muted-foreground" />}
								<span className="truncate">{name}</span>
							</button>
						);
					})}
					{state.filesTruncated && <p className="px-3 py-1 text-muted-foreground">…more files not shown</p>}
				</nav>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
						<span className="truncate font-mono">{doc?.path ?? "—"}{dirty ? " •" : ""}</span>
						{doc?.locked && <span className="flex items-center gap-1 text-amber-500"><LockIcon className="size-3" /> locked test</span>}
						<span className="flex-1" />
						{notice && <span className="truncate text-destructive" title={notice}>{notice}</span>}
						<Button size="xs" variant="ghost" disabled={!dirty || doc?.locked || returned} onClick={() => void save()} title="Save (Ctrl/Cmd+S)">
							<SaveIcon className="size-3" /> Save
						</Button>
					</div>
					<div className="min-h-0 flex-1">
						{doc ? (
							<CodeEditor docKey={doc.key} path={doc.path} value={doc.saved} readOnly={doc.locked || returned} onChange={setDraft} onSave={() => void save()} />
						) : (
							<p className="p-4 text-xs text-muted-foreground">Files the coach creates for a stage appear on the left.</p>
						)}
					</div>
				</div>
			</div>

			{/* Last test run */}
			{lastRun && (
				<div className="shrink-0 border-t border-border text-xs">
					<button type="button" onClick={() => setShowRun((v) => !v)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent">
						{lastRun.passed ? <CheckCircle2Icon className="size-3.5 text-emerald-500" /> : <XCircleIcon className="size-3.5 text-destructive" />}
						<span className="font-medium">Stage {lastRun.stage + 1} tests {lastRun.passed ? "passed" : "failed"}</span>
						<span className="text-muted-foreground">· run by {lastRun.by === "you" ? "you" : "the coach"}</span>
					</button>
					{showRun && <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-muted/40 px-3 py-2 font-mono text-[11px]">{lastRun.output || "(no output)"}</pre>}
				</div>
			)}

			{/* Terminal */}
			<div className="h-[36%] min-h-40 shrink-0 border-t border-border">
				<TerminalView chatId={chatId} readOnly={returned} />
			</div>
		</aside>
	);
}
