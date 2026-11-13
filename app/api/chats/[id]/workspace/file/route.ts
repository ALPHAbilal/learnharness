/** Read (GET ?path=) or save (PUT {path, content}) one workspace file,
 *  confined to the branch folder. Logic: src/server/build-http.ts. */
import { readFileResponse, writeFileResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return readFileResponse(id, new URL(req.url));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return writeFileResponse(id, req);
}
