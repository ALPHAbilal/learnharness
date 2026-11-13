/** Build branches of a lesson (2026-11-13): POST opens one from a plan
 *  step ({nodeId}); GET lists them. Logic: src/server/build-http.ts. */
import { createBuildBranchResponse, listBuildBranchesResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return createBuildBranchResponse(id, req);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return listBuildBranchesResponse(id);
}
