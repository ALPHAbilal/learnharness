/**
 * Mentor contracts (coach-planner design §4.5): the silent worker the
 * learner knows as "Coach". In code it is the `mentor` everywhere, because
 * "coach" already names the build-workspace agent.
 *
 * This file holds the review shape the worker returns (MentorReview, the
 * filled and validated `review` call), the data its validation reads
 * (MentorValidationContext), and the fixed, app-built text of the review
 * request it reads (mentorInputText). Pure and browser-safe.
 */

import type { PlanArrow } from "./plan.ts";
import type { ProbeAssessment } from "./probe.ts";
import { roadLines, type RoadEntry } from "./handoff.ts";

// ─── the review ──────────────────────────────────────────────────────────────

/** One fact the mentor adds: a new slug, a short name, the statement, and
 *  optionally the knowledge-graph id (n_…) of an existing proposition it
 *  links to instead of minting a new one. */
export interface MentorFact {
	id: string;
	name: string;
	statement: string;
	existing?: string;
}

/** One node the mentor inserts before the current node (teach phase). */
export interface MentorNode {
	id: string;
	title: string;
	facts: MentorFact[];
}

/** The mentor's `review` call, filled (every list present, possibly empty)
 *  and validated. */
export interface MentorReview {
	/** At most three short lines for whoever speaks to the learner next. */
	notes: string[];
	/** Own-words answers: the verdict per fact the question tested. */
	judged: { factId: string; correct: boolean }[];
	/** Facts to add: to the probe list (probe) or to the current node (teach). */
	addFacts: MentorFact[];
	/** Arrows between facts: premises ⇒ conclusion. */
	addArrows: PlanArrow[];
	/** Nodes to insert before the current node (teach phase only). */
	addNodes: MentorNode[];
	/** One short question only the learner can answer, or null. */
	askLearner: string | null;
}

/** What the review's validation checks against. */
export interface MentorValidationContext {
	phase: "probe" | "teach";
	/** Fact ids an arrow may name besides the facts the review adds: the
	 *  plan's facts (teach) or the probe fact list (probe). */
	factIds: ReadonlySet<string>;
	/** Ids a new fact or node may not take: every plan fact id, probe fact
	 *  id and plan node id of the session. */
	takenIds: ReadonlySet<string>;
	/** The fact ids the latest question tagged. */
	taggedFactIds: ReadonlySet<string>;
	/** Live knowledge-graph node ids (`existing` must name one). */
	liveGraphIds: ReadonlySet<string>;
	/** Graph ids already held by a fact of the plan or the probe list →
	 *  that fact's id (an `existing` link to one of them is refused). */
	usedGraphIds: ReadonlyMap<string, string>;
}

// ─── the review request ──────────────────────────────────────────────────────

/** The app's verdict on the latest answer. */
export type MentorVerdict = "correct" | "wrong" | "dont-know" | "own-words" | "ungraded";

/** One fact line: id, statement and the app's number (0–1). */
export interface MentorFactLine {
	id: string;
	statement: string;
	p: number;
}

/** What the review request text is built from (plain data; the server
 *  gathers it from the record and the stores). */
export interface MentorInput {
	phase: "probe" | "teach";
	/** The learner's goal in their own words ("" when unknown). */
	goal: string;
	/** The concluded probe_done assessment (teach phase), or null. */
	assessment: ProbeAssessment | null;
	/** The probe fact list with numbers (probe phase). */
	probeFacts: MentorFactLine[];
	/** The plan with numbers (teach phase). */
	plan: { id: string; title: string; passed: boolean; current: boolean; facts: MentorFactLine[] }[];
	/** The road record of the nodes before the current one (teach phase). */
	road: RoadEntry[];
	/** Propositions from other sessions that may be relevant. */
	existing: { graphId: string; statement: string; p: number }[];
	/** The learner-visible conversation of the current probe or node. */
	transcript: string;
	/** The latest answer. */
	latest: {
		question: string;
		/** The fact ids the question tagged. */
		facts: string[];
		/** The model-facing compact answer text (what the agent receives). */
		answer: string;
		verdict: MentorVerdict;
	};
}

const FACT_HEADING = "(id — statement — how sure the app is)";

const VERDICT_TEXT: Record<MentorVerdict, string> = {
	correct: "correct",
	wrong: "wrong",
	"dont-know": "I don't know",
	"own-words": "not graded by the app (own words) — judge it",
	ungraded: "not graded",
};

function percent(p: number): number {
	return Math.round(p * 100);
}

function factLine(f: MentorFactLine, indent = ""): string {
	return `${indent}- [${f.id}] ${f.statement} — ${percent(f.p)}%`;
}

/** The model-facing text of the review request. Sections without content
 *  are left out, heading included (except the probe's fact list, which
 *  reads "none yet" when empty). */
export function mentorInputText(input: MentorInput): string {
	const { phase, goal, assessment, probeFacts, plan, road, existing, transcript, latest } = input;
	const teach = phase === "teach";
	const sections: string[][] = [["[Review request] — written by the app."]];
	sections.push([`Phase: ${phase}`]);
	if (goal.trim()) sections.push(["Goal (the learner's own words):", goal.trim()]);
	if (teach) {
		const lines = [
			...(assessment?.strands ?? []).map((s) => `- ${s.strand}: ${s.assessment}`),
			...(assessment?.summary ? [`Summary: ${assessment.summary}`] : []),
		];
		if (lines.length > 0) sections.push(["The prober's assessment:", ...lines]);
	}
	if (!teach) {
		sections.push([`Facts to test ${FACT_HEADING}:`, ...(probeFacts.length > 0 ? probeFacts.map((f) => factLine(f)) : ["none yet"])]);
	}
	if (teach && plan.length > 0) {
		sections.push([
			"The plan (node — facts with how sure the app is):",
			...plan.flatMap((n) => [
				`- ${n.id}: ${n.title}${n.passed ? "  ✓ passed" : ""}${n.current ? "  ← current" : ""}`,
				...n.facts.map((f) => factLine(f, "  ")),
			]),
		]);
	}
	if (teach && road.length > 0) sections.push(["The road so far:", ...roadLines(road)]);
	if (existing.length > 0) {
		sections.push([
			"Existing knowledge that may be relevant (graph id — statement — how sure the app is):",
			...existing.map((e) => `- (${e.graphId}) ${e.statement} — ${percent(e.p)}%`),
		]);
	}
	if (transcript.trim()) sections.push([`The conversation of the current ${teach ? "node" : "probe"}:`, transcript]);
	sections.push([
		"The latest answer:",
		`Question: ${latest.question}`,
		`Tagged facts: ${latest.facts.length > 0 ? latest.facts.join(", ") : "none"}`,
		`Answer: ${latest.answer}`,
		`App verdict: ${VERDICT_TEXT[latest.verdict]}`,
	]);
	return sections.map((s) => s.join("\n")).join("\n\n");
}
