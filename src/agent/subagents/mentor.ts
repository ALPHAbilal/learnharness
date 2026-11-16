/**
 * THE MENTOR (coach-planner design §4.5): the silent worker the learner
 * knows as "Coach" ("coach" already names the build-workspace agent, so
 * the code says mentor). One awaited model call per learner answer, on the
 * session's own conversation engine, whose whole deliverable is one
 * validated `review` call (runSubmitAgent). It never speaks to the
 * learner; the app turns the review into evidence, plan changes and a
 * coach-card marker (core/mentor-apply.ts, server/mentor.ts).
 *
 * Reliability: the arguments are healed before validation (stringified or
 * bare-string arrays), the review is filled (every list present), and the
 * validation problems go back to the model as a retryable tool error. A
 * run that never submits or throws is retried once; a second failure
 * yields null (the turn proceeds without a review). An abort yields null
 * at once.
 */

import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { MentorFact, MentorReview, MentorValidationContext } from "../../core/contracts/mentor.ts";
import type { PiEngine } from "../models.ts";
import { effectivePromptSegments } from "../prompt-segments.ts";
import { SLUG_RE } from "../tools/mermaid-plan.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export type { MentorReview, MentorValidationContext } from "../../core/contracts/mentor.ts";

/** The submit tool's name (the instructions name it too). */
export const MENTOR_TOOL = "review";
/** Model calls per run (a first call plus two retries of a rejected one). */
export const MENTOR_MAX_TURNS = 3;
/** Notes kept from a review; extra lines are dropped, not refused. */
export const MENTOR_NOTES_CAP = 3;

/** The mentor's composed instructions: its own directory only (no shared
 *  base, no shared fragments), with the Settings prompt overrides applied
 *  exactly as composeInstructions applies them for the conversation agents. */
export function mentorInstructions(switches?: Record<string, boolean>): string {
	return effectivePromptSegments("mentor", switches ?? {})
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

// ─── the input schema ────────────────────────────────────────────────────────

const SLUG_TEXT = "a new short slug: lowercase letters and digits joined by hyphens";

const factInput = Type.Object({
	id: Type.String({ minLength: 1, description: `Fact id: ${SLUG_TEXT}, not used anywhere in the session yet.` }),
	name: Type.String({ minLength: 1, description: "A 2–5 word label for the fact." }),
	statement: Type.String({ minLength: 1, description: "The fact as one plain, true sentence." }),
	existing: Type.Optional(Type.String({ minLength: 1, description: "The knowledge-graph id (n_…) of an existing proposition shown to you; the fact links to it instead of creating a new one." })),
});

export const reviewInput = Type.Object({
	notes: Type.Array(Type.String(), { description: "At most three short lines for whoever speaks to the learner next; [] when there is nothing to say." }),
	judged: Type.Optional(Type.Array(Type.Object({
		factId: Type.String({ minLength: 1, description: "A fact id the latest question tested, exactly as shown." }),
		correct: Type.Boolean(),
	}), { description: "Own-words answers only: the verdict per fact the question tested." })),
	addFacts: Type.Optional(Type.Array(factInput, { description: "Facts to add: to the list of facts to test (probe) or to the current node (teaching)." })),
	addArrows: Type.Optional(Type.Array(Type.Object({
		premises: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Fact ids the conclusion stands on." }),
		conclusion: Type.String({ minLength: 1, description: "The fact id that stands on the premises." }),
	}), { description: "Arrows between facts: premises ⇒ conclusion. Endpoints are fact ids shown to you or added in this review." })),
	addNodes: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ minLength: 1, description: `Node id: ${SLUG_TEXT}.` }),
		title: Type.String({ minLength: 1, description: "A short title for the plan map." }),
		facts: Type.Array(factInput, { minItems: 1, maxItems: 5, description: "The node's facts (1–5)." }),
	}), { description: "Teaching only: nodes to insert before the current node, when the gap needs to be taught properly." })),
	askLearner: Type.Optional(Type.String({ description: "One short question only the learner can answer." })),
});

const REVIEW_DESCRIPTION =
	"Your review of the learner's latest answer. Call it exactly once. `notes` is required ([] when you have nothing to say); " +
	"leave out every other field you do not need. Fact and node ids you add are new short slugs (lowercase letters, digits, hyphens). " +
	"In `judged` and arrows, use the fact ids exactly as shown to you.";

