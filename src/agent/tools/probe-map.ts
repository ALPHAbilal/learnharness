import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ProbeFacts, ProbeMark } from "../../core/contracts/chat.ts";
import type { EvidenceEvent } from "../../core/contracts/graph.ts";
import type { PlanArrow, PlanFact } from "../../core/contracts/plan.ts";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
import { answerVerdict, judgedEvidence, unstampedEvidence } from "../../core/evidence.ts";
import { writePlannedFacts, type PlannedArrow, type PlannedFact } from "../../core/graph.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { taggedFactIds } from "../../core/mentor-input.ts";
import { goalOf } from "../../core/plan-progress.ts";
import {
	answerEvidenceLine,
	edgeReport,
	edgeReportText,
	forcedNextFact,
	guardMark,
	nextFactLine,
	openFactsText,
	probeAnswerCounts,
	probeAnswers,
	probeAskedCount,
	probeComplete,
	probeMapText,
	proofQuotesAnswer,
} from "../../core/probe-edge.ts";
import { MAP_FIRST, OPENING_FIRST, PROBE_COMPLETE, probeGateOf } from "../../core/question-facts.ts";
import { asList, parsedArray } from "./plan.ts";
import { SLUG_RE } from "./mermaid-plan.ts";

/**
 * The prober's map tools (the prober owns the map):
 *
 *   - draw_map — once, after the opening ask_user_question is answered:
 *     4–20 facts with what each stands on. The facts become NEW knowledge-
 *     graph nodes (never linked to existing ones) and the probe map is
 *     saved with empty marks.
 *   - reflect — once after every graded probe answer: the prober's marks
 *     (state, certainty, proof) plus up to 2 new facts underneath. The app
 *     enforces "shown, not said" (probe-edge.ts guardMark): a certainty the
 *     answers do not support is lowered and the result says so; a miss
 *     after a wrong answer is stored high. An own-words (recall) answer's
 *     verdict is the state the prober gives the tested fact, written as
 *     evidence here. A tested fact's proof starts with the app's own line
 *     of what the learner answered; any other fact's proof must quote an
 *     answer of this probe. The result lists the open facts and, when two misses share
 *     an open base, the fact to ask next.
 *
 * Both are SERVER-SIDE and do NOT end the turn: the prober goes on to its
 * question (or probe_done) in the same turn. Refusals return
 * `{ ok: false, error }`, model-readable, naming the culprit; a refused
 * call writes nothing.
 */

/** What the map tools close over. */
export interface ProbeMapContext {
	chatId: string;
	chatStore: ChatStore;
	/** The knowledge graph the map's facts are written to and the evidence
	 *  ledger is read from (regardless of the graph settings switches).
	 *  Absent: the tools refuse. */
	probeGraph?: GraphStore;
}

const SLUG_RULE = "a lowercase slug (a-z, 0-9, joined by hyphens or underscores)";
/** Facts on a drawn map; PROBE_MAP_MAX is also the ceiling as reflect adds. */
const PROBE_MAP_MIN = 4;
const PROBE_MAP_MAX = 20;
const ADD_MAX = 2;
const UPDATES_MAX = 6;
/** Answers a probe may void (reflect's `void`). */
const VOID_MAX = 3;

// ─── draw_map ────────────────────────────────────────────────────────────────

const mapFactInput = Type.Object({
	id: Type.String({ minLength: 1, description: `Fact id: ${SLUG_RULE}, unique on the map. Questions tag it in \`facts\`.` }),
	statement: Type.String({ minLength: 1, description: "ONE idea in one plain, true sentence about the thing itself (never about the learner)." }),
	standsOn: Type.Array(Type.String({ minLength: 1 }), { description: "Ids of the facts (of this call) this fact needs underneath it. [] for a fact at the bottom." }),
});

export const drawMapInput = Type.Object({
	startLevel: Type.Union([Type.Literal("new"), Type.Literal("some"), Type.Literal("experienced")], { description: "The learner's level from the opening answer: new, some or experienced." }),
	facts: Type.Array(mapFactInput, { description: `${PROBE_MAP_MIN} to ${PROBE_MAP_MAX} facts, one idea each: the goal's own ideas on top, what they stand on underneath.` }),
});

type DrawMapInput = Static<typeof drawMapInput>;

