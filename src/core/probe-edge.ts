/**
 * The probe's map rules (the prober owns the map). The prober draws the
 * map (draw_map) and marks it after every answer (reflect); the app keeps
 * only the rules that stop it running away. Everything here is
 * deterministic and pure:
 *
 *   - probeAnswerCounts: each map fact's graded answers in THIS chat (the
 *     evidence ledger: multiple choice re-derived by the server, own-words
 *     verdicts written by reflect);
 *   - guardMark: the certainty guard ("shown, not said");
 *   - isPlaced / unplacedFacts / probeComplete: when a fact needs no more
 *     questions, and when the probe is over;
 *   - forcedNextFact / openFactsText / whyNotOpen: the fact two misses
 *     share, and the reasons refusals give;
 *   - answerEvidenceLine / proofQuotesAnswer: proof built from, or
 *     quoting, the learner's answer;
 *   - probeTrail: the graded questions in order, for the learner's card;
 *   - edgeReport / edgeReportText: the result the planner plans from and
 *     the learner's card renders;
 *   - probeMapText: the map as the prober reads it in tool results.
 *
 * Browser-safe: no IO.
 */

import type { EvidenceEvent } from "./contracts/graph.ts";
import type { ProbeFacts, ProbeMark } from "./contracts/chat.ts";
import { answeredQuestionsIn, answerVerdict, type AnsweredQuestion } from "./evidence.ts";
import type { LhMessage } from "./native-messages.ts";
import { normalizeFactTags, type QuestionAnswerData } from "./question-core.ts";

/** Graded probe questions after which the probe ends regardless. The
 *  opening ask_user_question does not count. */
export const PROBE_QUESTION_BUDGET = 20;

/** A right answer counts toward held/high only at this stated confidence
 *  or above (or with no confidence at all: a judged own-words answer). */
export const PROBE_SURE_CONFIDENCE = 70;

/** One fact's graded answers in this chat. `last` is the verdict of the
 *  most recent one (null without any). `sure`: the right answers given
 *  sure (confidence ≥ PROBE_SURE_CONFIDENCE, or none stated);
 *  `unsure`: the stated confidence of the most recent right answer below
 *  it (null without any). */
export interface ProbeFactCounts {
	right: number;
	sure: number;
	unsure: number | null;
	wrong: number;
	last: "right" | "wrong" | null;
	/** The answer message ids of the most recent right / wrong (or "I don't
	 *  know") answer on the fact (absent without one). */
	lastRight?: string;
	lastWrong?: string;
	/** The fact's only wrong answer, contradicted: the answer message id of
	 *  the latest of 2+ later sure right answers on facts directly under or
	 *  over it (absent otherwise). */
	contradictedBy?: string;
}

/** Per fact id. */
export type ProbeCounts = ReadonlyMap<string, ProbeFactCounts>;

/** The evidence sources of a probe answer. */
const PROBE_SOURCES = new Set(["probe", "recall"]);

function isRight(e: EvidenceEvent): boolean {
	return e.correct && e.dontKnow !== true;
}

/** Each map fact's graded answers, from THIS chat's probe and recall
 *  evidence on the fact's graph node (`events` may hold the whole ledger),
 *  in `at` order. A voided answer (map.voided) does not count. */
