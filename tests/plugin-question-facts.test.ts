/**
 * Plugin teach questions carry fact tags (coach-planner design §4.4):
 * `facts` is OPTIONAL in the host-built teach parameters (historical
 * snapshots are re-validated against the current schema and must stay
 * readable), and REQUIRED at pose time by the PluginQuestionLedger whenever
 * the tagged node has facts (core/question-facts.ts pluginTeachTagProblems).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { PluginQuestionLedger } from "../src/agent/plugin-question-tools.ts";
import { createPluginQuestionParameters, preparePluginQuestionType, readPluginQuestionSnapshot, type PluginQuestionSnapshot, type PluginQuestionTypeDefinition } from "../src/core/plugin-questions.ts";
import { pluginTeachTagProblems } from "../src/core/question-facts.ts";
import { checkPluginSchema } from "../src/core/plugin-validation.ts";
import { newNodeHandoffMessage, type LhMessage } from "../src/core/native-messages.ts";
import type { PlanTree } from "../src/core/contracts.ts";

function definition(): PluginQuestionTypeDefinition {
	return { id: "example", label: "Example", contractVersion: 1, showThinking: false,
		questionSchema: Type.Object({ source: Type.String() }), answerSchema: Type.Any(),
		teach: { toolName: "ask_example", description: "Ask an example" } };
}
const occurrence = { messageId: "assistant", contentIndex: 0, toolCallId: "call", toolName: "ask_example" };
function snapshot(input: Record<string, unknown>): PluginQuestionSnapshot {
	return { protocolVersion: 1, pluginId: "fixture", typeId: "example", label: "Example", variant: "teach",
		questionId: "question", occurrence, contractVersion: 1, input,
		questionSchema: Type.Object({ source: Type.String() }), answerSchema: Type.Any(), showThinking: false,
		requiresAnswerRefinement: false } as unknown as PluginQuestionSnapshot;
}
const base = { type: "check", nodeId: "arith", question: "Question?", payload: { source: "source" } };

const TREE: PlanTree = {
	nodes: [
		{ id: "arith", title: "Arithmetic", facts: [{ id: "f-add", graphId: "n_add", statement: "Adding." }, { id: "f-sub", graphId: "n_sub", statement: "Subtracting." }] },
		{ id: "bare", title: "No facts" },
	],
	edges: [],
	version: 1,
};
const onNode = (nodeId: string) => ({ tree: TREE, messages: [newNodeHandoffMessage(nodeId, "[Node handoff] x") as LhMessage] });

test("teach parameters carry an OPTIONAL facts array; probe parameters carry none", () => {
	const prepared = preparePluginQuestionType({ ...definition(), probe: { toolName: "probe_example", description: "Probe" } });
	const teach = createPluginQuestionParameters(prepared, "teach") as unknown as { properties: Record<string, unknown>; required: string[] };
	assert.ok("facts" in teach.properties);
	assert.equal(teach.required.includes("facts"), false, "facts must stay optional (historical snapshots)");
	assert.deepEqual(teach.required, ["type", "nodeId", "question", "payload"]);
	assert.equal(checkPluginSchema(teach as never, base), true, "a call without facts is schema-valid");
	assert.equal(checkPluginSchema(teach as never, { ...base, facts: ["f-add"] }), true);
	assert.equal(checkPluginSchema(teach as never, { ...base, facts: [] }), false, "an empty list is not");
	const probe = createPluginQuestionParameters(prepared, "probe") as unknown as { properties: Record<string, unknown> };
	assert.equal("facts" in probe.properties, false);
});

test("a teach snapshot saved before facts existed still reads; a tagged one keeps its facts", () => {
	const old = readPluginQuestionSnapshot(snapshot(base));
	assert.ok(old, "an untagged historical snapshot is readable");
	assert.equal(old!.input.facts, undefined);
	const tagged = readPluginQuestionSnapshot(snapshot({ ...base, facts: ["f-add"] }));
	assert.deepEqual(tagged?.input.facts, ["f-add"]);
});

test("pluginTeachTagProblems: the current node, its facts, and facts required when the node has them", () => {
	assert.deepEqual(pluginTeachTagProblems(onNode("arith"), "arith", ["f-add"]), []);
	assert.deepEqual(pluginTeachTagProblems(onNode("arith"), "bare", undefined), ['nodeId "bare" is not the node you are teaching. The current node is "arith". Use it.']);
	assert.deepEqual(pluginTeachTagProblems(onNode("arith"), "arith", ["f-zz"]), ['fact "f-zz" is not a fact of node "arith". This node\'s facts are: f-add, f-sub']);
	assert.deepEqual(pluginTeachTagProblems(onNode("arith"), "arith", undefined), ["facts is required: list the id(s) of the fact(s) this question tests. This node's facts are: f-add, f-sub"]);
	assert.deepEqual(pluginTeachTagProblems(onNode("bare"), "bare", undefined), [], "a node without facts needs no tags");
	assert.deepEqual(pluginTeachTagProblems({ tree: TREE, messages: [] }, "arith", undefined), [], "before any handoff: node existence only");
	assert.deepEqual(pluginTeachTagProblems({ tree: TREE, messages: [] }, "ghost", undefined), ["nodeId must identify a live node in this session's plan map."]);
	assert.deepEqual(pluginTeachTagProblems(undefined, "arith", undefined), ["nodeId must identify a live node in this session's plan map."]);
});

test("the ledger enforces the tag rules at pose time and wraps a bare-string facts", async () => {
	const prepared = preparePluginQuestionType(definition());
	const record = onNode("arith");
	const ledger = new PluginQuestionLedger([{ pluginId: "fixture", definition: prepared, variant: "teach", signal: new AbortController().signal, requireActive() {} }], "chat",
		(nodeId, facts) => pluginTeachTagProblems(record, nodeId, facts));
	let listener!: (event: AgentEvent) => void;
	ledger.bind({ subscribe(callback: typeof listener) { listener = callback; } } as unknown as Agent);
	const tool = ledger.tools[0]!;
	const pose = async (id: string, raw: Record<string, unknown>) => {
		const args = tool.prepareArguments ? tool.prepareArguments(raw) as Record<string, unknown> : raw;
		const call = { type: "toolCall", id, name: "ask_example", arguments: args };
		const assistant = { role: "assistant", content: [call] } as unknown as AgentMessage;
		listener({ type: "message_start", message: assistant });
		ledger.validatedCall({ toolCall: call, assistantMessage: assistant, args } as never);
		return tool.execute(id, args) as Promise<{ isError?: boolean; details: { problems?: string[] } }>;
	};
	const missing = await pose("c1", base);
	assert.equal(missing.isError, true);
	assert.deepEqual(missing.details.problems, ["facts is required: list the id(s) of the fact(s) this question tests. This node's facts are: f-add, f-sub"]);
	const foreign = await pose("c2", { ...base, facts: ["f-zz"] });
	assert.deepEqual(foreign.details.problems, ['fact "f-zz" is not a fact of node "arith". This node\'s facts are: f-add, f-sub']);
	const elsewhere = await pose("c3", { ...base, nodeId: "bare" });
	assert.deepEqual(elsewhere.details.problems, ['nodeId "bare" is not the node you are teaching. The current node is "arith". Use it.']);
	const wrapped = await pose("c4", { ...base, facts: "f-sub" });
	assert.notEqual(wrapped.isError, true, "a bare string is wrapped into a one-item array and accepted");
});