// ─── argument healing ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list position: a JSON-encoded array is parsed; a bare string or a
 *  lone object is wrapped into a one-element list; an array passes. */
function asList(value: unknown): unknown {
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[")) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (Array.isArray(parsed)) return parsed;
			} catch {
				// not JSON — a bare string
			}
		}
		return [value];
	}
	if (isRecord(value)) return [value];
	return value;
}

/** The `review` heal at pi's prepareArguments seam (before validation):
 *  every list may arrive JSON-stringified, as a bare string or a lone
 *  object; null in an optional position means "left out"; nested fact
 *  lists and arrow premises are healed the same way. */
export function prepareReviewArguments(args: unknown): unknown {
	if (!isRecord(args)) return args;
	const out: Record<string, unknown> = { ...args };
	if (out.notes === null) out.notes = [];
	else if ("notes" in out) out.notes = asList(out.notes);
	for (const key of ["judged", "addFacts", "addArrows", "addNodes"]) {
		if (!(key in out)) continue;
		if (out[key] === null || out[key] === "") {
			delete out[key];
			continue;
		}
		out[key] = asList(out[key]);
	}
	if (out.askLearner === null) delete out.askLearner;
	if (Array.isArray(out.addArrows)) {
		out.addArrows = out.addArrows.map((a) => (isRecord(a) && "premises" in a ? { ...a, premises: asList(a.premises) } : a));
	}
	if (Array.isArray(out.addNodes)) {
		out.addNodes = out.addNodes.map((n) => (isRecord(n) && "facts" in n ? { ...n, facts: asList(n.facts) } : n));
	}
	return out;
}

// ─── fill + validation ───────────────────────────────────────────────────────

function fillFact(f: { id: string; name: string; statement: string; existing?: string }): MentorFact {
	const existing = typeof f.existing === "string" && f.existing.trim() ? f.existing.trim() : undefined;
	return { id: f.id.trim(), name: f.name.trim(), statement: f.statement.trim(), ...(existing !== undefined ? { existing } : {}) };
}

/** The schema-valid call → the filled review: every list present; notes
 *  trimmed, empty ones dropped, the first MENTOR_NOTES_CAP kept; an empty
 *  askLearner is null. */
export function fillReview(input: any): MentorReview {
	const notes = (Array.isArray(input?.notes) ? input.notes : [])
		.filter((n: unknown): n is string => typeof n === "string")
		.map((n: string) => n.trim())
		.filter((n: string) => n.length > 0)
		.slice(0, MENTOR_NOTES_CAP);
	const ask = typeof input?.askLearner === "string" ? input.askLearner.trim() : "";
	return {
		notes,
		judged: (input?.judged ?? []).map((j: { factId: string; correct: boolean }) => ({ factId: j.factId.trim(), correct: j.correct })),
		addFacts: (input?.addFacts ?? []).map(fillFact),
		addArrows: (input?.addArrows ?? []).map((a: { premises: string[]; conclusion: string }) => ({ premises: a.premises.map((p) => p.trim()), conclusion: a.conclusion.trim() })),
		addNodes: (input?.addNodes ?? []).map((n: { id: string; title: string; facts: MentorFact[] }) => ({ id: n.id.trim(), title: n.title.trim(), facts: n.facts.map(fillFact) })),
		askLearner: ask ? ask : null,
	};
}

/** Every problem of a filled review against the session (model-readable;
 *  each names its culprit). [] = accepted. */