export function probeAnswerCounts(map: ProbeFacts, events: readonly EvidenceEvent[], chatId: string): Map<string, ProbeFactCounts> {
	const voided = new Set(map.voided ?? []);
	const own = events
		.filter((e) => e.chatId === chatId && PROBE_SOURCES.has(e.source) && !voided.has(e.messageId))
		.map((e, i) => ({ e, i }))
		.sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i))
		.map(({ e }) => e);
	const out = new Map<string, ProbeFactCounts>();
	const sureRights = new Map<string, { messageId: string; i: number }[]>();
	const wrongAt = new Map<string, number>();
	for (const fact of map.facts) {
		const counts: ProbeFactCounts = { right: 0, sure: 0, unsure: null, wrong: 0, last: null };
		const sure: { messageId: string; i: number }[] = [];
		own.forEach((e, i) => {
			if (e.nodeId !== fact.graphId) return;
			if (isRight(e)) {
				counts.right++;
				if (e.confidence === undefined || e.confidence >= PROBE_SURE_CONFIDENCE) {
					counts.sure++;
					sure.push({ messageId: e.messageId, i });
				} else counts.unsure = e.confidence;
				counts.lastRight = e.messageId;
			} else {
				counts.wrong++;
				counts.lastWrong = e.messageId;
				wrongAt.set(fact.id, i);
			}
			counts.last = isRight(e) ? "right" : "wrong";
		});
		sureRights.set(fact.id, sure);
		out.set(fact.id, counts);
	}
	const below = premisesOf(map);
	const above = dependentsOf(map);
	for (const fact of map.facts) {
		const counts = out.get(fact.id)!;
		const at = wrongAt.get(fact.id);
		if (counts.wrong !== 1 || at === undefined) continue;
		const later = new Map<string, number>();
		for (const id of [...(below.get(fact.id) ?? []), ...(above.get(fact.id) ?? [])]) {
			for (const r of sureRights.get(id) ?? []) {
				if (r.i > at && r.messageId !== counts.lastWrong) later.set(r.messageId, Math.max(r.i, later.get(r.messageId) ?? r.i));
			}
		}
		if (later.size >= 2) counts.contradictedBy = [...later].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
	}
	return out;
}

function countsOf(counts: ProbeCounts, id: string): ProbeFactCounts {
	return counts.get(id) ?? { right: 0, sure: 0, unsure: null, wrong: 0, last: null };
}

/** PARTLY HELD: among the fact's counted answers, at least one right and
 *  at least one wrong or "I don't know"; or its only wrong one is
 *  contradicted (contradictedBy). Placement does not change. */
export function isPartlyHeld(counts: ProbeCounts, factId: string): boolean {
	const own = countsOf(counts, factId);
	return (own.right >= 1 && own.wrong >= 1) || own.contradictedBy !== undefined;
}

/** fact id → the facts it stands on (direct premises). */
function premisesOf(map: ProbeFacts): Map<string, string[]> {
	const out = new Map<string, string[]>(map.facts.map((f) => [f.id, []]));
	for (const arrow of map.arrows) {
		const list = out.get(arrow.conclusion);
		if (!list) continue;
		for (const p of arrow.premises) if (out.has(p) && !list.includes(p)) list.push(p);
	}
	return out;
}

/** fact id → the facts that stand on it directly. */
function dependentsOf(map: ProbeFacts): Map<string, string[]> {
	const out = new Map<string, string[]>(map.facts.map((f) => [f.id, []]));
	for (const [conclusion, premises] of premisesOf(map)) {
		for (const p of premises) out.get(p)!.push(conclusion);
	}
	return out;
}

/** Every fact reachable from `id` through `edges` (not `id` itself). */
function reachable(edges: ReadonlyMap<string, readonly string[]>, id: string): Set<string> {
	const seen = new Set<string>();
	const stack = [...(edges.get(id) ?? [])];
	while (stack.length > 0) {
		const next = stack.pop()!;
		if (seen.has(next) || next === id) continue;
		seen.add(next);
		stack.push(...(edges.get(next) ?? []));
	}
	return seen;
}

/** fact id → the length of the longest arrow path beneath it (0 for a
 *  fact that stands on nothing on the map). */
export function probeHeights(map: ProbeFacts): Map<string, number> {
	const premises = premisesOf(map);
	const memo = new Map<string, number>();
	const visiting = new Set<string>();
	const height = (id: string): number => {
		const known = memo.get(id);
		if (known !== undefined) return known;
		if (visiting.has(id)) return 0; // a cycle (never on a validated map)
		visiting.add(id);
		const below = premises.get(id) ?? [];
		const h = below.length === 0 ? 0 : 1 + Math.max(...below.map(height));
		visiting.delete(id);
		memo.set(id, h);
		return h;
	};
	for (const fact of map.facts) height(fact.id);
	return memo;
}

// ─── the certainty guard ─────────────────────────────────────────────────────

/** The guard's verdict on one mark: the mark to save (certainty possibly
 *  lowered, or raised for a miss) and, when changed, the model-readable
 *  line saying why; or a refusal. */
export type GuardResult =
	| { ok: true; mark: ProbeMark; lowered: string | null }
	| { ok: false; problem: string };

