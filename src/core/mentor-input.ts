/**
 * What the mentor (the learner's "Coach", coach-planner design §4.5) is
 * shown, gathered from the record: the latest answer, a plain-text
 * rendering of the current probe's or node's conversation, the numbers,
 * related propositions from other sessions, and the validation context
 * its `review` call is checked against. Pure: the server hands in the
 * record, the evidence ledger and the graph nodes.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EvidenceEvent, GraphNode } from "./contracts/graph.ts";
import type { PlanTree } from "./contracts/plan.ts";
import type { ProbeFacts } from "./contracts/chat.ts";
import type { MentorInput, MentorValidationContext } from "./contracts/mentor.ts";
import { roadRecord } from "./contracts/handoff.ts";
import { answerVerdict, answeredQuestionsIn, type AnsweredQuestion } from "./evidence.ts";
import { knowledgeFor, knowledgeOf, nodePassed } from "./knowledge.ts";
import { failedOutputCallIds, userFacingTextOf, type LhMessage } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import { currentPlanNodeId, goalOf, probeAssessmentOf } from "./plan-progress.ts";
import { readPluginQuestionAnswer, readPluginQuestionMessageAnnotation, type PluginQuestionAnswer } from "./plugin-questions.ts";
import { createPropositionCandidateSearch } from "./proposition-candidates.ts";
import { coerceCorrectAnswer, normalizeFactTags, normalizeOptions, withProbeAnswerKey, type QuestionAnswerData } from "./question-core.ts";

/** The transcript keeps about this many characters, most recent first. */
export const MENTOR_TRANSCRIPT_CAP = 12_000;
/** At most this many related propositions from other sessions. */
export const MENTOR_EXISTING_LIMIT = 12;
/** A plugin question's payload or answer text is cut at this length. */
const PLUGIN_TEXT_CAP = 2_000;
const OMITTED = "(earlier part omitted)";

function isPluginAnswer(answer: QuestionAnswerData | PluginQuestionAnswer): answer is PluginQuestionAnswer {
	return (answer as { kind?: unknown }).kind === "plugin-question";
}

/** The fact ids a question's arguments tag ([] when untagged). */
export function taggedFactIds(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const facts = normalizeFactTags((input as { facts?: unknown }).facts);
	return Array.isArray(facts) ? [...new Set(facts.filter((f): f is string => typeof f === "string" && f.length > 0))] : [];
}

/** The learner answer the mentor reviews: the LAST answer among `appended`
 *  (matched to its call in `messages`) that is not a dismissal. null when
 *  there is none (a dismissal, a cancelled plugin question, no answer). */
export function latestLearnerAnswer(messages: readonly LhMessage[], appended: readonly LhMessage[]): AnsweredQuestion | null {
	const answers = answeredQuestionsIn(messages, appended).filter((a) => isPluginAnswer(a.answer) || a.answer.dismissed !== true);
	return answers.at(-1) ?? null;
}

