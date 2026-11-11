/**
 * THE CHAT'S FOLDER — open it in the learner's editor.
 *
 * Every chat born with a workspace owns a folder on the learner's disk
 * (ChatRecord.workspaceDir). POST launches the editor (VS Code's `code`
 * launcher) on it. The launch is best-effort: when the launcher is not on
 * PATH the reply still carries the folder path, so the learner can open it
 * by hand — `ok: false` is an ordinary 200 answer, not a server failure.
 *
 * 404: unknown chat, or a chat born before workspaces (no folder).
 */
import fs from "node:fs";
import { getChat, launchEditor } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const dir = chat.workspaceDir;
	if (!dir) return Response.json({ error: "This chat has no folder" }, { status: 404 });
	// The learner may have deleted the folder by hand; bring it back rather
	// than opening an editor on nothing.
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (error) {
		return Response.json({ ok: false, path: dir, error: `The folder could not be created: ${error instanceof Error ? error.message : String(error)}` });
	}
	const failure = await launchEditor(dir);
	return Response.json(failure ? { ok: false, path: dir, error: failure } : { ok: true, path: dir });
}