/** The canonical example call (exported for description pins). */
export const drawMapExample: DrawMapInput = {
	startLevel: "new",
	facts: [
		{ id: "py-def", statement: "`def name(args):` defines a function.", standsOn: [] },
		{ id: "py-call", statement: "A function's body runs only when the function is called.", standsOn: ["py-def"] },
		{ id: "py-return", statement: "A function call evaluates to the value its `return` statement gives back.", standsOn: ["py-call"] },
		{ id: "py-decorator", statement: "A line `@something` above a `def` passes that function to `something` when the module loads.", standsOn: ["py-def"] },
		{ id: "flask-route", statement: "`@app.route(\"/hello\")` makes Flask call the function below it for requests to /hello.", standsOn: ["py-decorator"] },
		{ id: "flask-response", statement: "What a Flask view function returns becomes the body of the HTTP response.", standsOn: ["py-return", "flask-route"] },
	],
};

const DRAW_MAP_DESCRIPTION =
	`Draw the probe map, ONCE, after the opening ask_user_question was answered: ${PROBE_MAP_MIN} to ${PROBE_MAP_MAX} facts between the learner's goal and the ` +
	"ground, each with the ids of the facts it stands on (`standsOn`). List every idea the goal needs; do not merge ideas to save " +
	"space. Each fact is ONE idea in one sentence about the thing itself: two claims joined by \"and\" are two facts. " +
	`Ids are ${SLUG_RULE}. \`standsOn\` names facts of this same call; no circles; at least 2 facts must stand on another ` +
	"fact. The facts are written to the learner's knowledge graph as new facts. Everything is checked first: on any problem " +
	"nothing is saved and every problem is listed. Does not end your turn: the result shows the map; then ask your first question." +
	"\nExample arguments:\n```json\n" +
	JSON.stringify(drawMapExample, null, 2) +
	"\n```";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list field: a JSON-encoded array parses, a bare string wraps, a
 *  missing or empty value is []. */
function idList(value: unknown): unknown {
	if (value === undefined || value === null) return [];
	if (typeof value === "string" && value.trim() === "") return [];
	return asList(value);
}

/** draw_map's heal: `facts` as a JSON string parses; each fact's
 *  `standsOn` as a JSON string parses, a bare string wraps, a missing one
 *  is []. */
export function prepareDrawMapArguments(args: unknown): unknown {
	if (!isRecord(args)) return args;
	const out: Record<string, unknown> = { ...args };
	const facts = parsedArray(out.facts);
	out.facts = Array.isArray(facts) ? facts.map((f) => (isRecord(f) ? { ...f, standsOn: idList(f.standsOn) } : f)) : facts;
	return out;
}

const LEARNER_RE = /^\s*(the\s+)?learner\b/i;

function drawMapProblems(input: DrawMapInput): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	for (const fact of input.facts) {
		if (!SLUG_RE.test(fact.id)) problems.push(`Fact id "${fact.id}" must be ${SLUG_RULE}.`);
		if (ids.has(fact.id)) problems.push(`Fact id "${fact.id}" appears twice — fact ids must be unique.`);
		ids.add(fact.id);
		if (LEARNER_RE.test(fact.statement)) problems.push(`Fact "${fact.id}" is about the learner. State the thing itself ("\`d[key] = value\` adds an entry to a dict"), not what the learner can do.`);
	}
	for (const fact of input.facts) {
		for (const below of fact.standsOn) {
			if (below === fact.id) problems.push(`Fact "${fact.id}" stands on itself.`);
			else if (!ids.has(below)) problems.push(`Fact "${fact.id}" stands on "${below}", which is not a fact of this call.`);
		}
	}
	if (input.facts.length < PROBE_MAP_MIN || input.facts.length > PROBE_MAP_MAX) problems.push(`List ${PROBE_MAP_MIN} to ${PROBE_MAP_MAX} facts (you listed ${input.facts.length}).`);
	const deep = input.facts.filter((f) => f.standsOn.length > 0).length;
	if (deep < 2) problems.push(`At least 2 facts must stand on another fact (the map needs depth); ${deep === 0 ? "none does" : "only 1 does"}.`);
	const circle = cycleOf(input.facts);
	if (circle) problems.push(`The facts ${circle.map((id) => `"${id}"`).join(" → ")} stand on each other in a circle.`);
	return problems;
}