function clip(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** The text a tool result carries to the model (its first text block). */
function resultText(result: ToolResultMessage): string {
	const first = result.content.find((c) => c.type === "text");
	return first?.type === "text" ? first.text : "";
}

function questionLines(tool: string, args: Record<string, unknown> | undefined): string[] {
	if (!args) return [];
	const question = typeof args.question === "string" ? args.question.trim() : "";
	if (!question) return [];
	const facts = taggedFactIds(args);
	const label = [tool, typeof args.type === "string" ? args.type : null, facts.length > 0 ? `facts: ${facts.join(", ")}` : null].filter(Boolean).join(", ");
	const lines = [`Question (${label}): ${question}`];
	const details = typeof args.details === "string" ? args.details.trim() : "";
	if (details) lines.push(details);
	if (tool === "explain" || tool === "recall") return lines;
	let options: { label: string; value: string }[] = [];
	try {
		options = normalizeOptions(args.options as Parameters<typeof normalizeOptions>[0]);
	} catch {
		options = [];
	}
	if (options.length === 0) return lines;
	let committed = new Set<string>();
	if (tool === "quiz" || tool === "probe") {
		try {
			// A probe call's answer key is its first option (withProbeAnswerKey).
			const keyed = tool === "probe" ? withProbeAnswerKey(args) : args;
			committed = new Set(coerceCorrectAnswer(keyed.correctAnswer as string | string[], options.map((o) => o.value)));
		} catch {
			committed = new Set();
		}
	}
	lines.push("Options:", ...options.map((o) => `- ${o.label}${committed.has(o.value) ? " (the committed answer)" : ""}`));
	return lines;
}

function answerLines(tool: string, input: unknown, answer: QuestionAnswerData): string[] {
	if (answer.dismissed) return ["The learner skipped this question."];
	const parts: string[] = [];
	if (answer.dontKnow) parts.push("I don't know");
	else {
		const chosen = (Array.isArray(answer.answers) ? answer.answers : []).map((a) => a?.label).filter((l): l is string => typeof l === "string");
		if (chosen.length > 0) parts.push(chosen.join("; "));
		if (answer.other) parts.push(`own option: "${answer.other}"`);
		if (answer.text) parts.push(`"${answer.text}"`);
	}
	const lines = [`Learner's answer: ${parts.length > 0 ? parts.join(" — ") : "(empty)"}`];
	const verdict = answerVerdict({ tool, input, answer });
	if (verdict === "correct" || verdict === "wrong") lines.push(`App verdict: ${verdict}`);
	if (typeof answer.confidence === "number" && !answer.dontKnow) lines.push(`Learner's confidence: ${answer.confidence}%`);
	const thinking = answer.thinking ?? answer.note;
	if (typeof thinking === "string" && thinking.trim()) lines.push(`Learner's thinking: ${thinking.trim()}`);
	if (typeof answer.readingThinking === "string" && answer.readingThinking.trim()) lines.push(`Learner's notes while reading: ${answer.readingThinking.trim()}`);
	return lines;
}

/**
 * The learner-visible conversation as plain text, one block per item:
 * agent prose (`speaker`), each question with its options and code, each
 * answer with the learner's thinking, and the learner's text messages.
 * Hidden markers (handoffs, cards, briefs, compaction) and other tool
 * traffic are left out, as are failed generations. Messages whose id is in
 * `exclude` are skipped. The result keeps the most recent `cap` characters,
 * cut at a block boundary, behind an "(earlier part omitted)" line; the
 * last block is always kept whole.
 */
export function mentorTranscript(
	messages: readonly LhMessage[],
	opts: { speaker: string; exclude?: ReadonlySet<string>; cap?: number },
): string {
	const cap = opts.cap ?? MENTOR_TRANSCRIPT_CAP;
	const failedOutputs = failedOutputCallIds(messages);
	const calls = new Map<string, { name: string; args: Record<string, unknown> | undefined }>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) if (block.type === "toolCall") calls.set(block.id, { name: block.name, args: block.arguments as Record<string, unknown> | undefined });
	}
	const blocks: string[] = [];
	for (const m of messages) {
		if (opts.exclude?.has(m.id)) continue;
		if (m.role === "user") {
			for (const text of userFacingTextOf(m.content)) blocks.push(`Learner: ${text.trim()}`);
		} else if (m.role === "assistant") {
			const assistant = m as AssistantMessage;
			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") continue;
			for (const text of userFacingTextOf(assistant.content, failedOutputs)) blocks.push(`${opts.speaker}: ${text.trim()}`);
			for (const [contentIndex, block] of assistant.content.entries()) {
				if (block.type !== "toolCall") continue;
				const annotation = readPluginQuestionMessageAnnotation(m, contentIndex);
				if (annotation.status === "posed") {
					const input = annotation.snapshot.input;
					const facts = taggedFactIds(input);
					const lines = [`Question (${block.name}${facts.length > 0 ? `, facts: ${facts.join(", ")}` : ""}): ${input.question}`];
					if (input.payload !== undefined && input.payload !== null) lines.push(clip(JSON.stringify(input.payload, null, 2), PLUGIN_TEXT_CAP));
					blocks.push(lines.join("\n"));
				} else if ((QUESTION_TOOLS as readonly string[]).includes(block.name)) {
					const lines = questionLines(block.name, block.arguments as Record<string, unknown> | undefined);
					if (lines.length > 0) blocks.push(lines.join("\n"));
				}
			}
		} else if (m.role === "toolResult") {
			const result = m as ToolResultMessage & LhMessage;
			if (result.isError || !result.details || typeof result.details !== "object") continue;
			if (result.lhQuestionOccurrence) {
				const owner = messages.find((o) => o.role === "assistant" && o.id === result.lhQuestionOccurrence!.messageId);
				const annotation = owner ? readPluginQuestionMessageAnnotation(owner, result.lhQuestionOccurrence.contentIndex) : null;
				const answer = annotation?.status === "posed" ? readPluginQuestionAnswer(result.details, annotation.snapshot) : null;
				if (!answer) continue;
				const lines = [`Learner's answer: ${clip(resultText(result), PLUGIN_TEXT_CAP)}`];
				const verdict = annotation?.status === "posed" ? answerVerdict({ tool: result.toolName, input: annotation.snapshot.input, answer }) : "ungraded";
				if (verdict === "correct" || verdict === "wrong") lines.push(`App verdict: ${verdict}`);
				if (answer.thinking?.trim()) lines.push(`Learner's thinking: ${answer.thinking.trim()}`);
				if (answer.readingThinking?.trim()) lines.push(`Learner's notes while reading: ${answer.readingThinking.trim()}`);
				blocks.push(lines.join("\n"));
			} else if ((QUESTION_TOOLS as readonly string[]).includes(result.toolName)) {
				const answer = result.details as unknown as QuestionAnswerData;
				blocks.push(answerLines(result.toolName, calls.get(result.toolCallId)?.args, answer).join("\n"));
			}
		}
		// custom markers: hidden scaffolding, never part of the conversation.
	}
	return capBlocks(blocks, cap);
}

