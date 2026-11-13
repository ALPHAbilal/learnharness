/** The branch's shared terminal: GET streams it (SSE), POST sends
 *  keystrokes ({data}) or a resize ({cols, rows}). Logic:
 *  src/server/build-http.ts. */
import { terminalInputResponse, terminalStreamResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return terminalStreamResponse(id, req);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return terminalInputResponse(id, req);
}
