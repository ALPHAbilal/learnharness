/**
 * Evidence stamping (coach-planner design §4.3/§4.4): the deterministic,
 * server-side turn of one accepted learner answer into evidence-ledger
 * events — one per fact the question was tagged with. Pure: the handler
 * (server/chat-handler.ts afterAnswer) reads the record and the ledger,
 * calls these, and appends what comes back.
 *
 * What the app grades itself:
 *   - multiple choice (quiz / probe): `correct` is RE-DERIVED from the
 *     committed `correctAnswer` of the posed call against the values the
 *     learner selected — the client's own `correct` is never trusted;
 *   - the coding question (coding-questions plugin): the test outcome.
 * Own-words answers (explain / recall) carry no app verdict; the coach
 * judges them (judgedEvidence, used from package 5).
 */

import type { EvidenceEvent, EvidenceSource } from "./contracts/graph.ts";
import type { PlanArrow, PlanFact, PlanTree } from "./contracts/plan.ts";
import { GUESS_CODE, GUESS_FREE_TEXT, guessForChoice } from "./knowledge.ts";
import type { LhMessage } from "./native-messages.ts";
import { readPluginQuestionAnswer, readPluginQuestionMessageAnnotation, type JsonValue, type PluginQuestionAnswer } from "./plugin-questions.ts";
import { coerceCorrectAnswer, normalizeFactTags, normalizeOptions, type QuestionAnswerData } from "./question-core.ts";
import { parseQuizInput } from "./tool-parts.ts";

/** The facts a question tagged, as strings (bare-string/JSON-array wobble
 *  normalized exactly as at the tool boundary); [] when untagged. */
function factIdsOf(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const facts = normalizeFactTags((input as { facts?: unknown }).facts);
	return Array.isArray(facts) ? facts.filter((f): f is string => typeof f === "string" && f.length > 0) : [];
}

function isPluginAnswer(answer: QuestionAnswerData | PluginQuestionAnswer): answer is PluginQuestionAnswer {
	return (answer as { kind?: unknown }).kind === "plugin-question";
}

/** The learner's stated confidence when it is a valid 0–100 number. */
function confidenceOf(answer: QuestionAnswerData): number | undefined {
	const c = answer.confidence;
	return typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 100 ? c : undefined;
}

/** The server's verdict on a multiple-choice answer: exact set equality of
 *  the selected option values and the committed correctAnswer (coerced as
 *  the grading path does). null when the posed call does not parse. */
function choiceVerdict(tool: string, input: unknown, answer: QuestionAnswerData): { correct: boolean; optionCount: number; multiSelect: boolean } | null {
	// A probe call's answer key is its first option (withProbeAnswerKey).
	const quiz = parseQuizInput(input, tool);
	if (!quiz) return null;
	let values: string[];
	try { values = normalizeOptions(quiz.options).map((o) => o.value); }
	catch { return null; }
	const committed = new Set(coerceCorrectAnswer(quiz.correctAnswer, values));
	const selected = new Set((Array.isArray(answer.answers) ? answer.answers : []).map((a) => a?.value).filter((v): v is string => typeof v === "string"));
	const same = committed.size === selected.size && [...committed].every((v) => selected.has(v));
	return { correct: answer.dontKnow !== true && same, optionCount: values.length, multiSelect: quiz.multiSelect === true };
}

/** THE ONE PLACE the host reads a plugin's grading result shape: the
 *  coding-questions plugin's CodingTestResult.status ("passed" | "failed" |
 *  "error"). Any other plugin, a missing result, a grading error or an
 *  "error" status yields no verdict. */
function codingQuestionVerdict(answer: PluginQuestionAnswer): boolean | null {
	if (answer.pluginId !== "coding-questions" || answer.typeId !== "code") return null;
	const grading = answer.grading;
	if (!grading || !("result" in grading)) return null;
	const result = grading.result as { status?: JsonValue } | null;
	const status = result && typeof result === "object" && !Array.isArray(result) ? result.status : undefined;
	return status === "passed" ? true : status === "failed" ? false : null;
}

/** One accepted learner answer → its evidence events (one per tagged fact
 *  that resolves to a graph node). See the file header for the rules;
 *  dismissed answers, ask_user_question answers, own-words answers and
 *  ungraded plugin answers give []. */
export function evidenceForAnswer(args: {
	chatId: string;
	/** Id of the saved answer result message. */
	messageId: string;
	/** ISO timestamp. */
	at: string;
	/** "quiz" | "probe" | "explain" | "recall" | a plugin tool name. */
	tool: string;
	/** The pending call's raw arguments (a plugin's saved snapshot input). */
	input: unknown;
	answer: QuestionAnswerData | PluginQuestionAnswer;
	/** Fact id → graph node id (factResolver). */
	resolve: (factId: string) => string | null;
}): EvidenceEvent[] {
	const { chatId, messageId, at, tool, input, answer, resolve } = args;
	const graphIds = [...new Set(factIdsOf(input).map(resolve).filter((id): id is string => id !== null))];
	if (graphIds.length === 0) return [];
	const base = { chatId, messageId, at };

	if (isPluginAnswer(answer)) {
		const passed = codingQuestionVerdict(answer);
		if (passed === null) return [];
		return graphIds.map((nodeId) => ({ nodeId, ...base, source: "code" as const, correct: passed, guess: GUESS_CODE }));
	}
	if (answer.dismissed) return [];
	if (tool !== "quiz" && tool !== "probe") return []; // explain / recall: the coach judges; ask: ungraded
	const verdict = choiceVerdict(tool, input, answer);
	if (!verdict) return [];
	const confidence = confidenceOf(answer);
	return graphIds.map((nodeId) => ({
		nodeId, ...base,
		source: tool as EvidenceSource,
		correct: verdict.correct,
		...(answer.dontKnow ? { dontKnow: true } : {}),
		guess: guessForChoice(verdict.optionCount, verdict.multiSelect),
		...(confidence !== undefined ? { confidence } : {}),
	}));
}

