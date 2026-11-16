/**
 * The lesson progress of one chat (coach-planner design §4.10), for the
 * chat GET payload and the chat page props: the pure core derivation fed
 * with the evidence ledger and the live turn registry.
 */

import { lessonProgress, type ChatRecord, type EvidenceEvent, type LessonProgress } from "../core/index.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

export function lessonProgressOf(chat: ChatRecord): LessonProgress {
	let events: EvidenceEvent[] = [];
	try {
		events = stores.graphStore.readEvidence();
	} catch (err) {
		// An unreadable ledger reads every fact at the prior; the page stays up.
		console.error(`[chat ${chat.id}] evidence read failed:`, err);
	}
	return lessonProgress(chat, events, { turnRunning: isTurnRunning(chat.id) });
}
