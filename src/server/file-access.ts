/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import os from "node:os";
import path from "node:path";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import { readFileAccessSettings } from "../store/settings.ts";
import { resolveWorkspaceRoot } from "./workspace.ts";

export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	if (!path.isAbsolute(folder)) throw new Error("Invalid file-access folder for this server filesystem");
	return path.resolve(folder);
}

export function fileAccessPolicy(): FileAccessPolicy {
	const result = readFileAccessSettings();
	if (!result.ok) return { restricted: true, folders: [], error: result.error };
	const folders = result.settings.folders.map((folder) => expandFolder(folder));
	// The learner's workspace folder is always readable: a restricted policy
	// that left it out would hide every chat's own folder from the agent.
	const workspace = result.settings.restricted ? resolveWorkspaceRoot() : null;
	if (workspace && !folders.includes(workspace)) folders.push(workspace);
	return { restricted: result.settings.restricted, folders };
}

/** Safe UI diagnostic, no raw JSON/file contents. A corrupt record must
 * not make the restriction toggle appear safely OFF while reads are blocked. */
export function fileAccessConfigurationError(): string | null {
	const result = readFileAccessSettings();
	return result.ok ? null : result.error;
}
