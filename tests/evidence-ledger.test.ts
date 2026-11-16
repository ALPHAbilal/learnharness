/**
 * The evidence ledger (coach-planner design §4.3): data/graph/evidence.jsonl,
 * append-only EvidenceEvent lines read through a strict shape guard. An
 * additive file — no format bump, a missing file reads as empty, reads
 * never write. Deletion purges a dead node's rows; graphRevision watches
 * the file; graphSnapshot carries the folded number as a side map.
 *
 * Runs under an isolated LH_DATA_DIR (the seam is set before any
 * config-loading import, so every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, after } from "node:test";
import type { EvidenceEvent, GraphNode } from "../src/core/contracts.ts";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-evidence-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { LEDGER_FILES, GRAPH_FORMAT_FILE } = await import("../config.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { deleteChatTraces, deleteNodeTraces } = await import("../src/core/graph-deletion.ts");
const { graphSnapshot } = await import("../src/core/graph.ts");
const { knowledgeOf } = await import("../src/core/knowledge.ts");
const { graphRevision } = await import("../src/server/graph.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function ev(nodeId: string, over: Partial<EvidenceEvent> = {}): EvidenceEvent {
	return {
		nodeId,
		chatId: "chat_ev",
		messageId: "m1",
		at: "2026-11-14T00:00:00.000Z",
		source: "quiz",
		correct: true,
		guess: 0.25,
		...over,
	};
}

function node(id: string, chatIds: string[]): GraphNode {
	return {
		id,
		name: id,
		statement: `${id} statement`,
		aliases: [],
		createdAt: "2026-11-14T00:00:00.000Z",
		provenance: chatIds.map((chatId) => ({ chatId, messageId: "" })),
	};
}

/** Fresh graph dir per scenario. */
function resetGraph(): void {
	fs.rmSync(path.dirname(LEDGER_FILES.nodes), { recursive: true, force: true });
}

describe("evidence ledger store", () => {
	it("a missing file reads as empty, and the read writes nothing (no ledger, no format sidecar)", () => {
		resetGraph();
		assert.deepEqual(graphStore.readEvidence(), []);
		assert.equal(fs.existsSync(LEDGER_FILES.evidence), false);
		assert.equal(fs.existsSync(GRAPH_FORMAT_FILE), false, "reads never stamp the family");
	});

	it("round-trips events in append order; the first append stamps format v1 (no bump)", () => {
		resetGraph();
		const a = ev("n_a", { dontKnow: true, correct: false, confidence: 40, source: "probe" });
		const b = ev("n_b", { messageId: "", source: "code", guess: 0.05 });
		graphStore.appendEvidence(a);
		graphStore.appendEvidence(b);
		assert.deepEqual(graphStore.readEvidence(), [a, b]);
		assert.equal(JSON.parse(fs.readFileSync(GRAPH_FORMAT_FILE, "utf8")).version, 1);
		assert.equal(path.basename(LEDGER_FILES.evidence), "evidence.jsonl");
		assert.equal(path.dirname(LEDGER_FILES.evidence), path.dirname(LEDGER_FILES.nodes), "lives in the graph directory");
	});

	it("skips corrupt and foreign-shaped lines (strict reads)", () => {
		resetGraph();
		const good = ev("n_good");
		graphStore.appendEvidence(good);
		const bad = [
			"{not json}",
			JSON.stringify({ ...good, source: "guesswork" }),
			JSON.stringify({ ...good, guess: 0 }),
			JSON.stringify({ ...good, guess: 1 }),
			JSON.stringify({ ...good, guess: "0.3" }),
			JSON.stringify({ ...good, correct: "yes" }),
			JSON.stringify({ ...good, dontKnow: 1 }),
			JSON.stringify({ ...good, confidence: 101 }),
			JSON.stringify({ ...good, confidence: -1 }),
			JSON.stringify({ ...good, nodeId: undefined }),
			JSON.stringify({ ...good, messageId: undefined }),
			JSON.stringify({ ...good, at: 5 }),
		];
		fs.appendFileSync(LEDGER_FILES.evidence, bad.join("\n") + "\n", "utf-8");
		assert.deepEqual(graphStore.readEvidence(), [good]);
	});

	it("rewriteLedgers replaces the evidence ledger atomically; an empty list empties it", () => {
		resetGraph();
		graphStore.appendEvidence(ev("n_a"));
		graphStore.appendEvidence(ev("n_b"));
		graphStore.rewriteLedgers({ evidence: [ev("n_b")] });
		assert.deepEqual(graphStore.readEvidence(), [ev("n_b")]);
		graphStore.rewriteLedgers({ evidence: [] });
		assert.deepEqual(graphStore.readEvidence(), []);
		assert.equal(fs.readdirSync(path.dirname(LEDGER_FILES.evidence)).filter((f) => f.includes(".tmp-")).length, 0);
	});
});

