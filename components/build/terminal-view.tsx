"use client";

/**
 * The build branch's shared terminal (2026-11-13): xterm.js over the
 * server's terminal stream (SSE out, POST in). The learner types here; the
 * coach's commands stream in under an "AI ›" banner. Loaded client-side
 * only (xterm touches the DOM at import).
 */

import { useEffect, useRef, useState } from "react";
// xterm.css loads globally from app/layout.tsx (CSS imports here would
// break the node test runner, which imports the chat component tree).

const THEME = {
	background: "#0f1115",
	foreground: "#e6e6e6",
	cursor: "#c9a8ff",
	selectionBackground: "#3a3f4b",
	black: "#1b1e24",
	brightBlack: "#5c6370",
};

export function TerminalView({ chatId, readOnly }: { chatId: string; readOnly: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const readOnlyRef = useRef(readOnly);
	readOnlyRef.current = readOnly;
	const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
	const [native, setNative] = useState<boolean | null>(null);

	useEffect(() => {
		let disposed = false;
		let cleanup = () => {};
		void (async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
			if (disposed || !host.current) return;
			const term = new Terminal({
				fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12.5,
				lineHeight: 1.2,
				cursorBlink: true,
				convertEol: false,
				scrollback: 5000,
				theme: THEME,
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(host.current);
			const base = `/api/chats/${encodeURIComponent(chatId)}/workspace/terminal`;

			// Keystrokes batch per animation frame — one POST per burst.
			let pending = "";
			let flushing = false;
			const flush = async () => {
				if (flushing || !pending) return;
				flushing = true;
				const data = pending;
				pending = "";
				try {
					await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
				} catch {
					/* the stream's error state shows the outage */
				} finally {
					flushing = false;
					if (pending) void flush();
				}
			};
			const input = term.onData((data) => {
				if (readOnlyRef.current) return;
				pending += data;
				requestAnimationFrame(() => void flush());
			});

			let lastSize = "";
			const resize = () => {
				try {
					fit.fit();
				} catch {
					return; // hidden/zero-size host
				}
				const size = `${term.cols}x${term.rows}`;
				if (size === lastSize) return;
				lastSize = size;
				void fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols: term.cols, rows: term.rows }) }).catch(() => {});
			};
			const observer = new ResizeObserver(() => resize());
			observer.observe(host.current);
			resize();

			const source = new EventSource(base);
			source.addEventListener("replay", (event) => {
				const { text, native: isNative } = JSON.parse((event as MessageEvent).data) as { text: string; native: boolean };
				term.reset();
				term.write(text);
				setNative(isNative);
				setStatus("live");
			});
			source.onmessage = (event) => {
				const { text } = JSON.parse(event.data) as { text: string };
				term.write(text);
			};
			source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
			source.onopen = () => setStatus("live");

			cleanup = () => {
				source.close();
				observer.disconnect();
				input.dispose();
				term.dispose();
			};
		})();
		return () => {
			disposed = true;
			cleanup();
		};
	}, [chatId]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-[#0f1115]" data-testid="build-terminal">
			<div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-1 font-ui text-[10px] uppercase tracking-wider text-white/50">
				<span>Terminal</span>
				<span className="text-white/30">you + AI</span>
				<span className="flex-1" />
				{native === false && <span title="The native terminal module is unavailable here; a simpler line-based shell is used.">basic mode</span>}
				<span className={status === "live" ? "text-emerald-400/80" : status === "offline" ? "text-red-400/80" : "text-amber-300/80"}>{status}</span>
			</div>
			<div ref={host} className="min-h-0 flex-1 px-2 py-1" />
		</div>
	);
}