/** THE CERTAINTY GUARD ("shown, not said"), over the answer counts AFTER
 *  this reflect's own-words verdicts were counted:
 *  - held + high needs 2 sure right answers on the fact, or 1 on it and
 *    1 on a fact that stands on it (directly or transitively) — a right
 *    answer below PROBE_SURE_CONFIDENCE does not count here; otherwise
 *    medium with any right answer, low with none;
 *  - missed / wrong-idea with 1 wrong or "I don't know" answer is stored
 *    high whatever certainty was claimed (one miss places a fact);
 *    without one, high is lowered to medium;
 *  - held is refused when the fact's most recent answer was wrong;
 *  - wrong-idea requires `believed`. */
export function guardMark(map: ProbeFacts, counts: ProbeCounts, factId: string, mark: ProbeMark): GuardResult {
	const own = countsOf(counts, factId);
	if (mark.state === "wrong-idea" && !mark.believed?.trim()) {
		return { ok: false, problem: `"${factId}" is marked wrong-idea: set \`believed\` to what the learner thinks is true.` };
	}
	if (mark.state === "held" && own.last === "wrong") {
		return { ok: false, problem: `"${factId}" was just answered wrong. Mark it missed or wrong-idea.` };
	}
	if (mark.state !== "held" && own.wrong >= 1 && mark.certainty !== "high") {
		return {
			ok: true,
			mark: { ...mark, certainty: "high" },
			lowered: `"${factId}": ${mark.state} is certain after one miss — stored as high. It will not be asked again.`,
		};
	}
	if (mark.certainty !== "high") return { ok: true, mark, lowered: null };
	if (mark.state === "held") {
		const above = [...reachable(dependentsOf(map), factId)];
		const shown = own.sure >= 2 || (own.sure >= 1 && above.some((id) => countsOf(counts, id).sure >= 1));
		if (shown) return { ok: true, mark, lowered: null };
		const certainty = own.right >= 1 ? "medium" : "low";
		// Shown when every right answer counts: lowered only for hesitancy.
		const shownAnyhow = own.right >= 2 || (own.right >= 1 && above.some((id) => countsOf(counts, id).right >= 1));
		const unsure = own.unsure ?? above.map((id) => countsOf(counts, id).unsure).find((c) => c !== null) ?? null;
		const why = shownAnyhow && unsure !== null
			? `the learner got it right but was not sure (${unsure}%). Ask again from another side.`
			: own.right >= 1
				? "one right answer is not enough; ask about it again from another side."
				: "the learner said it but has not shown it; ask about it.";
		return { ok: true, mark: { ...mark, certainty }, lowered: `"${factId}": held/high lowered to ${certainty} — ${why}` };
	}
	if (own.wrong >= 1) return { ok: true, mark, lowered: null };
	return {
		ok: true,
		mark: { ...mark, certainty: "medium" },
		lowered: `"${factId}": ${mark.state}/high lowered to medium — no answer on it was wrong yet; ask about it.`,
	};
}

// ─── placement and completion ────────────────────────────────────────────────

function isMissHigh(mark: ProbeMark | undefined): boolean {
	return !!mark && mark.certainty === "high" && (mark.state === "missed" || mark.state === "wrong-idea");
}

/** NOT REACHED: the fact stands (directly or transitively) on a fact
 *  marked missed / wrong-idea with high certainty, and has no graded
 *  answer of its own. */
export function isNotReached(map: ProbeFacts, counts: ProbeCounts, factId: string): boolean {
	const own = countsOf(counts, factId);
	if (own.right + own.wrong > 0) return false;
	const below = reachable(premisesOf(map), factId);
	return [...below].some((id) => isMissHigh(map.marks?.[id]));
}

/** PLACED: marked with high certainty, or not reached. Nothing is assumed
 *  downward: a fact under a held fact still has to be shown. */
export function isPlaced(map: ProbeFacts, counts: ProbeCounts, factId: string): boolean {
	return map.marks?.[factId]?.certainty === "high" || isNotReached(map, counts, factId);
}

/** The map's facts that are not placed, in map order. */
export function unplacedFacts(map: ProbeFacts, counts: ProbeCounts): string[] {
	return map.facts.filter((f) => !isPlaced(map, counts, f.id)).map((f) => f.id);
}

/** Is the probe over: every fact placed, or PROBE_QUESTION_BUDGET graded
 *  probe answers. */