/** A circle among the facts' standsOn links, as a path that returns to
 *  its start; null when there is none. Unknown ids are ignored. */
function cycleOf(facts: readonly { id: string; standsOn: readonly string[] }[]): string[] | null {
	const below = new Map(facts.map((f) => [f.id, f.standsOn.filter((id) => id !== f.id)]));
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];
	const visit = (id: string): string[] | null => {
		if (state.get(id) === "done" || !below.has(id)) return null;
		if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
		state.set(id, "visiting");
		path.push(id);
		for (const next of below.get(id) ?? []) {
			const found = visit(next);
			if (found) return found;
		}
		path.pop();
		state.set(id, "done");
		return null;
	};
	for (const fact of facts) {
		const found = visit(fact.id);
		if (found) return found;
	}
	return null;
}

/** A short graph label for a fact: its statement's first words. */
function labelOf(statement: string): string {
	const words = statement.trim().replace(/[.\s]+$/, "").split(/\s+/);
	const label = words.slice(0, 6).join(" ");
	return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function evidenceOf(ctx: ProbeMapContext): EvidenceEvent[] {
	return ctx.probeGraph?.readEvidence() ?? [];
}

const NO_GRAPH = "The knowledge graph is not available, so the map cannot be saved.";
const LEGACY = "This probe began before draw_map and reflect existed: carry on with your questions and probe_done.";

export function drawMapTool(ctx: ProbeMapContext): AgentTool<typeof drawMapInput> {
	return {
		name: "draw_map",
		label: "draw_map",
		description: DRAW_MAP_DESCRIPTION,
		parameters: drawMapInput,
		prepareArguments: prepareDrawMapArguments as (args: unknown) => DrawMapInput,
		execute: serverExecute("draw_map", drawMapInput, async (input) => {
			const { chatId, chatStore, probeGraph } = ctx;
			const record = chatStore.getChat(chatId);
			if (!record) return { ok: false, error: `Chat not found: ${chatId}` };
			const gate = probeGateOf(record, [], chatId);
			if (gate.mode === "legacy") return { ok: false, error: LEGACY };
			if (gate.mode === "before-opening") return { ok: false, error: OPENING_FIRST };
			if (gate.mode !== "no-map") return { ok: false, error: "The map is already drawn: draw_map runs once. Use reflect to change it." };
			if (!probeGraph) return { ok: false, error: NO_GRAPH };
			const problems = drawMapProblems(input);
			if (problems.length > 0) return { ok: false, error: problems.join("\n") };

			const facts: PlannedFact[] = input.facts.map((f) => ({ id: f.id, name: labelOf(f.statement), statement: f.statement.trim() }));
			const arrows: PlanArrow[] = input.facts.filter((f) => f.standsOn.length > 0).map((f) => ({ premises: [...new Set(f.standsOn)], conclusion: f.id }));
			let ids: Record<string, string>;
			try {
				ids = writePlannedFacts(chatId, facts, arrows, { chatStore, graphStore: probeGraph }).ids;
				settleGraphLayout(probeGraph);
			} catch (err) {
				return { ok: false, error: errorText(err) };
			}
			const map: ProbeFacts = {
				facts: facts.map((f): PlanFact => ({ id: f.id, graphId: ids[f.id]!, statement: f.statement, minted: true })),
				arrows,
				startLevel: input.startLevel,
				marks: {},
			};
			chatStore.saveProbeFacts(chatId, map);
			const counts = probeAnswerCounts(map, [], chatId);
			return {
				text: `${probeMapText(map, counts, probeAskedCount(record.messages))}\n\nNow ask your first question with probe (or recall). Test one fact that is not placed.`,
				details: { ok: true },
			};
		}),
	};
}

// ─── reflect ─────────────────────────────────────────────────────────────────

const updateInput = Type.Object({
	fact: Type.String({ minLength: 1, description: "The id of a fact on the map." }),
	state: Type.Union([Type.Literal("held"), Type.Literal("missed"), Type.Literal("wrong-idea")], {
		description: "held: they have it. missed: they do not (a wrong answer, \"I don't know\", or only half of it). wrong-idea: they confidently believe something false.",
	}),
	certainty: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
		description: "How sure you are. The app lowers a certainty the answers do not support.",
	}),
	proof: Type.String({ minLength: 1, description: "The learner's own words or choice that show it." }),
	believed: Type.Optional(Type.String({ minLength: 1, description: "wrong-idea only (then required): what the learner thinks is true." })),
});

