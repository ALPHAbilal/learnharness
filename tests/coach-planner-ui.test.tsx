/**
 * The coach-planner screens (design §4.10, work package 6) — render pins
 * and the two interactive seams:
 *
 *  - the plan map: latestTree reads the coach's plan-update, coach-design
 *    node states (passed / current / upcoming), per-node progress bars,
 *    dashed coach nodes + the legend, the current node's facts in the popup;
 *  - Start: under the latest plan block, one click posts once;
 *  - the coach indicator: from the initial flag and from mentor-changed,
 *    one indicator at a time;
 *  - the legacy notice and the 410 refusal parse;
 *  - the knowledge number in the chain table and the node card.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { PlanBlock, PlanPopup, latestTree, planStatusesFor, type PopupMessage } from "../components/plan-block.tsx";
import { PlanMarginalia } from "../components/plan-window.tsx";
import {
	LegacySessionNotice,
	PlanStartButton,
	TurnIndicators,
	lastPlanBlockId,
	parseLegacyRefusal,
	useCoachingState,
} from "../components/chat.tsx";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { ChainTableBody, type ChainSort } from "../components/chain-table.tsx";
import { KnownLine } from "../components/graph-view.tsx";
import { CoverageMenuBlock } from "../components/extraction-coverage.tsx";
import { legacySessionRefusal, type GraphChain, type GraphNode, type LessonProgress, type LhViewMessage, type PlanBlockData, type PlanTree } from "../src/core/index.ts";

const renderToStaticMarkup = (node: React.ReactNode) => renderMarkup(<InteractionLayersProvider>{node}</InteractionLayersProvider>);

const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "Modules", facts: [{ id: "fa1", graphId: "n_a1", statement: "A module is a file." }] },
		{ id: "b", title: "Packages", facts: [{ id: "fb1", graphId: "n_b1", statement: "A package is a folder." }, { id: "fb2", graphId: "n_b2", statement: "__init__ marks it." }] },
		{ id: "c", title: "Paths", origin: "coach", facts: [{ id: "fc1", graphId: "n_c1", statement: "sys.path lists roots." }] },
	],
	edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
	version: 3,
};

const PROGRESS: LessonProgress = {
	agentKind: "teacher",
	legacy: false,
	canAcceptPlan: false,
	currentNodeId: "b",
	nodes: { a: { passed: true, progress: 1 }, b: { passed: false, progress: 0.5 }, c: { passed: false, progress: 0 } },
	facts: {
		fa1: { p: 0.91, attempts: 2, misconception: false },
		fb1: { p: 0.886, attempts: 1, misconception: false },
		fb2: { p: 0.12, attempts: 2, misconception: true },
		fc1: { p: 0.3, attempts: 0, misconception: false },
	},
};

const planned = (tree: PlanTree): PopupMessage[] => [
	{ parts: [{ type: "tool-plan_batch", state: "output-available", output: { ok: true, tree } }] },
];

describe("latestTree: plan tool results and the coach's plan-update", () => {
	const first: PlanTree = { nodes: [{ id: "a", title: "A" }], edges: [], version: 1 };
	it("a later plan-update wins over an earlier plan result", () => {
		const msgs: PopupMessage[] = [...planned(first), { parts: [{ type: "data-plan-update", data: { tree: TREE } }] }];
		assert.equal(latestTree(msgs), TREE);
	});
	it("a later plan result wins over an earlier plan-update", () => {
		const msgs: PopupMessage[] = [{ parts: [{ type: "data-plan-update", data: { tree: TREE } }] }, ...planned(first)];
		assert.equal(latestTree(msgs), first);
	});
	it("within one group, the later part wins", () => {
		const msgs: PopupMessage[] = [{ parts: [{ type: "tool-plan_batch", state: "output-available", output: { ok: true, tree: first } }, { type: "data-plan-update", data: { tree: TREE } }] }];
		assert.equal(latestTree(msgs), TREE);
	});
});

describe("the live plan map: coach-design node states", () => {
	it("passed (check mark), current (glow), upcoming; progress bar on the started node only", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={planned(TREE)} progress={PROGRESS} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-node-a" data-status="passed"/);
		assert.match(html, /data-testid="plan-node-b" data-status="current"/);
		assert.match(html, /data-testid="plan-node-c" data-status="upcoming"/);
		assert.match(html, /data-testid="plan-node-check-a"[^>]*class="fill-none stroke-success"/);
		assert.doesNotMatch(html, /plan-node-check-b/);
		assert.match(html, /fill-yellow-400\/25/, "the current node keeps its glow");
		// b: half its facts at the pass line → a bar half the box wide.
		assert.match(html, /data-testid="plan-node-progress-b"[^>]*width="48"[^>]*height="2"[^>]*class="fill-line-strong"/);
		assert.doesNotMatch(html, /plan-node-progress-a/, "a passed node draws no bar");
		assert.doesNotMatch(html, /plan-node-progress-c/, "an unstarted node draws no bar");
	});

	it("coach-added nodes draw dashed, and the legend appears", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={planned(TREE)} progress={PROGRESS} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-node-c"[^>]*data-origin="coach"><rect[^>]*stroke-dasharray="4 3"/);
		assert.doesNotMatch(html, /data-testid="plan-node-a"[^>]*data-origin/);
		assert.match(html, /data-testid="plan-popup-legend"/);
		assert.match(html, /added by the coach/);
		const planner: PlanTree = { ...TREE, nodes: TREE.nodes.map((n) => ({ ...n, origin: undefined })) };
		const plain = renderToStaticMarkup(<PlanPopup messages={planned(planner)} progress={PROGRESS} onClose={() => {}} />);
		assert.doesNotMatch(plain, /plan-popup-legend/, "no coach node: no legend");
		assert.doesNotMatch(plain, /stroke-dasharray/);
	});

	it("the popup lists the current node's facts with numbers and the misconception marker", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={planned(TREE)} progress={PROGRESS} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-popup-facts"/);
		assert.match(html, />Packages</);
		assert.match(html, /data-testid="plan-fact-fb1"[^]*A package is a folder\.[^]*89%/);
		assert.match(html, /data-testid="plan-fact-fb2"[^]*__init__ marks it\.[^]*answered wrong with high confidence[^]*12%/);
		assert.doesNotMatch(html, /plan-fact-fa1/, "nothing for other nodes");
		assert.doesNotMatch(html, /plan-fact-misconception-fb1/);
		const none = renderToStaticMarkup(<PlanPopup messages={planned(TREE)} progress={{ ...PROGRESS, currentNodeId: null }} onClose={() => {}} />);
		assert.doesNotMatch(none, /plan-popup-facts/, "no current node: no list");
	});

	it("legacy records keep the tagged-call derivation", () => {
		const msgs: PopupMessage[] = [...planned(TREE), { parts: [{ type: "tool-quiz", state: "input-available", input: { nodeId: "a" } }] }];
		const html = renderToStaticMarkup(<PlanPopup messages={msgs} progress={{ ...PROGRESS, legacy: true }} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-node-a" data-status="current"/);
		assert.doesNotMatch(html, /data-status="passed"/);
		assert.doesNotMatch(html, /plan-popup-facts/);
	});

	it("planStatusesFor: no glow on a current node that already passed", () => {
		const s = planStatusesFor(TREE, planned(TREE), { ...PROGRESS, currentNodeId: "a" });
		assert.equal(s.statusOf("a"), "passed");
		assert.equal(s.glowId, null);
	});

	it("the marginalia reads the same states", () => {
		const html = renderToStaticMarkup(<PlanMarginalia messages={planned(TREE)} progress={PROGRESS} />);
		assert.match(html, /data-testid="plan-node-a" data-status="passed"/);
		assert.match(html, /data-testid="plan-node-progress-b"/);
	});

	it("the in-chat snapshot block stays monochrome: no dashes, bars or checks", () => {
		const data: PlanBlockData = {
			kind: "full", at: "2026-11-15T00:00:00Z", current: null,
			nodes: [{ id: "a", title: "Modules", status: "visited" }, { id: "b", title: "Packages", status: "upcoming" }],
			edges: [{ from: "a", to: "b" }],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		assert.doesNotMatch(html, /stroke-dasharray|plan-node-progress|plan-node-check/);
	});
});

describe("Start, the indicators, the legacy notice (render)", () => {
	it("lastPlanBlockId: the most recent plan block part", () => {
		const msgs: LhViewMessage[] = [
			{ id: "1", role: "assistant", parts: [{ type: "data-plan-block", id: "pb_1" }] },
			{ id: "2", role: "user", parts: [{ type: "text", text: "change it" }] },
			{ id: "3", role: "assistant", parts: [{ type: "data-plan-block", id: "pb_2" }, { type: "text", text: "Here." }] },
		];
		assert.equal(lastPlanBlockId(msgs), "pb_2");
		assert.equal(lastPlanBlockId([]), null);
	});

	it("the coach indicator replaces THINKING… — one indicator at a time", () => {
		const coach = renderToStaticMarkup(<TurnIndicators compacting={false} coaching pending evaluating={false} />);
		assert.match(coach, /data-testid="coach-reviewing"/);
		assert.match(coach, /COACH IS REVIEWING…/);
		assert.doesNotMatch(coach, /THINKING…/);
		const pending = renderToStaticMarkup(<TurnIndicators compacting={false} coaching={false} pending evaluating={false} />);
		assert.match(pending, /THINKING…/);
		assert.doesNotMatch(pending, /COACH IS REVIEWING/);
		const compacting = renderToStaticMarkup(<TurnIndicators compacting coaching={false} pending={false} evaluating={false} />);
		assert.match(compacting, /COMPACTING CONTEXT…/);
		assert.equal(renderToStaticMarkup(<TurnIndicators compacting={false} coaching={false} pending={false} evaluating={false} />), "");
	});

	it("the legacy notice carries the refusal's own words; the 410 body parses as legacy", () => {
		const html = renderToStaticMarkup(<LegacySessionNotice />);
		assert.match(html, /data-testid="legacy-session-notice"/);
		assert.ok(html.includes("This lesson was created before the coach update. It stays readable, but it cannot be continued. Start a new session to keep learning."));
		assert.equal(parseLegacyRefusal(JSON.stringify(legacySessionRefusal())), true);
		assert.equal(parseLegacyRefusal(JSON.stringify({ code: "models_not_configured", missing: [] })), false);
		assert.equal(parseLegacyRefusal("The send failed (500)."), false);
		assert.equal(parseLegacyRefusal(undefined), false);
	});
});

// ─── interactive seams (linkedom + act) ─────────────────────────────────────

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	host?.remove();
});
async function mount(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(node); });
}

describe("Start (interactive)", () => {
	it("is a focusable button; one click posts once and disables it", async () => {
		let posts = 0;
		await mount(<PlanStartButton onStart={() => posts++} />);
		const button = host!.querySelector<HTMLButtonElement>('[data-testid="plan-start"]')!;
		assert.equal(button.tagName, "BUTTON");
		assert.equal(button.textContent, "Start");
		assert.equal(button.disabled, false);
		await act(async () => { button.click(); });
		await act(async () => { button.click(); });
		assert.equal(posts, 1, "one post");
		assert.equal(button.disabled, true, "disabled at once");
	});
});

/** A source the test drives by hand (the server-events test's pattern). */
function fakeSource() {
	const events = new Map<string, Set<(data: string) => void>>();
	const src: NotifySource & { push(name: string, payload: unknown): void } = {
		close() {},
		onOpen() {},
		onEvent(name, cb) {
			const set = events.get(name) ?? new Set();
			events.set(name, set);
			set.add(cb);
		},
		push(name, payload) {
			for (const cb of events.get(name) ?? []) cb(JSON.stringify(payload));
		},
	};
	return src;
}

