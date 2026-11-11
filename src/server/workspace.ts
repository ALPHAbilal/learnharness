/**
 * Workspaces, server side: where the learner's main workspace folder is,
 * making one chat's folder inside it, and opening that folder in the
 * learner's editor.
 *
 * The folder is the learner's own — real files on their disk that they edit
 * and run in their own editor. Nothing here is a sandbox.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceFolderName } from "../core/workspace.ts";
import { readSettings } from "../store/settings.ts";

/** The main workspace folder, or null when the learner has not chosen one.
 *  LH_WORKSPACE_DIR overrides the setting (scripted runs and tests, the
 *  LH_DATA_DIR idiom). `~` expands to the server user's home. */
export function resolveWorkspaceRoot(): string | null {
	const fromEnv = process.env.LH_WORKSPACE_DIR?.trim();
	const raw = fromEnv || readSettings()?.agent?.workspace?.path?.trim();
	if (!raw) return null;
	const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
	return path.isAbsolute(expanded) ? path.resolve(expanded) : null;
}

/** Create one chat's folder under the main workspace folder and return its
 *  absolute path. Throws with a readable message when the main folder is
 *  not a usable directory — the caller must not create the chat then. */
export function createWorkspaceFolder(root: string, title: string, chatId: string): string {
	const folder = path.join(root, workspaceFolderName(title, chatId));
	try {
		fs.mkdirSync(folder, { recursive: true });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WorkspaceFolderError(`Could not create the chat's folder in the workspace folder (${root}): ${reason}`);
	}
	return folder;
}

/** A chat folder could not be made; the message is safe to show the learner. */
export class WorkspaceFolderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkspaceFolderError";
	}
}

/** Test seam (the toolTimeoutMs idiom): the editor launcher's command. */
export const editorCommand: { current: string } = { current: "code" };

const EDITOR_LAUNCH_TIMEOUT_MS = 15_000;

/** Open a folder in the learner's editor (VS Code's `code` launcher).
 *  Resolves null on success, or a short reason when the launcher could not
 *  be started or exited with an error — the caller shows the folder path so
 *  the learner can open it by hand. Never throws. */
export function launchEditor(dir: string): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (reason: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(reason);
		};
		const command = editorCommand.current;
		// Windows ships the launcher as code.cmd, which only a shell resolves,
		// so there the folder is quoted into the shell line (any quote in the
		// path is dropped first). Elsewhere it travels as a plain argument.
		const windows = process.platform === "win32";
		const child = windows
			? spawn(/* turbopackIgnore: true */ `${command} "${dir.replace(/"/g, "")}"`, { shell: true, stdio: "ignore", windowsHide: true })
			: spawn(/* turbopackIgnore: true */ command, [dir], { stdio: "ignore" });
		const timer = setTimeout(() => {
			// The launcher normally returns at once; a still-running one has
			// most likely opened the editor in the foreground. Leave it be.
			child.unref();
			finish(null);
		}, EDITOR_LAUNCH_TIMEOUT_MS);
		child.once("error", (error) => finish(`Could not start "${command}": ${error.message}`));
		child.once("exit", (code) => finish(code === 0 ? null : `"${command}" exited with code ${code ?? "unknown"}`));
	});
}
