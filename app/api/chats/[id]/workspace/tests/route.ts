/** The learner's Run tests button: runs the active stage's locked tests.
 *  Logic: src/server/build-http.ts. */
import { runTestsResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return runTestsResponse(id);
}