describe("the coach indicator (interactive)", () => {
	function Probe({ initial, onFinished }: { initial: boolean; onFinished: () => void }) {
		const coaching = useCoachingState("chat_x", initial, onFinished);
		return <TurnIndicators compacting={false} coaching={coaching} pending evaluating={false} />;
	}

	it("shows from the initial flag, follows mentor-changed for this chat only, refreshes on finish", async () => {
		const src = fakeSource();
		let finished = 0;
		await mount(<ServerEventsProvider connect={() => src}><Probe initial onFinished={() => finished++} /></ServerEventsProvider>);
		assert.ok(host!.querySelector('[data-testid="coach-reviewing"]'), "the initial snapshot flag");
		assert.ok(!host!.textContent!.includes("THINKING"), "one indicator at a time");
		await act(async () => { src.push("mentor-changed", { chatId: "other", running: false }); });
		assert.ok(host!.querySelector('[data-testid="coach-reviewing"]'), "another chat's event is ignored");
		assert.equal(finished, 0);
		await act(async () => { src.push("mentor-changed", { chatId: "chat_x", running: false }); });
		assert.equal(host!.querySelector('[data-testid="coach-reviewing"]'), null);
		assert.ok(host!.textContent!.includes("THINKING…"), "the pending placeholder returns");
		assert.equal(finished, 1, "the falling edge refreshes the progress");
		await act(async () => { src.push("mentor-changed", { chatId: "chat_x", running: true }); });
		assert.ok(host!.querySelector('[data-testid="coach-reviewing"]'), "the event turns it on");
	});
});

