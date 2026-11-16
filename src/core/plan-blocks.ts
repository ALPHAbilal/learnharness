/**
 * Plan-block emission (docs/archive/probe-teach-split.md §6): the INTERIM plan
 * presentation seam. The plan renders IN FLOW once, at authoring — a
 * frozen snapshot attached right after the assistant group carrying the
 * successful plan_init call. It is the presentation moment for the plan
 * (and the popup's entry point) — statuses on it are accurate at that
 * instant (current = null, everything upcoming — unless the authoring is
 * a mid-lesson rewrite, in which case the snapshot shows what was true
 * then).
 *
 * Wave B (owner-approved 2026-09-26): the block is a native plan-block
 * MARKER appended at the turn's persist (idempotent per plan_init call);
 * the projection splices its data part into the assistant group IN FLOW,
 * exactly where the UIMessage-era attach put it. The neighborhood-block
 * machinery stays retired: position derives live from the transcript.
 */

import type { PlanBlockData, PlanTree } from "./contracts.ts";
import { derivePlanStatusesLh } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";
import { newPlanBlockMessage, newProbeEdgeMessage } from "./native-messages.ts";
import type { EdgeReport } from "./probe-edge.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

/** The plan tools whose successful results present a plan block:
 *  plan_batch (the planner, coach-planner design §4.2) and plan_init
 *  (records made before the coach update). */
export const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(["plan_batch", "plan_init"]);

/** The message part the chat renderer consumes (TeacherUIDataParts key
 *  "plan-block" — the SDK strips the `data-` prefix). Kept for the client
 *  renderers; the projection emits this shape. */
export interface PlanBlockPart {
	type: "data-plan-block";
	id: string;
	data: PlanBlockData;
}

/** The snapshot payload (unchanged since wave 4): statuses derived AT
 *  EMISSION time from the transcript — the block never re-derives. Wave D:
 *  the derivation reads the NATIVE transcript (quiz CALLS only — results
 *  feed nothing, contracts/plan.ts derivePlanStatusesLh). */
function snapshot(tree: PlanTree, messages: readonly LhMessage[]): PlanBlockData {
	const statuses = derivePlanStatusesLh(tree, messages);
	return {
		kind: "full",
		at: new Date().toISOString(),
		current: statuses.current,
		nodes: tree.nodes.map((n) => ({
			id: n.id,
			title: n.title,
			status: statuses.current === n.id ? "current" : statuses.visited.has(n.id) ? "visited" : "upcoming",
		})),
		edges: tree.edges.map((e) => ({ from: e.from, to: e.to })),
	};
}

/** The record's plan-block markers, keyed by the plan_init call they
 *  present — the idempotency set for emission. */
export function emittedPlanBlockCalls(messages: readonly LhMessage[]): Set<string> {
	const out = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as { customType?: string; details?: { planCallId?: unknown } };
		if (marker.customType === "plan-block" && typeof marker.details?.planCallId === "string") {
			out.add(marker.details.planCallId);
		}
	}
	return out;
}

/**
 * The native emission seam (pure): ONE plan-block marker per TURN — for
 *  the turn's LAST successful plan_init call (a same-turn rewrite presents
 *  once; a later turn's rewrite gets its own block — the golden-master
 *  rule the UIMessage-era attach had) that the record hasn't already
 *  emitted. `tree` is the record's current tree (the plan tool saved it
 *  during the turn); `transcript` is the full NATIVE transcript the status
 *  derivation reads.
 */
export function planBlocksFor(
	record: readonly LhMessage[],
	newMessages: readonly LhMessage[],
	tree: PlanTree | null | undefined,
	transcript: readonly LhMessage[],
): LhMessage[] {
	if (!tree || tree.nodes.length === 0) return [];
	const emitted = emittedPlanBlockCalls(record);
	let last: { toolCallId: string } | null = null;
	for (const m of newMessages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage & { id: string };
		if (!PLAN_TOOL_NAMES.has(result.toolName)) continue;
		const ok = (result.details as { ok?: unknown } | undefined)?.ok;
		if (ok !== true) continue;
		if (emitted.has(result.toolCallId)) continue;
		last = { toolCallId: result.toolCallId };
	}
	if (!last) return [];
	return [newPlanBlockMessage(last.toolCallId, snapshot(tree, transcript))];
}

/**
 * The probe-edge emission seam (pure), planBlocksFor's twin: the learner's
 * probe-edge marker for a successful probe_done result among `newMessages`
 * whose details carry the edge report (probe_done puts it there when the
 * probe ran on a map). Idempotent: nothing when the record already holds a
 * probe-edge marker (probe_done succeeds once per session).
 */
export function probeEdgesFor(record: readonly LhMessage[], newMessages: readonly LhMessage[]): LhMessage[] {
	if (record.some((m) => (m as { role?: string }).role === "custom" && (m as { customType?: string }).customType === "probe-edge")) return [];
	for (const m of newMessages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage & { id: string };
		if (result.toolName !== "probe_done" || result.isError) continue;
		const details = result.details as { ok?: unknown; report?: EdgeReport } | undefined;
		if (details?.ok !== true || !details.report) continue;
		return [newProbeEdgeMessage(details.report)];
	}
	return [];
}