/** The app's own verdict on one answer, by the same rules as
 *  evidenceForAnswer (multiple choice re-derived from the committed
 *  answer, the coding question from its test outcome): "dont-know" for
 *  an "I don't know" answer, "own-words" for explain / recall (the coach
 *  judges them), "ungraded" for everything else (ask_user_question,
 *  other plugin questions, an unparseable call). */
export function answerVerdict(args: Pick<AnsweredQuestion, "tool" | "input" | "answer">): "correct" | "wrong" | "dont-know" | "own-words" | "ungraded" {
	const { tool, input, answer } = args;
	if (isPluginAnswer(answer)) {
		const passed = codingQuestionVerdict(answer);
		return passed === null ? "ungraded" : passed ? "correct" : "wrong";
	}
	if (answer.dontKnow) return "dont-know";
	if (tool === "explain" || tool === "recall") return "own-words";
	if (tool !== "quiz" && tool !== "probe") return "ungraded";
	const verdict = choiceVerdict(tool, input, answer);
	return verdict === null ? "ungraded" : verdict.correct ? "correct" : "wrong";
}

/** Events for own-words answers the coach judged (coach-planner design
 *  §4.4): one per judged fact, with the free-text guess probability. */
export function judgedEvidence(args: {
	chatId: string;
	messageId: string;
	at: string;
	source: "recall" | "quiz";
	judged: { graphId: string; correct: boolean }[];
}): EvidenceEvent[] {
	const { chatId, messageId, at, source, judged } = args;
	return judged.map((j) => ({ nodeId: j.graphId, chatId, messageId, at, source, correct: j.correct, guess: GUESS_FREE_TEXT }));
}

/** Fact id → graph node id over the record: the plan tree's facts first,
 *  then the probe fact list. null for an unknown id. */
export function factResolver(record: { tree?: PlanTree | null; probeFacts?: { facts: PlanFact[]; arrows: PlanArrow[] } | null }): (factId: string) => string | null {
	const map = new Map<string, string>();
	for (const fact of record.probeFacts?.facts ?? []) map.set(fact.id, fact.graphId);
	for (const node of record.tree?.nodes ?? []) for (const fact of node.facts ?? []) map.set(fact.id, fact.graphId);
	return (factId) => map.get(factId) ?? null;
}

/** The idempotency filter: drop every event whose (chatId, messageId,
 *  nodeId) the ledger — or an earlier event of the same batch — already
 *  holds. Answers can be re-posted after a 409 or a reconnect. */
export function unstampedEvidence(ledger: readonly EvidenceEvent[], events: readonly EvidenceEvent[]): EvidenceEvent[] {
	const key = (e: EvidenceEvent) => JSON.stringify([e.chatId, e.messageId, e.nodeId]);
	const seen = new Set(ledger.map(key));
	const out: EvidenceEvent[] = [];
	for (const e of events) {
		const k = key(e);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(e);
	}
	return out;
}

/** One answer result among newly appended messages, with what
 *  evidenceForAnswer needs: the posed call's tool name and arguments (a
 *  plugin question's saved snapshot input) and the saved answer. */
export interface AnsweredQuestion {
	messageId: string;
	tool: string;
	input: unknown;
	answer: QuestionAnswerData | PluginQuestionAnswer;
}

/** The answer results in `appended`, each matched to its call in
 *  `messages` (the record the results append to). Builtin answers match by
 *  tool-call id and name; plugin answers by their bound occurrence and the
 *  saved snapshot. Results without a matching call are skipped. */
export function answeredQuestionsIn(messages: readonly LhMessage[], appended: readonly LhMessage[]): AnsweredQuestion[] {
	const out: AnsweredQuestion[] = [];
	for (const result of appended) {
		if (result.role !== "toolResult" || result.isError || !result.details || typeof result.details !== "object") continue;
		const occurrence = result.lhQuestionOccurrence;
		if (occurrence) {
			const owner = messages.find((m) => m.role === "assistant" && m.id === occurrence.messageId);
			const annotation = owner ? readPluginQuestionMessageAnnotation(owner, occurrence.contentIndex) : null;
			if (annotation?.status !== "posed") continue;
			const answer = readPluginQuestionAnswer(result.details, annotation.snapshot);
			if (answer) out.push({ messageId: result.id, tool: occurrence.toolName, input: annotation.snapshot.input, answer });
			continue;
		}
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i]!;
			if (m.role !== "assistant") continue;
			const call = m.content.find((b) => b.type === "toolCall" && b.id === result.toolCallId && b.name === result.toolName);
			if (call?.type !== "toolCall") continue;
			out.push({ messageId: result.id, tool: call.name, input: call.arguments, answer: result.details as unknown as QuestionAnswerData });
			break;
		}
	}
	return out;
}