// ─── the knowledge number in the graph ──────────────────────────────────────

describe("the knowledge number", () => {
	const node = (id: string, statement: string): GraphNode => ({
		id, name: id, statement, aliases: [], state: "new", createdAt: "2026-11-15T00:00:00.000Z", provenance: [{ chatId: "chat1", messageId: `m_${id}` }],
	}) as unknown as GraphNode;
	const chains: GraphChain[] = [{ id: "k", premises: ["p"], conclusion: "k", provenance: [], createdAt: "2026-11-15T00:00:00.000Z" }];
	const body = (knowledge?: Record<string, { p: number; attempts: number }>) => renderToStaticMarkup(
		<ChainTableBody nodes={[node("p", "Premise."), node("k", "Conclusion.")]} chains={chains} sessions={{ chat1: "Lesson" }} fileSources={{}}
			query="" onQuery={() => {}} sort={{ col: "name", dir: 1 } as ChainSort} onSort={() => {}} selection={new Set()}
			expandedClusters={new Set(["chat1"])} expandedChains={new Set(["k"])} onToggleCluster={() => {}} onToggleChain={() => {}}
			onToggleNodes={() => {}} onClear={() => {}} onDelete={() => {}} onClose={() => {}} knowledge={knowledge} />,
	);

	it("chain table: statement rows show the percentage when the snapshot knows it", () => {
		const html = body({ p: { p: 0.876, attempts: 3 } });
		assert.match(html, /data-testid="prop-row-p"[^]*data-testid="prop-known-p"[^>]*>88%</);
		assert.doesNotMatch(html, /prop-known-k/, "no evidence: nothing");
		assert.doesNotMatch(body(), /prop-known-/);
	});

	it("node card: one line under the statement", () => {
		assert.match(renderToStaticMarkup(<KnownLine knowledge={{ p: 0.42, attempts: 3 }} />), /Known: 42% · 3 answers/);
		assert.match(renderToStaticMarkup(<KnownLine knowledge={{ p: 0.885, attempts: 1 }} />), /Known: 89% · 1 answer</);
		assert.equal(renderToStaticMarkup(<KnownLine />), "");
	});
});

