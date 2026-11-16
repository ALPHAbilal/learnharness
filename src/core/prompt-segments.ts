/**
 * The pure prompt-segment grammar (P2 reconciliation, 2026-09-19):
 * segment-path validation + the shared segment types, ZERO fs. Discovery
 * (reading the agent's prompt tree) lives in the agent layer
 * (src/agent/prompt-segments.ts — the canonical loader composeInstructions
 * composes through); the override-file CRUD lives in the store adapter
 * (src/store/prompt-overrides.ts). Both import THIS grammar so the
 * mirror-layout rules are defined exactly once.
 *
 * Path grammar: "system-prompt.md" (the shared base), "shared/<fragment>"
 * (sources v1: fragments shared across agents), "<agent>/<fragment>" for
 * prober, planner, teacher, practice, build and mentor — where <fragment> is numeric-prefixed + .md
 * (e.g. 20-turn.md). POSIX-relative, no traversal, no nesting.
 */

/** A prompt fragment: numeric order key + .md (e.g. 20-turn.md). Nothing else loads. */
export const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;

/** Which agent's prompt directory to compose. */
/** Practice (2026-10-04): composes ONLY its own directory — no shared
 *  teaching base, no shared fragments (the doctrine contradicts the
 *  teaching philosophy; its 00-base.md plays the base role). */
/** The mentor (coach-planner design §4.5 — the learner's "Coach") is a
 *  prompt agent but not a conversation agent: its directory composes alone. */
export type PromptAgent = "prober" | "planner" | "teacher" | "practice" | "build" | "mentor";

/** One segment of one agent's composed prompt. */
export interface PromptSegmentInfo {
	/** The override/store key — mirrors the source layout ("system-prompt.md",
	 *  "shared/30-learner-files.md", "teacher/20-turn.md"). Stable across
	 *  agents: the base and shared/ fragments use the SAME path in both
	 *  agents' lists. */
	path: string;
	/** The source text (what the segment runs without an override). */
	sourceText: string;
	/** The user's override text, or null when no file exists on disk. */
	overrideText: string | null;
	/** Effective state: the settings switch AND the file both present. */
	enabled: boolean;
	/** True for segments BOTH agents compose — the base and shared/ fragments. */
	shared: boolean;
}

/** Validate a segment path against the mirror-layout rules (see module
 *  doc). Exported for the routes, which also check membership in the
 *  CURRENT source segment list. */
export function isValidSegmentPath(segmentPath: string): boolean {
	if (segmentPath === "system-prompt.md") return true;
	const m = /^(prober|planner|teacher|practice|build|mentor|shared)\/([\w.-]+\.md)$/.exec(segmentPath);
	if (!m || m[2] === undefined) return false;
	return FRAGMENT_RE.test(m[2]);
}