export function probeComplete(map: ProbeFacts, counts: ProbeCounts, asked: number): boolean {
	return asked >= PROBE_QUESTION_BUDGET || unplacedFacts(map, counts).length === 0;
}

// ─── what is open, and why a fact is not ─────────────────────────────────────

/** Open-fact lines shown at most; the rest are counted. */
const OPEN_LINES_MAX = 12;

/** `text` on one line, cut at `max` characters with "…". */
function cut(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

function stateLabel(state: ProbeMark["state"]): string {
	return state === "wrong-idea" ? "wrong idea" : state;
}

function isMiss(mark: ProbeMark | undefined): boolean {
	return mark?.state === "missed" || mark?.state === "wrong-idea";
}

/** The fact the next question must test: an OPEN fact that two or more
 *  facts marked missed / wrong-idea stand on directly. When several
 *  qualify, the one the most misses stand on, then map order. `missed`:
 *  those facts' ids. null when there is none. Recomputed from the stored
 *  marks on every call; it clears once the fact is placed. */
export interface ForcedFact { id: string; statement: string; missed: string[] }

export function forcedNextFact(map: ProbeFacts, counts: ProbeCounts): ForcedFact | null {
	const premises = premisesOf(map);
	const marks = map.marks ?? {};
	const missedOn = new Map<string, string[]>();
	for (const fact of map.facts) {
		if (!isMiss(marks[fact.id])) continue;
		for (const p of premises.get(fact.id) ?? []) missedOn.set(p, [...(missedOn.get(p) ?? []), fact.id]);
	}
	let best: ForcedFact | null = null;
	for (const fact of map.facts) {
		const missed = missedOn.get(fact.id) ?? [];
		if (missed.length < 2 || isPlaced(map, counts, fact.id)) continue;
		if (!best || missed.length > best.missed.length) best = { id: fact.id, statement: fact.statement, missed };
	}
	return best;
}

/** The refusal line naming the forced next fact. */
export function forcedFactLine(forced: ForcedFact): string {
	return `The next question must test "${forced.id}": ${forced.missed.length} facts that stand on it were missed (${forced.missed.join(", ")}). Ask about it now.`;
}

/** The reflect reply's closing line naming the forced next fact. */
export function nextFactLine(forced: ForcedFact): string {
	return `Next fact: [${forced.id}] ${forced.statement} — ${forced.missed.length} facts that stand on it were missed. Ask about it now.`;
}

/** What an open fact still needs. */
function openReason(map: ProbeFacts, counts: ProbeCounts, factId: string): string {
	const mark = map.marks?.[factId];
	if (!mark) return "not asked yet";
	if (mark.state === "held") {
		const own = countsOf(counts, factId);
		if (own.unsure !== null && own.sure === 0) return `right but not sure (${own.unsure}%): ask again from another side`;
		return mark.certainty === "medium" ? "held, medium: needs one more sure right answer" : "held, low: claimed but not shown; ask it";
	}
	return `${stateLabel(mark.state)}, ${mark.certainty}: no answer on it was wrong yet; ask it`;
}

/** One line per open fact, in map order, with what it still needs
 *  (capped at OPEN_LINES_MAX, then "… and k more"). */
export function openFactLines(map: ProbeFacts, counts: ProbeCounts): string[] {
	const statements = new Map(map.facts.map((f) => [f.id, f.statement]));
	const open = unplacedFacts(map, counts);
	const lines = open.slice(0, OPEN_LINES_MAX).map((id) => `- [${id}] ${cut(statements.get(id) ?? "", 70)} — ${openReason(map, counts, id)}`);
	if (open.length > OPEN_LINES_MAX) lines.push(`… and ${open.length - OPEN_LINES_MAX} more`);
	return lines;
}

/** The open facts as a block the prober reads in refusals and reflect replies. */
export function openFactsText(map: ProbeFacts, counts: ProbeCounts): string {
	return ["Open facts and what each still needs:", ...openFactLines(map, counts)].join("\n");
}

/** Why a question may not test `factId`, in one sentence: not on the map,
 *  placed, not reached, or another fact is forced next. "" when it may. */
export function whyNotOpen(map: ProbeFacts, counts: ProbeCounts, factId: string): string {
	if (!map.facts.some((f) => f.id === factId)) return `"${factId}" is not a fact on the map.`;
	const mark = map.marks?.[factId];
	if (mark?.certainty === "high") {
		return mark.state === "held" ? `"${factId}" is placed: held, certain.` : `"${factId}" is placed: ${stateLabel(mark.state)}, it is not asked again.`;
	}
	if (isNotReached(map, counts, factId)) {
		const premises = premisesOf(map);
		const below = reachable(premises, factId);
		const order = [...(premises.get(factId) ?? []), ...map.facts.map((f) => f.id)];
		const miss = order.find((id) => below.has(id) && isMissHigh(map.marks?.[id]));
		return `"${factId}" is not reached: it stands on "${miss}", which was missed. Facts above a miss are not tested.`;
	}
	const forced = forcedNextFact(map, counts);
	return forced && forced.id !== factId ? forcedFactLine(forced) : "";
}

// ─── reading the probe's answers ─────────────────────────────────────────────

/** The tools whose answers are graded probe questions. */
const PROBE_QUESTION_TOOLS = new Set(["probe", "recall"]);

/** The graded probe answers in the record (probe / recall, not
 *  dismissed), in order. */
export function probeAnswers(messages: readonly LhMessage[]): AnsweredQuestion[] {
	return answeredQuestionsIn(messages, messages).filter((a) => PROBE_QUESTION_TOOLS.has(a.tool) && (a.answer as QuestionAnswerData).dismissed !== true);
}

/** Graded probe questions the learner answered; a voided answer
 *  (`voided`: the map's voided answer message ids) does not count. */
export function probeAskedCount(messages: readonly LhMessage[], voided: readonly string[] = []): number {
	return probeAnswers(messages).filter((a) => !voided.includes(a.messageId)).length;
}

/** Quoted learner text in an evidence line is cut at this length. */
const EVIDENCE_QUOTE_MAX = 160;
/** An untagged fact's proof must share a run this long with the answer. */
const PROOF_QUOTE_RUN = 12;

function quoted(text: string): string {
	return `"${cut(text, EVIDENCE_QUOTE_MAX)}"`;
}

function answerData(answer: AnsweredQuestion): QuestionAnswerData {
	return answer.answer as QuestionAnswerData;
}

/** The learner's thinking on the question; their thinking while reading
 *  only when that is empty. */
function thinkingOf(a: QuestionAnswerData): string {
	return (a.thinking ?? a.note ?? "").trim() || (a.readingThinking ?? "").trim();
}

function ownWordsOf(a: QuestionAnswerData): string {
	return (a.text ?? "").trim() || (a.other ?? "").trim();
}

function chosenLabels(a: QuestionAnswerData): string[] {
	return (Array.isArray(a.answers) ? a.answers : []).map((x) => (typeof x?.label === "string" ? x.label.trim() : "")).filter((l) => l.length > 0);
}

function confidenceOf(a: QuestionAnswerData): number | null {
	const c = a.confidence;
	return typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 100 ? c : null;
}

/** What the learner answered, built by the app (the start of a tested
 *  fact's stored proof): `answered "I don't know"`, `chose "…" (right,
 *  N% sure)` (each with `; said: "…"` when they wrote thinking), or
 *  `wrote: "…"` for an own-words answer. */
export function answerEvidenceLine(answer: AnsweredQuestion): string {
	const a = answerData(answer);
	const thinking = thinkingOf(a);
	const said = thinking ? `; said: ${quoted(thinking)}` : "";
	if (a.dontKnow) return `answered "I don't know"${said}`;
	if (answer.tool === "recall") return `wrote: ${quoted(ownWordsOf(a))}`;
	const verdict = answerVerdict(answer);
	const confidence = confidenceOf(a);
	const grade = [verdict === "correct" ? "right" : verdict === "wrong" ? "wrong" : null, confidence !== null ? `${confidence}% sure` : null].filter(Boolean).join(", ");
	return `chose ${chosenLabels(a).map(quoted).join(", ") || '""'}${grade ? ` (${grade})` : ""}${said}`;
}

function normalizedText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Does `proof` quote the learner's answer: after lower-casing and
 *  collapsing whitespace, does it share a run of PROOF_QUOTE_RUN characters
 *  (the whole text, for a shorter one) with their thinking, thinking while
 *  reading, own words, or a chosen option's label? */
export function proofQuotesAnswer(proof: string, answer: AnsweredQuestion): boolean {
	const a = answerData(answer);
	const p = normalizedText(proof);
	const sources = [a.thinking ?? a.note ?? "", a.readingThinking ?? "", a.text ?? "", a.other ?? "", ...chosenLabels(a)]
		.map(normalizedText)
		.filter((s) => s.length > 0);
	return sources.some((s) => {
		const run = Math.min(PROOF_QUOTE_RUN, s.length);
		for (let i = 0; i + run <= s.length; i++) if (p.includes(s.slice(i, i + run))) return true;
		return false;
	});
}

// ─── the decision trail ──────────────────────────────────────────────────────

/** One graded probe question in the learner's decision trail. */
export interface TrailRow { n: number; fact: string; question: string; answer: string; mark: string }

function markText(mark: Pick<ProbeMark, "state" | "certainty">): string {
	return `${stateLabel(mark.state)}, ${mark.certainty}`;
}

function textOf(message: LhMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n");
}

function updatesOf(args: unknown): { fact?: unknown; state?: unknown; certainty?: unknown }[] {
	let updates = (args as { updates?: unknown } | null)?.updates;
	if (typeof updates === "string") {
		try { updates = JSON.parse(updates); } catch { return []; }
	}
	return Array.isArray(updates) ? updates.filter((u) => u && typeof u === "object") : [];
}

const STATES = new Set(["held", "missed", "wrong-idea"]);
const CERTAINTIES = new Set(["low", "medium", "high"]);

/** The mark the first successful reflect in messages[from, to) stored for
 *  `factId`: its update, with the certainty the app changed (the result's
 *  "lowered to" / "stored as high" line). null when none is found. */
function reflectedMark(messages: readonly LhMessage[], from: number, to: number, factId: string): string | null {
	for (let i = from; i < to; i++) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.name !== "reflect") continue;
			const result = messages.slice(i + 1).find((r) => r.role === "toolResult" && r.toolCallId === block.id);
			if (!result || result.role !== "toolResult" || result.isError || (result.details as { ok?: unknown } | null)?.ok !== true) continue;
			const update = updatesOf(block.arguments).find((u) => u.fact === factId);
			if (!update || !STATES.has(String(update.state)) || !CERTAINTIES.has(String(update.certainty))) return null;
			let certainty = String(update.certainty) as ProbeMark["certainty"];
			for (const lineText of textOf(result).split("\n")) {
				if (!lineText.startsWith(`"${factId}": `)) continue;
				const lowered = / lowered to (low|medium) — /.exec(lineText);
				if (lowered) certainty = lowered[1] as ProbeMark["certainty"];
				else if (lineText.includes(" — stored as high.")) certainty = "high";
			}
			return markText({ state: update.state as ProbeMark["state"], certainty });
		}
	}
	return null;
}