function capBlocks(blocks: readonly string[], cap: number): string {
	const all = blocks.join("\n\n");
	if (all.length <= cap) return all;
	let kept = 0;
	let size = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const next = size + blocks[i]!.length + (kept > 0 ? 2 : 0);
		if (kept > 0 && next > cap) break;
		size = next;
		kept++;
	}
	return [OMITTED, ...blocks.slice(blocks.length - kept)].join("\n\n");
}

/** Up to `limit` propositions from OTHER sessions (at least one provenance
 *  point from another chat), most lexically similar to `query`, leaving
 *  out the graph ids in `exclude`. */
export function relatedPropositions(args: {
	graphNodes: readonly GraphNode[];
	chatId: string;
	query: readonly string[];
	exclude: ReadonlySet<string>;
	limit?: number;
}): GraphNode[] {
	const { graphNodes, chatId, query, exclude } = args;
	const pool = graphNodes.filter((n) => !exclude.has(n.id) && n.provenance.some((p) => p.chatId !== chatId));
	const text = query.filter((q) => q.trim()).join(" ");
	if (pool.length === 0 || !text) return [];
	const search = createPropositionCandidateSearch(pool);
	return search({ id: "query", name: "", statement: text, aliases: [] }).slice(0, args.limit ?? MENTOR_EXISTING_LIMIT).map((hit) => hit.node);
}

/** The review request's data, gathered from the record (pure). `messages`
 *  is the saved record including the answer; `events` the evidence ledger
 *  after this answer was stamped. */
export function mentorInputOf(args: {
	chatId: string;
	phase: "probe" | "teach";
	messages: readonly LhMessage[];
	tree: PlanTree | null | undefined;
	probeFacts: ProbeFacts | null | undefined;
	events: readonly EvidenceEvent[];
	graphNodes: readonly GraphNode[];
	latest: AnsweredQuestion;
}): MentorInput {
	const { chatId, phase, messages, tree, probeFacts, events, graphNodes, latest } = args;
	const knowledge = knowledgeOf(events);
	const teach = phase === "teach";
	const currentId = teach ? currentPlanNodeId(messages) : null;
	const goal = goalOf(messages);
	const numbered = (f: { id: string; statement: string; graphId: string }) => ({ id: f.id, statement: f.statement, p: knowledgeFor(knowledge, f.graphId).p });

	const ownGraphIds = new Set<string>([
		...(probeFacts?.facts ?? []).map((f) => f.graphId),
		...(tree?.nodes ?? []).flatMap((n) => (n.facts ?? []).map((f) => f.graphId)),
	]);
	const focusFacts = teach
		? (tree?.nodes.find((n) => n.id === currentId)?.facts ?? [])
		: (probeFacts?.facts ?? []);
	const related = relatedPropositions({ graphNodes, chatId, query: [goal, ...focusFacts.map((f) => f.statement)], exclude: ownGraphIds });

	const start = teach ? messages.findLastIndex((m) => m.role === "custom" && m.customType === "node-handoff") + 1 : 0;
	const transcript = mentorTranscript(messages.slice(start), { speaker: teach ? "Teacher" : "Prober", exclude: new Set([latest.messageId]) });
	const result = messages.find((m) => m.id === latest.messageId);

	return {
		phase,
		goal,
		assessment: teach ? probeAssessmentOf(messages) : null,
		probeFacts: teach ? [] : (probeFacts?.facts ?? []).map(numbered),
		plan: teach && tree
			? tree.nodes.map((n) => ({ id: n.id, title: n.title, passed: nodePassed(n, knowledge), current: n.id === currentId, facts: (n.facts ?? []).map(numbered) }))
			: [],
		road: teach && tree && currentId ? roadRecord(tree, events, knowledge, currentId) : [],
		existing: related.map((n) => ({ graphId: n.id, statement: n.statement, p: knowledgeFor(knowledge, n.id).p })),
		transcript,
		latest: {
			question: typeof (latest.input as { question?: unknown } | null)?.question === "string" ? (latest.input as { question: string }).question : "",
			facts: taggedFactIds(latest.input),
			answer: result?.role === "toolResult" ? resultText(result) : "",
			verdict: answerVerdict(latest),
		},
	};
}

/** The validation context of a review over the record (pure). */
export function mentorValidationContextOf(args: {
	phase: "probe" | "teach";
	tree: PlanTree | null | undefined;
	probeFacts: ProbeFacts | null | undefined;
	latest: AnsweredQuestion;
	liveGraphIds: ReadonlySet<string>;
}): MentorValidationContext {
	const { phase, tree, probeFacts, latest, liveGraphIds } = args;
	const planFacts = (tree?.nodes ?? []).flatMap((n) => n.facts ?? []);
	const listed = probeFacts?.facts ?? [];
	const usedGraphIds = new Map<string, string>();
	for (const f of [...listed, ...planFacts]) usedGraphIds.set(f.graphId, f.id);
	return {
		phase,
		factIds: new Set((phase === "teach" ? planFacts : listed).map((f) => f.id)),
		takenIds: new Set([...planFacts.map((f) => f.id), ...listed.map((f) => f.id), ...(tree?.nodes ?? []).map((n) => n.id)]),
		taggedFactIds: new Set(taggedFactIds(latest.input)),
		liveGraphIds,
		usedGraphIds,
	};
}