export function mentorReviewProblems(review: MentorReview, ctx: MentorValidationContext): string[] {
	const problems: string[] = [];
	if (ctx.phase === "probe" && review.addNodes.length > 0) {
		problems.push(`addNodes is for teaching only; during the probe there is no plan to insert nodes into. Add the facts with addFacts instead (nodes: ${review.addNodes.map((n) => `"${n.id}"`).join(", ")}).`);
	}

	const newFactIds = new Set<string>();
	const newIds = new Set<string>();
	const existingSeen = new Map<string, string>();
	const checkId = (id: string, what: "Fact" | "Node") => {
		if (!SLUG_RE.test(id)) problems.push(`${what} id "${id}" must be ${SLUG_TEXT} (for example "list-index").`);
		if (ctx.takenIds.has(id)) problems.push(`${what} id "${id}" is already used by a fact or node of this session — pick a new id.`);
		else if (newIds.has(id)) problems.push(`${what} id "${id}" appears twice in this review — ids must be unique.`);
		newIds.add(id);
	};
	const checkFact = (fact: MentorFact) => {
		checkId(fact.id, "Fact");
		newFactIds.add(fact.id);
		if (fact.existing === undefined) return;
		if (!ctx.liveGraphIds.has(fact.existing)) {
			problems.push(`Fact "${fact.id}" names existing node "${fact.existing}", which is not in the knowledge graph — use a graph id (n_…) shown to you, or leave existing out.`);
		} else if (ctx.usedGraphIds.has(fact.existing)) {
			problems.push(`Fact "${fact.id}" names existing node "${fact.existing}", which is already fact "${ctx.usedGraphIds.get(fact.existing)}" of this session — use that fact id instead of adding it again.`);
		} else if (existingSeen.has(fact.existing)) {
			problems.push(`Facts "${existingSeen.get(fact.existing)}" and "${fact.id}" both name existing node "${fact.existing}" — add it once.`);
		} else existingSeen.set(fact.existing, fact.id);
	};
	for (const fact of review.addFacts) checkFact(fact);
	for (const node of review.addNodes) {
		checkId(node.id, "Node");
		for (const fact of node.facts) checkFact(fact);
	}

	const known = (id: string) => ctx.factIds.has(id) || newFactIds.has(id);
	for (const arrow of review.addArrows) {
		const label = `[${arrow.premises.map((p) => `"${p}"`).join(", ")}] → "${arrow.conclusion}"`;
		for (const endpoint of new Set([...arrow.premises, arrow.conclusion])) {
			if (!known(endpoint)) problems.push(`Arrow ${label} names unknown fact id "${endpoint}" — use a fact id shown to you or one you add in this review.`);
		}
	}

	const tagged = [...ctx.taggedFactIds];
	for (const j of review.judged) {
		if (ctx.taggedFactIds.has(j.factId)) continue;
		problems.push(tagged.length > 0
			? `judged names fact "${j.factId}", which the latest question did not test. It tested: ${tagged.join(", ")}.`
			: `judged names fact "${j.factId}", but the latest question tested no facts — leave judged out.`);
	}
	return problems;
}

// ─── the run ─────────────────────────────────────────────────────────────────

export interface MentorRunArgs {
	/** The session's own conversation engine. */
	engine: PiEngine;
	/** The composed instructions (mentorInstructions). */
	systemPrompt: string;
	/** The review request text (mentorInputText). */
	input: string;
	/** What the review is validated against. */
	context: MentorValidationContext;
	signal?: AbortSignal;
	/** The money channel: one call per completed model call. */
	onUsage?: (usage: Usage) => void;
}

function isAbort(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/** One review: the submit run, retried once when it never submits or
 *  throws. null after a second failure or on abort. */
export async function runMentor(args: MentorRunArgs): Promise<MentorReview | null> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		if (args.signal?.aborted) return null;
		try {
			return await runSubmitAgent<MentorReview>({
				toolName: MENTOR_TOOL,
				toolDescription: REVIEW_DESCRIPTION,
				parameters: reviewInput,
				fill: fillReview,
				validate: (value) => {
					const problems = mentorReviewProblems(value, args.context);
					// invalidInputResult bullets one problem; the join bullets the rest.
					return problems.length > 0 ? problems.join("\n- ") : null;
				},
				systemPrompt: args.systemPrompt,
				prompt: args.input,
				engine: args.engine,
				signal: args.signal,
				onStep: (usage) => args.onUsage?.(usage),
				neverSubmitted: "the coach never submitted a review",
				maxTurns: MENTOR_MAX_TURNS,
				prepareArguments: prepareReviewArguments,
				bypassWorkerRequestAdmission: true,
			});
		} catch (err) {
			if (args.signal?.aborted || isAbort(err)) return null;
			console.error(`[mentor] review run ${attempt} failed:`, err);
		}
	}
	return null;
}