/** The question on one line: code fences dropped, whitespace collapsed,
 *  cut at `max`. */
function questionLine(answer: AnsweredQuestion, max = 90): string {
	const asked = (answer.input as { question?: unknown } | null)?.question;
	const text = typeof asked === "string" ? asked : answerData(answer).questionText ?? "";
	return cut(text.replace(/```[^\s`]*/g, " "), max);
}

/** Why the first successful voiding reflect in messages[from, to) voided
 *  the answer before it (its `void`); null when none is found. */
function voidReason(messages: readonly LhMessage[], from: number, to: number): string | null {
	for (let i = from; i < to; i++) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.name !== "reflect") continue;
			const reason = (block.arguments as { void?: unknown } | null)?.void;
			if (typeof reason !== "string" || reason.trim() === "") continue;
			const result = messages.slice(i + 1).find((r) => r.role === "toolResult" && r.toolCallId === block.id);
			if (result && result.role === "toolResult" && (result.isError || (result.details as { ok?: unknown } | null)?.ok !== true)) continue;
			return reason;
		}
	}
	return null;
}

function trailAnswer(answer: AnsweredQuestion): string {
	const a = answerData(answer);
	if (a.dontKnow) return "don't know";
	if (answer.tool === "recall") return `wrote: ${cut(ownWordsOf(a), 60)}`;
	const verdict = answerVerdict(answer);
	const grade = verdict === "correct" ? "right" : verdict === "wrong" ? "wrong" : "answered";
	const confidence = confidenceOf(a);
	return confidence !== null ? `${grade}, ${confidence}%` : grade;
}

