"use client";

import { useState } from "react";
import { FolderCodeIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { blurAfterPointerClick } from "@/components/focus-hygiene";

/** What the open-folder route answers (app/api/chats/[id]/workspace). */
export interface WorkspaceOpenReply {
	ok?: boolean;
	path?: string;
	error?: string;
}

/** Ask the server to open the chat's folder in the learner's editor.
 *  Resolves null when the editor started, or the note to show when it did
 *  not (the folder path is always in it, so the learner can open it by
 *  hand). Never throws. */
export async function openWorkspace(chatId: string, fallbackPath: string, fetchLike: typeof fetch = fetch): Promise<{ path: string; reason: string } | null> {
	try {
		const res = await fetchLike(`/api/chats/${chatId}/workspace`, { method: "POST" });
		const reply = (await res.json().catch(() => null)) as WorkspaceOpenReply | null;
		if (res.ok && reply?.ok === true) return null;
		return { path: reply?.path ?? fallbackPath, reason: reply?.error ?? "The folder could not be opened." };
	} catch {
		return { path: fallbackPath, reason: "The app could not be reached." };
	}
}

/**
 * The chat's folder control in the top bar: one click opens the folder in
 * VS Code. When the editor cannot be started (its `code` launcher is not
 * installed on PATH), a small note shows the folder path instead, so the
 * learner is never left without a way in.
 */
export function WorkspaceChip({ chatId, workspaceDir }: { chatId: string; workspaceDir: string }) {
	const [opening, setOpening] = useState(false);
	const [note, setNote] = useState<{ path: string; reason: string } | null>(null);

	const open = async () => {
		if (opening) return;
		setOpening(true);
		setNote(null);
		setNote(await openWorkspace(chatId, workspaceDir));
		setOpening(false);
	};

	return (
		<span className="lh-no-drag relative flex shrink-0">
			<Hint label="Open this chat's folder in VS Code" side="bottom">
				<button
					type="button"
					data-testid="workspace-chip"
					disabled={opening}
					onClick={(e) => {
						blurAfterPointerClick(e);
						void open();
					}}
					className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-60"
				>
					<FolderCodeIcon className="size-3.5 text-primary" aria-hidden />
					{opening ? "Opening…" : "VS Code"}
				</button>
			</Hint>
			{note && (
				<div
					role="alert"
					data-testid="workspace-note"
					className="absolute right-0 top-full z-50 mt-2 flex w-80 flex-col gap-2 rounded-md border border-border bg-card p-3 text-xs shadow-lg"
				>
					<p className="text-foreground">VS Code did not open. Open this folder yourself:</p>
					<p data-testid="workspace-note-path" className="select-all break-all rounded-sm bg-background px-2 py-1 font-mono text-muted-foreground">{note.path}</p>
					<p className="text-muted-foreground">{note.reason}</p>
					<button
						type="button"
						onClick={() => setNote(null)}
						className="self-end rounded-sm border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
					>
						Close
					</button>
				</div>
			)}
		</span>
	);
}
