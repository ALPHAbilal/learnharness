"use client";

/**
 * The build branch's code editor (2026-11-13): CodeMirror 6 with Python /
 * JavaScript highlighting by extension, Ctrl/Cmd+S to save, read-only for
 * the stage's locked test file. Controlled from outside by `docKey`: a new
 * key (another file, or a reload after the coach changed a clean file)
 * replaces the document.
 */

import { useEffect, useRef } from "react";

export function CodeEditor({
	docKey,
	value,
	path,
	readOnly,
	onChange,
	onSave,
}: {
	docKey: string;
	value: string;
	path: string;
	readOnly: boolean;
	onChange: (value: string) => void;
	onSave: () => void;
}) {
	const host = useRef<HTMLDivElement>(null);
	const handlers = useRef({ onChange, onSave });
	handlers.current = { onChange, onSave };

	useEffect(() => {
		let disposed = false;
		let destroy = () => {};
		void (async () => {
			const [{ basicSetup }, { EditorView, keymap }, { EditorState }, python, javascript] = await Promise.all([
				import("codemirror"),
				import("@codemirror/view"),
				import("@codemirror/state"),
				import("@codemirror/lang-python"),
				import("@codemirror/lang-javascript"),
			]);
			if (disposed || !host.current) return;
			const ext = path.split(".").pop()?.toLowerCase() ?? "";
			const language = ext === "py" ? [python.python()]
				: ["js", "mjs", "cjs", "jsx"].includes(ext) ? [javascript.javascript({ jsx: ext === "jsx" })]
					: ["ts", "tsx"].includes(ext) ? [javascript.javascript({ typescript: true, jsx: ext === "tsx" })]
						: [];
			const view = new EditorView({
				parent: host.current,
				state: EditorState.create({
					doc: value,
					extensions: [
						basicSetup,
						...language,
						keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (handlers.current.onSave(), true) }]),
						EditorState.readOnly.of(readOnly),
						EditorView.editable.of(!readOnly),
						EditorView.updateListener.of((update) => {
							if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
						}),
						EditorView.theme({
							"&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--background)", color: "var(--foreground)" },
							".cm-scroller": { fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace" },
							".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--border)", color: "var(--muted-foreground)" },
							".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--muted) 45%, transparent)" },
							"&.cm-focused": { outline: "none" },
						}),
					],
				}),
			});
			destroy = () => view.destroy();
		})();
		return () => {
			disposed = true;
			destroy();
		};
		// The document is replaced only when the key changes (controlled by
		// the panel); value edits flow out through onChange.
	}, [docKey, readOnly, path]);

	return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="build-editor" />;
}