/** One row per graded probe / recall question answered in this chat, in
 *  order: the fact it tested, the question, the answer, and the mark the
 *  reflect after it stored (recovered from the transcript; else the
 *  fact's current mark). */
export function probeTrail(messages: readonly LhMessage[], map: ProbeFacts): TrailRow[] {
	const answers = probeAnswers(messages);
	const index = new Map(messages.map((m, i) => [m.id, i]));
	const at = answers.map((a) => index.get(a.messageId) ?? messages.length);
	return answers.map((answer, i) => {
		const tags = normalizeFactTags((answer.input as { facts?: unknown } | null)?.facts);
		const facts = Array.isArray(tags) ? tags.filter((f): f is string => typeof f === "string" && f.length > 0) : [];
		const factId = facts[0] ?? "";
		const current = map.marks?.[factId];
		const from = at[i]! + 1;
		const to = at[i + 1] ?? messages.length;
		const mark = map.voided?.includes(answer.messageId)
			? `voided: ${cut(voidReason(messages, from, to) ?? "", 60)}`
			: (factId ? reflectedMark(messages, from, to, factId) : null) ?? (current ? markText(current) : "not marked");
		return { n: i + 1, fact: facts.join(", "), question: questionLine(answer), answer: trailAnswer(answer), mark };
	});
}

