/**
 * Workspaces — one folder on the learner's disk per chat.
 *
 * The learner chooses ONE main workspace folder (settings: agent.workspace.path).
 * Every new chat gets its own folder under it, created at chat birth and
 * stamped on the record (ChatRecord.workspaceDir). The learner writes and
 * runs code there in their own editor; the agent reads, writes and runs
 * commands in the same place.
 *
 * Browser-safe: pure logic + types only, no node imports.
 */

/** The agent.workspace settings subsection. An absent path means "not chosen
 *  yet" — chat creation refuses until it is set. */
export interface WorkspaceSettings {
	path?: string;
}

/** The refusal code POST /api/chats returns while no workspace folder is set. */
export const WORKSPACE_NOT_CONFIGURED_CODE = "workspace_not_configured" as const;

/** The learner-facing wording of that refusal — single-sourced for the
 *  server reply and the client's start error. */
export const WORKSPACE_NOT_CONFIGURED_MESSAGE = "Choose a workspace folder in Settings → Agent before starting a chat.";

/** Portable syntax check, same rule as the file-access folders: absolute on
 *  some filesystem, or home-anchored. The server additionally checks the
 *  path is absolute on ITS filesystem. */
export function isWorkspacePath(value: string): boolean {
	return value.length > 0 && !value.includes("\0") && (
		value === "~" || value.startsWith("~/") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
	);
}

/** Names Windows refuses as a file or folder name, whatever the extension. */
const RESERVED_NAMES = new Set([
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

const SLUG_MAX = 40;

/** The folder name for one chat: a readable slug of its title plus the tail
 *  of its id (the id keeps two chats with the same title apart). Only
 *  lowercase ASCII letters, digits and dashes — valid on every platform. */
export function workspaceFolderName(title: string, chatId: string): string {
	const tail = (chatId.split("_").pop() ?? chatId).replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "chat";
	const slug = title
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/g, "");
	const base = slug && !RESERVED_NAMES.has(slug) ? slug : "chat";
	return `${base}-${tail}`;
}