const addInput = Type.Object({
	id: Type.String({ minLength: 1, description: `A new fact id: ${SLUG_RULE}.` }),
	statement: Type.String({ minLength: 1, description: "ONE idea in one plain, true sentence." }),
	under: Type.String({ minLength: 1, description: "The id of the fact on the map that stands on this new fact." }),
});

export const reflectInput = Type.Object({
	updates: Type.Optional(Type.Array(updateInput, { description: "1 to 6 updates: every fact your last question tested, plus any other fact the answer showed something about. With `void`: 0 to 6, and the voided question's fact is left out." })),
	add: Type.Optional(Type.Array(addInput, { description: "0 to 2 new facts missing underneath a fact on the map." })),
	void: Type.Optional(Type.String({ minLength: 1, description: "Only when your own last question was flawed: a short reason. The answer is thrown away and its fact stays open." })),
});

type ReflectInput = Static<typeof reflectInput>;

/** The canonical example call (exported for description pins). */
export const reflectExample: ReflectInput = {
	updates: [
		{ fact: "py-decorator", state: "wrong-idea", certainty: "high", proof: "Chose \"it is a comment\" and wrote: the @ line is just a note for the reader.", believed: "A line starting with @ is a comment." },
		{ fact: "py-def", state: "held", certainty: "medium", proof: "Read the def line correctly in the code." },
	],
	add: [{ id: "py-functions-as-values", statement: "A function name without parentheses is a value that can be passed to another function.", under: "py-decorator" }],
};

const REFLECT_DESCRIPTION =
	"Update the probe map after the learner's answer. Required once after EVERY answer to probe/recall, before your next question " +
	"(or probe_done). `updates` must include every fact your last question tested; add any other fact the answer or the learner's " +
	`thinking showed something about. \`add\` puts up to 2 new facts under a fact on the map (${PROBE_MAP_MAX} facts at most in all). For a recall ` +
	"answer, the state you give the tested fact is the grade (held = right). The app checks each certainty against the answers and " +
	"lowers one they do not support, saying so in the result. Does not end your turn: the result shows the map and what to do next. " +
	"If your own question was flawed (wrong fact tagged, two right options, a mistake in the code), set void to a short reason: the answer is " +
	"thrown away and the fact stays open. Never void an answer because it was wrong." +
	"\nExample arguments:\n```json\n" +
	JSON.stringify(reflectExample, null, 2) +
	"\n```";

/** reflect's heal: `updates` / `add` as JSON strings parse; a missing
 *  `updates` / `add` stays missing. */
export function prepareReflectArguments(args: unknown): unknown {
	if (!isRecord(args)) return args;
	const out: Record<string, unknown> = { ...args };
	if ("updates" in out) out.updates = out.updates === null ? [] : parsedArray(out.updates);
	if ("add" in out) out.add = out.add === null ? [] : parsedArray(out.add);
	return out;
}