// ─── the edge report ─────────────────────────────────────────────────────────

export interface EdgeFact { id: string; statement: string }
export interface EdgeReport {
	goal: string;
	solid: (EdgeFact & { tested: boolean })[];          // held with high certainty (tested: true)
	weak: EdgeFact[];                                   // held below high certainty: right or claimed, not yet shown
	holes: (EdgeFact & { quote: string | null })[];     // missed; quote = the mark's proof
	wrongIdeas: (EdgeFact & { believed: string | null; quote: string | null })[];  // believed = what the learner thinks is true
	notReached: EdgeFact[];                             // not reached, and facts still unknown when the budget ran out
	startHere: EdgeFact[];                              // holes + wrongIdeas + partly whose every direct premise is held/high (or that have no premises)
	partly?: (EdgeFact & { held: string; missing: string })[];  // right once AND wrong / "I don't know" once; only here. held / missing = question + answer line
	questions: number;
	trail?: TrailRow[];                                 // the graded questions in order (probeTrail); the learner's card only
}

/** The probe's result, from the marks. Lists keep map order. A PARTLY
 *  HELD fact (isPartlyHeld) is listed only in `partly` (present when not
 *  empty), with the latest right and the latest wrong answer (built from
 *  `messages`). A missed or
 *  wrong-idea mark is a hole or wrong idea at any certainty; a held/high
 *  mark is solid; a fact not reached (or still unknown) is NOT REACHED;
 *  any other held mark is weak. START HERE: the holes and wrong ideas
 *  standing only on held/high facts (or on nothing); when there are none,
 *  the lowest of them on the map. With `messages`, the decision trail
 *  (probeTrail) rides along. */