describe("evidence and deletion", () => {
	it("deleteNodeTraces drops the node's evidence rows and keeps the rest", () => {
		resetGraph();
		graphStore.appendNode(node("n_dead", ["chat_a"]));
		graphStore.appendNode(node("n_keep", ["chat_a"]));
		graphStore.appendEvidence(ev("n_dead"));
		graphStore.appendEvidence(ev("n_keep"));
		graphStore.appendEvidence(ev("n_dead", { correct: false }));
		deleteNodeTraces(graphStore, "n_dead");
		assert.deepEqual(graphStore.readEvidence(), [ev("n_keep")]);
	});

	it("deleteNodeTraces leaves the evidence file untouched when the node has no evidence", () => {
		resetGraph();
		graphStore.appendNode(node("n_quiet", ["chat_a"]));
		graphStore.appendEvidence(ev("n_other"));
		const before = fs.readFileSync(LEDGER_FILES.evidence);
		const mtime = fs.statSync(LEDGER_FILES.evidence).mtimeMs;
		deleteNodeTraces(graphStore, "n_quiet");
		assert.deepEqual(fs.readFileSync(LEDGER_FILES.evidence), before);
		assert.equal(fs.statSync(LEDGER_FILES.evidence).mtimeMs, mtime, "no rewrite, the revision does not move for it");
	});

	it("deleting an argument (arg_ id) never touches evidence", () => {
		resetGraph();
		graphStore.appendNode(node("n_p", ["chat_a"]));
		graphStore.appendNode(node("n_c", ["chat_a"]));
		graphStore.appendChain({ id: "arg_x", premises: ["n_p"], conclusion: "n_c", createdAt: "2026-11-14T00:00:00.000Z", provenance: [{ chatId: "chat_a", messageId: "" }] });
		graphStore.appendEvidence(ev("n_p"));
		deleteNodeTraces(graphStore, "arg_x");
		assert.deepEqual(graphStore.readEvidence(), [ev("n_p")]);
	});

	it("delete-nodes session deletion drops dead nodes' evidence; surviving nodes keep theirs", () => {
		resetGraph();
		graphStore.appendNode(node("n_orphan", ["chat_gone"]));
		graphStore.appendNode(node("n_shared", ["chat_gone", "chat_other"]));
		graphStore.appendEvidence(ev("n_orphan", { chatId: "chat_gone" }));
		graphStore.appendEvidence(ev("n_shared", { chatId: "chat_gone" }));
		graphStore.appendEvidence(ev("n_shared", { chatId: "chat_other" }));
		const stats = deleteChatTraces(graphStore, "chat_gone", "delete-nodes");
		assert.equal(stats.nodesRemoved, 1);
		assert.deepEqual(graphStore.readEvidence(), [ev("n_shared", { chatId: "chat_gone" }), ev("n_shared", { chatId: "chat_other" })]);
	});

	it("preserve-graph session deletion keeps all evidence", () => {
		resetGraph();
		graphStore.appendNode(node("n_orphan", ["chat_gone"]));
		graphStore.appendEvidence(ev("n_orphan", { chatId: "chat_gone" }));
		graphStore.appendCoverage({ chatId: "chat_gone", fp: "fp", tokens: 1, foldedAt: "2026-11-14T00:00:00.000Z" });
		const before = fs.readFileSync(LEDGER_FILES.evidence);
		deleteChatTraces(graphStore, "chat_gone", "preserve-graph");
		assert.deepEqual(fs.readFileSync(LEDGER_FILES.evidence), before);
	});
});

describe("evidence in the revision and the snapshot", () => {
	it("graphRevision moves when only the evidence file changes", () => {
		resetGraph();
		graphStore.appendNode(node("n_rev", ["chat_a"]));
		graphStore.appendEvidence(ev("n_rev"));
		const future = new Date(Date.now() + 3_600_000);
		fs.utimesSync(LEDGER_FILES.evidence, future, future);
		assert.ok(Math.abs(graphRevision() - future.getTime()) < 1000, "the evidence mtime is the revision");
	});

	it("graphSnapshot.knowledge: the folded number for live nodes with evidence only", () => {
		resetGraph();
		const chat = chatStore.createChat("Evidence snapshot");
		graphStore.appendNode(node("n_seen", [chat.id]));
		graphStore.appendNode(node("n_unseen", [chat.id]));
		const events = [
			ev("n_seen", { at: "2026-11-14T00:00:01.000Z" }),
			ev("n_seen", { at: "2026-11-14T00:00:02.000Z", correct: false }),
			ev("n_deleted", { at: "2026-11-14T00:00:03.000Z" }),
		];
		for (const e of events) graphStore.appendEvidence(e);
		const snap = graphSnapshot({ chatStore, graphStore });
		const expected = knowledgeOf(events).get("n_seen")!;
		assert.deepEqual(snap.knowledge, { n_seen: { p: expected.p, attempts: 2 } });
		assert.ok(!("knowledge" in snap.nodes.find((n) => n.id === "n_seen")!), "GraphNode itself is untouched");
		chatStore.deleteChat(chat.id);
	});

	it("graphSnapshot.knowledge is an empty map without evidence", () => {
		resetGraph();
		graphStore.appendNode(node("n_alone", ["chat_a"]));
		assert.deepEqual(graphSnapshot({ chatStore, graphStore }).knowledge, {});
	});
});
