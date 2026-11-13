"use client";

/**
 * Transcript cards for build branches (2026-11-13): the branch's parent
 * context (first message of a build session) and a returned branch's
 * evidence summary (in the parent lesson). Collapsible scaffolding in the
 * GraphContextCard register — never chat bubbles.
 */

import { useState } from "react";
import Link from "next/link";
import { ChevronRightIcon, HammerIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BuildContextData {
	nodeTitle?: string;
	folder?: string;
	parentChatId?: string;
	content?: string;
}

export interface BuildReturnData {
	branchId?: string;
	nodeTitle?: string;
	summary?: string;
}

export function BuildContextCard({ data }: { data: BuildContextData }) {
	const [open, setOpen] = useState(false);
	return (
		<div data-testid="build-context-card" className="my-1">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<HammerIcon aria-hidden className="size-3.5 shrink-0" />
				<span className="font-medium">Build branch</span>
				<span className="min-w-0 flex-1 truncate">from “{data.nodeTitle ?? "the lesson"}”</span>
				{data.parentChatId && (
					<Link
						href={`/chat/${encodeURIComponent(data.parentChatId)}`}
						onClick={(e) => e.stopPropagation()}
						className="shrink-0 underline-offset-2 hover:underline"
					>
						Lesson
					</Link>
				)}
			</button>
			{open && (
				<div className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{data.folder && (
						<div className="font-mono text-[11px] text-muted-foreground">
							Workspace: <span className="text-foreground/80">{data.folder}</span>
						</div>
					)}
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">{data.content}</pre>
				</div>
			)}
		</div>
	);
}

export function BuildReturnCard({ data }: { data: BuildReturnData }) {
	const [open, setOpen] = useState(true);
	return (
		<div data-testid="build-return-card" className="my-2">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<HammerIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
				<span className="font-medium text-foreground/80">Build branch returned</span>
				<span className="min-w-0 flex-1 truncate">“{data.nodeTitle ?? "step"}”</span>
				{data.branchId && (
					<Link href={`/chat/${encodeURIComponent(data.branchId)}`} onClick={(e) => e.stopPropagation()} className="shrink-0 underline-offset-2 hover:underline">
						Open build
					</Link>
				)}
			</button>
			{open && data.summary && (
				<div className="mt-1 whitespace-pre-wrap rounded-lg border border-border/70 px-4 py-3 font-prose text-sm leading-relaxed text-foreground/90">
					{data.summary}
				</div>
			)}
		</div>
	);
}
