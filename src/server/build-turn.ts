/**
 * BUILD BRANCH TURN CARGO (2026-11-13 — docs/superpowers/specs/
 * 2026-11-13-workspace-practice-branch-design.md).
 *
 * Two kinds of learner-turn cargo, both appended as ordinary write-ahead
 * markers by the chat handler:
 *
 *   - build sessions: one `build-activity` marker with the workspace
 *     activity the coach has not seen (learner terminal lines and output,
 *     coach-command output that arrived after its tool call returned, file
 *     saves, test runs);
 *   - teaching sessions: one `build-return` marker per queued, undelivered
 *     branch summary.
 *
 * commitBuildCargo advances the watermarks only after the markers are
 * saved, so a failed save re-delivers on the next turn instead of losing it.
 */

import { newBuildActivityMessage, newBuildReturnMessage, tail } from "../core/build-branch.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import type { LhMarkerMessage } from "../core/native-messages.ts";
import type { BuildTerminal } from "./build-terminal.ts";
import { readState, updateState } from "./build-workspace.ts";

const ACTIVITY_TERMINAL_LIMIT = 6_000;
const ACTIVITY_EVENTS_LIMIT = 4_000;

export type BuildTurnCargo =
	| { kind: "activity"; markers: LhMarkerMessage[]; eventSeq: number; terminalSeq: number; terminalEpoch: string | null }
	| { kind: "returns"; markers: LhMarkerMessage[]; returnIds: string[] };

/** New workspace activity for a build session's coach, or null. */
export function buildActivityCargo(record: Pick<ChatRecord, "id" | "branch">, terminal: BuildTerminal | undefined): BuildTurnCargo | null {
	if (!record.branch || record.branch.phase === "returned") return null;
	const state = readState(record.id);
	const events = state.events.filter((e) => e.seq > state.seenEventSeq);
	const sameEpoch = terminal && state.seenTerminalEpoch === terminal.epoch;
	const since = sameEpoch ? state.seenTerminalSeq : 0;
	const terminalText = terminal ? terminal.transcript(since, ACTIVITY_TERMINAL_LIMIT) : "";
	if (events.length === 0 && !terminalText) return null;
	const sections = ["[Workspace activity] — what happened in the workspace since your last turn (injected context, not the learner speaking)."];
	if (terminalText) sections.push(`Terminal:\n${terminalText}`);
	if (events.length) {
		sections.push(`Workspace events:\n${tail(events.map((e) => `- ${e.by === "you" ? "Learner" : "AI"}: ${e.detail}`).join("\n"), ACTIVITY_EVENTS_LIMIT)}`);
	}
	return {
		kind: "activity",
		markers: [newBuildActivityMessage(sections.join("\n\n"))],
		eventSeq: events.at(-1)?.seq ?? state.seenEventSeq,
		terminalSeq: terminal?.lastSeq ?? state.seenTerminalSeq,
		terminalEpoch: terminal?.epoch ?? state.seenTerminalEpoch ?? null,
	};
}

/** Queued branch summaries for a teaching session, or null. */
export function buildReturnCargo(record: Pick<ChatRecord, "buildReturns">): BuildTurnCargo | null {
	const pending = (record.buildReturns ?? []).filter((r) => !r.delivered);
	if (pending.length === 0) return null;
	return { kind: "returns", markers: pending.map((r) => newBuildReturnMessage(r)), returnIds: pending.map((r) => r.id) };
}

/** Advance watermarks once the cargo's markers are saved. */
export function commitBuildCargo(
	chatId: string,
	cargo: BuildTurnCargo,
	chatStore: { markBuildReturnsDelivered(parentId: string, ids: readonly string[]): void },
): void {
	try {
		if (cargo.kind === "returns") chatStore.markBuildReturnsDelivered(chatId, cargo.returnIds);
		else {
			updateState(chatId, (s) => {
				s.seenEventSeq = Math.max(s.seenEventSeq, cargo.eventSeq);
				s.seenTerminalSeq = cargo.terminalSeq;
				if (cargo.terminalEpoch) s.seenTerminalEpoch = cargo.terminalEpoch;
			});
		}
	} catch (err) {
		// Bookkeeping only: the markers are already durable. A failed
		// watermark re-delivers the same activity next turn.
		console.error(`[chat ${chatId}] build cargo bookkeeping failed:`, err);
	}
}