// ─── coverage: hidden for coach-design teach sessions ───────────────────────

describe("the sidebar coverage block", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = realFetch; });
	const coverage = { totalMessages: 4, coveredCount: 1, uncoveredCount: 3, coveredTokens: 100, uncoveredTokens: 900, running: false, lastFoldedAt: null };
	async function menu(progress: LessonProgress) {
		globalThis.fetch = (async () => Response.json({ messages: [], coverage, progress })) as typeof globalThis.fetch;
		await mount(<CoverageMenuBlock chatId="chat_x" />);
		await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
		return host!;
	}

	it("renders nothing (no separator either) for a teach session under the coach design", async () => {
		const el = await menu({ ...PROGRESS, agentKind: "prober", currentNodeId: null });
		assert.equal(el.querySelector('[data-testid="ctx-coverage"]'), null);
		assert.equal(el.innerHTML, "");
	});

	it("keeps the block, with its separator, for a legacy teach session", async () => {
		const el = await menu({ ...PROGRESS, legacy: true });
		assert.ok(el.querySelector('[data-testid="ctx-coverage"]'));
		assert.ok(el.querySelector(".border-t"), "the separator rides the block");
	});

	it("keeps it for sessions without a lesson (practice, build)", async () => {
		const el = await menu({ ...PROGRESS, agentKind: null, currentNodeId: null, nodes: {}, facts: {} });
		assert.ok(el.querySelector('[data-testid="ctx-coverage"]'));
	});
});
