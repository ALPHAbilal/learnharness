/** A build branch's workspace state (2026-11-13): branch link, stages,
 *  recent test runs, files. Logic: src/server/build-http.ts. */
import { workspaceStateResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return workspaceStateResponse(id);
}