/** A statement compared ignoring case, whitespace and punctuation. */
function statementKey(statement: string): string {
	return statement.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function reflectTool(ctx: ProbeMapContext): AgentTool<typeof reflectInput> {
	return {
		name: "reflect",
		label: "reflect",
		description: REFLECT_DESCRIPTION,
		parameters: reflectInput,
		prepareArguments: prepareReflectArguments as (args: unknown) => ReflectInput,
		execute: serverExecute("reflect", reflectInput, async (input) => {
			const { chatId, chatStore, probeGraph } = ctx;
			const record = chatStore.getChat(chatId);
			if (!record) return { ok: false, error: `Chat not found: ${chatId}` };
			const ledger = evidenceOf(ctx);
			const gate = probeGateOf(record, ledger, chatId);
			if (gate.mode === "legacy") return { ok: false, error: LEGACY };
			if (gate.mode === "before-opening") return { ok: false, error: OPENING_FIRST };
			if (gate.mode === "no-map") return { ok: false, error: MAP_FIRST };
			if (gate.mode === "complete") return { ok: false, error: PROBE_COMPLETE };
			if (gate.mode === "open") return { ok: false, error: "There is no new answer to reflect on. Ask one question on a fact that is not placed." };
			if (!probeGraph) return { ok: false, error: NO_GRAPH };
			const { answer } = gate;
			// A void (a flawed question): the answer is cancelled — its evidence
			// rows leave the ledger and its id joins map.voided, so it counts
			// nowhere — and everything below runs on the map AFTER the void.
			const voidReason = input.void?.trim() ?? "";
			const voiding = voidReason.length > 0;
			if (voiding && (gate.map.voided?.length ?? 0) >= VOID_MAX) {
				return { ok: false, error: "Three questions have already been voided. Mark this answer as it stands." };
			}
			const isVoidedRow = (e: EvidenceEvent) => e.chatId === chatId && e.messageId === answer.messageId;
			const map: ProbeFacts = voiding ? { ...gate.map, voided: [...(gate.map.voided ?? []), answer.messageId] } : gate.map;
			const kept = voiding ? ledger.filter((e) => !isVoidedRow(e)) : ledger;
			const updates = input.updates ?? [];
			const onMap = new Map(map.facts.map((f) => [f.id, f]));
			const problems: string[] = [];
			const notes: string[] = [];

			// The updates: on the map, once each, covering the tested facts
			// (not after a void: the voided question tested nothing).
			const updatesMin = voiding ? 0 : 1;
			if (updates.length < updatesMin || updates.length > UPDATES_MAX) problems.push(`List ${updatesMin} to ${UPDATES_MAX} updates (you listed ${updates.length}).`);
			const seen = new Set<string>();
			for (const u of updates) {
				if (!onMap.has(u.fact)) problems.push(`"${u.fact}" is not a fact on the map. The map's facts: ${map.facts.map((f) => f.id).join(", ")}.`);
				else if (seen.has(u.fact)) problems.push(`"${u.fact}" is updated twice. Give one update per fact.`);
				seen.add(u.fact);
			}
			const tested = taggedFactIds(answer.input).filter((id) => onMap.has(id));
			if (!voiding) for (const id of tested) if (!seen.has(id)) problems.push(`Your last question tested "${id}". Include an update for it.`);

			// The additions: capped, then checked.
			let add = input.add ?? [];
			if (add.length > ADD_MAX) {
				notes.push(`Only ${ADD_MAX} facts can be added per reflect: dropped ${add.slice(ADD_MAX).map((a) => `"${a.id}"`).join(", ")}.`);
				add = add.slice(0, ADD_MAX);
			}
			const room = Math.max(0, PROBE_MAP_MAX - map.facts.length);
			if (add.length > room) {
				notes.push(`The map holds at most ${PROBE_MAP_MAX} facts: dropped ${add.slice(room).map((a) => `"${a.id}"`).join(", ")}.`);
				add = add.slice(0, room);
			}
			const addIds = new Set<string>();
			const statements = new Set(map.facts.map((f) => statementKey(f.statement)));
			for (const a of add) {
				if (!SLUG_RE.test(a.id)) problems.push(`New fact id "${a.id}" must be ${SLUG_RULE}.`);
				if (onMap.has(a.id) || addIds.has(a.id)) problems.push(`Fact id "${a.id}" is already taken — new facts need new ids.`);
				addIds.add(a.id);
				if (!onMap.has(a.under)) problems.push(`New fact "${a.id}" goes under "${a.under}", which is not a fact on the map.`);
				const key = statementKey(a.statement);
				if (statements.has(key)) problems.push(`New fact "${a.id}" says the same as a fact already on the map.`);
				statements.add(key);
			}

			// An own-words answer's verdict: the state given to each tested fact.
			const verdict = answerVerdict(answer);
			const now = new Date().toISOString();
			let pending: EvidenceEvent[] = [];
			if (answer.tool === "recall" && !voiding) {
				const judged = tested.flatMap((id) => {
					const u = updates.find((x) => x.fact === id);
					const fact = onMap.get(id);
					return u && fact ? [{ graphId: fact.graphId, correct: verdict !== "dont-know" && u.state === "held" }] : [];
				});
				pending = unstampedEvidence(ledger, judgedEvidence({ chatId, messageId: answer.messageId, at: now, source: "recall", judged }))
					.map((e) => (verdict === "dont-know" ? { ...e, dontKnow: true } : e));
			}

			// The certainty guard, over the answers including this verdict. The
			// proof: a tested fact's starts with what the learner answered
			// (built here); any other fact's must quote a non-voided answer.
			const counts = probeAnswerCounts(map, [...kept, ...pending], chatId);
			const evidence = answerEvidenceLine(answer);
			const quotable = probeAnswers(record.messages).filter((a) => !map.voided?.includes(a.messageId));
			const marks: Record<string, ProbeMark> = {};
			const lowered: string[] = [];
			for (const u of updates) {
				if (!onMap.has(u.fact)) continue;
				if (voiding && tested.includes(u.fact)) {
					notes.push(`"${u.fact}": not updated — the voided question tagged it, so it keeps its mark and stays open.`);
					continue;
				}
				let proof = u.proof.trim();
				if (tested.includes(u.fact)) proof = `${evidence} — ${proof}`;
				else if (!quotable.some((a) => proofQuotesAnswer(proof, a))) {
					problems.push(`Your proof for "${u.fact}" must quote the learner's own words or chosen option from an answer in this probe. Remove that update if nothing they said or chose shows it.`);
					continue;
				}
				const claim: ProbeMark = { state: u.state, certainty: u.certainty, proof, ...(u.believed?.trim() ? { believed: u.believed.trim() } : {}) };
				const guarded = guardMark(map, counts, u.fact, claim);
				if (!guarded.ok) problems.push(guarded.problem);
				else {
					marks[u.fact] = guarded.mark;
					if (guarded.lowered) lowered.push(guarded.lowered);
				}
			}
			if (problems.length > 0) return { ok: false, error: problems.join("\n") };

			// The writes: new facts to the graph, the verdicts, the map.
			let newFacts: PlanFact[] = [];
			const newArrows: PlanArrow[] = add.map((a) => ({ premises: [a.id], conclusion: a.under }));
			if (add.length > 0) {
				const planned: PlannedFact[] = add.map((a) => ({ id: a.id, name: labelOf(a.statement), statement: a.statement.trim() }));
				const plannedArrows: PlannedArrow[] = add.map((a) => ({ premises: [a.id], conclusion: onMap.get(a.under)!.graphId }));
				try {
					const ids = writePlannedFacts(chatId, planned, plannedArrows, { chatStore, graphStore: probeGraph }).ids;
					settleGraphLayout(probeGraph);
					newFacts = planned.map((f) => ({ id: f.id, graphId: ids[f.id]!, statement: f.statement, minted: true }));
				} catch (err) {
					return { ok: false, error: errorText(err) };
				}
			}
			if (voiding) probeGraph.rewriteLedgers({ evidence: probeGraph.readEvidence().filter((e) => !isVoidedRow(e)) });
			for (const event of pending) probeGraph.appendEvidence(event);
			const saved: ProbeFacts = {
				...map,
				facts: [...map.facts, ...newFacts],
				arrows: [...map.arrows, ...newArrows],
				marks: { ...(map.marks ?? {}), ...marks },
				reflected: answer.messageId,
			};
			chatStore.saveProbeFacts(chatId, saved);

			// The result: what the app lowered, the map, what to do next.
			const after = probeAnswerCounts(saved, [...kept, ...pending], chatId);
			const asked = probeAskedCount(record.messages, saved.voided);
			const voidedLine = voiding
				? `Voided: the last answer is removed and does not count.${tested.length > 0 ? ` ${tested.map((id) => `"${id}"`).join(", ")} ${tested.length === 1 ? "is" : "are"} still open.` : ""}`
				: null;
			const head = [...(voidedLine ? [voidedLine] : []), ...lowered, ...notes];
			const forced = forcedNextFact(saved, after);
			const next = probeComplete(saved, after, asked)
				? [`The probe is complete.\n\n${edgeReportText(edgeReport({ goal: goalOf(record.messages), map: saved, counts: after, questions: asked, messages: record.messages }))}\n\nCall probe_done now: one strand per line of this report, in your own words, adding nothing that is not in it.`]
				: [
					"Ask one question on a fact that is not placed. Least certain first.",
					openFactsText(saved, after),
					...(forced ? [nextFactLine(forced)] : []),
				];
			return {
				text: [...(head.length > 0 ? [head.join("\n")] : []), probeMapText(saved, after, asked), ...next].join("\n\n"),
				details: { ok: true },
			};
		}),
	};
}
