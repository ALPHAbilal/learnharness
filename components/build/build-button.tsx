"use client";

/**
 * "Build it yourself" — the entry to a build branch from any lesson step
 * (2026-11-13, docs/superpowers/specs/2026-11-13-workspace-practice-branch-design.md).
 * Opens a child build session tied to the step's plan node and navigates
 * to it with an opening line, so the coach speaks first. Existing branches
 * opened from the same message show as small chips beside it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HammerIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface BuildBranchSummary {
	id: string;
	title: string;
	nodeId: string | null;
	nodeTitle: string;
	messageId: string | null;
	phase: "customize" | "build" | "returned";
}

export const BUILD_OPENING_PROMPT = "I want to build this step myself. Let's set up the build.";

export function BuildButton({
	chatId,
	messageId,
	nodeId,
	branches,
	disabled,
}: {
	chatId: string;
	messageId: string;
	nodeId: string | null;
	branches: readonly BuildBranchSummary[];
	disabled?: boolean;
}) {
	const router = useRouter();
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const open = async () => {
		if (opening) return;
		setOpening(true);
		setError(null);
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/build`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nodeId, messageId }),
			});
			const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
			if (!res.ok || !body.id) throw new Error(body.error ?? `Could not open a build branch (${res.status})`);
			router.push(`/chat/${encodeURIComponent(body.id)}?prompt=${encodeURIComponent(BUILD_OPENING_PROMPT)}`);
		} catch (err) {
			setError((err as Error).message);
			setOpening(false);
		}
	};
	return (
		<span className="inline-flex items-center gap-1" data-testid="build-entry">
			{branches.map((b) => (
				<a
					key={b.id}
					href={`/chat/${encodeURIComponent(b.id)}`}
					onClick={(event) => {
						event.preventDefault();
						router.push(`/chat/${encodeURIComponent(b.id)}`);
					}}
					data-testid="build-branch-chip"
					className={cn(
						"rounded-full border px-2 py-0.5 font-ui text-[10px] uppercase tracking-wide transition-colors hover:text-foreground",
						b.phase === "returned" ? "border-border/60 text-muted-foreground" : "border-primary/50 text-primary",
					)}
					title={b.title}
				>
					Build · {b.phase === "returned" ? "returned" : "open"}
				</a>
			))}
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				data-testid="build-button"
				disabled={disabled || opening}
				aria-label="Build it yourself"
				title={error ?? "Build it yourself — practise this step hands-on in a workspace"}
				className={cn("text-muted-foreground/40 hover:text-muted-foreground", error && "text-destructive")}
				onClick={() => void open()}
			>
				{opening ? <Loader2Icon aria-hidden className="size-3.5 animate-spin" /> : <HammerIcon aria-hidden className="size-3.5" />}
			</Button>
		</span>
	);
}