export function edgeReport(args: { goal: string; map: ProbeFacts; counts: ProbeCounts; questions: number; messages?: readonly LhMessage[] }): EdgeReport {
	const { goal, map, counts, questions } = args;
	const premises = premisesOf(map);
	const marks = map.marks ?? {};
	const report: EdgeReport = { goal, solid: [], weak: [], holes: [], wrongIdeas: [], notReached: [], startHere: [], questions };
	const misses: EdgeFact[] = [];
	const partly: (EdgeFact & { held: string; missing: string })[] = [];
	const answers = new Map((args.messages ? probeAnswers(args.messages) : []).map((a) => [a.messageId, a]));
	const answerLine = (messageId: string | undefined, fallback: string): string => {
		const answer = messageId ? answers.get(messageId) : undefined;
		return answer ? `"${questionLine(answer, 70)}" → ${answerEvidenceLine(answer)}` : fallback;
	};
	for (const fact of map.facts) {
		const base: EdgeFact = { id: fact.id, statement: fact.statement };
		const mark = marks[fact.id];
		if (isPartlyHeld(counts, fact.id)) {
			const own = countsOf(counts, fact.id);
			partly.push({ ...base, held: answerLine(own.lastRight ?? own.contradictedBy, "a right answer"), missing: answerLine(own.lastWrong, "a wrong answer") });
			misses.push(base);
		} else if (mark?.state === "missed") {
			report.holes.push({ ...base, quote: mark.proof.trim() || null });
			misses.push(base);
		} else if (mark?.state === "wrong-idea") {
			report.wrongIdeas.push({ ...base, believed: mark.believed?.trim() || null, quote: mark.proof.trim() || null });
			misses.push(base);
		} else if (mark?.state === "held" && mark.certainty === "high") {
			report.solid.push({ ...base, tested: true });
		} else if (!mark || isNotReached(map, counts, fact.id)) {
			report.notReached.push(base);
		} else {
			report.weak.push(base);
		}
	}
	const solidHeld = (id: string) => marks[id]?.state === "held" && marks[id]?.certainty === "high";
	report.startHere = misses.filter((f) => (premises.get(f.id) ?? []).every(solidHeld));
	if (report.startHere.length === 0 && misses.length > 0) {
		const heights = probeHeights(map);
		const lowest = Math.min(...misses.map((f) => heights.get(f.id) ?? 0));
		report.startHere = [misses.find((f) => (heights.get(f.id) ?? 0) === lowest)!];
	}
	if (partly.length > 0) report.partly = partly;
	if (args.messages) report.trail = probeTrail(args.messages, map);
	return report;
}

function line(f: EdgeFact): string {
	return `- [${f.id}] ${f.statement}`;
}

/** The report as the prober and planner read it. Sections with no entries
 *  are left out. */
export function edgeReportText(report: EdgeReport): string {
	const sections: string[][] = [[`The learner's edge — goal: ${report.goal}`]];
	const add = (heading: string, lines: string[]) => {
		if (lines.length > 0) sections.push([heading, ...lines]);
	};
	add("START HERE:", report.startHere.map(line));
	add("HOLES (did not hold):", report.holes.map((f) => `${line(f)}${f.quote ? ` — proof: "${f.quote}"` : ""}`));
	add("PARTLY HELD (knows one part, not the other — teach only the missing part):", (report.partly ?? []).map((f) => `${line(f)} — has: ${f.held} · lacks: ${f.missing}`));
	add("WRONG IDEAS:", report.wrongIdeas.map((f) => `${line(f)} — believes: ${f.believed ?? "(not given)"}${f.quote ? `; proof: "${f.quote}"` : ""}`));
	add("WEAK (right or claimed, not yet shown):", report.weak.map(line));
	add("SOLID (shown):", report.solid.map(line));
	add("NOT REACHED (not tested):", report.notReached.map(line));
	return sections.map((s) => s.join("\n")).join("\n\n");
}

// ─── the map text ────────────────────────────────────────────────────────────

/** The map as the prober reads it in draw_map's and reflect's results. */
export function probeMapText(map: ProbeFacts, counts: ProbeCounts, asked: number): string {
	const premises = premisesOf(map);
	const marks = map.marks ?? {};
	const lines = ["The map (fact — state, certainty — proof):"];
	for (const fact of map.facts) {
		const mark = marks[fact.id];
		const shownByMark = mark && (mark.certainty === "high" || mark.state !== "held");
		let where: string;
		if (mark && (shownByMark || !isNotReached(map, counts, fact.id))) {
			where = `${isPartlyHeld(counts, fact.id) ? "partly held" : mark.state === "wrong-idea" ? "wrong idea" : mark.state}, ${mark.certainty} — ${mark.proof.trim()}${mark.state === "wrong-idea" && mark.believed ? ` (believes: ${mark.believed.trim()})` : ""}`;
		} else {
			where = isNotReached(map, counts, fact.id) ? "not reached" : "unknown";
		}
		lines.push(`- [${fact.id}] ${fact.statement} — ${where}`);
		const below = premises.get(fact.id) ?? [];
		if (below.length > 0) lines.push(`  stands on: ${below.join(", ")}`);
	}
	const placed = map.facts.length - unplacedFacts(map, counts).length;
	lines.push(`Placed: ${placed} of ${map.facts.length} · question ${asked} of ${PROBE_QUESTION_BUDGET}.`);
	return lines.join("\n");
}
