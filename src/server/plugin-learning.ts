import type { PluginGraphFileData, PluginLearningData } from "../core/plugins.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { graphSnapshot } from "../core/graph.ts";

export interface PluginLearningDeps {
	directory: string;
	chatStore: ChatStore;
	graphStore: GraphStore;
	isBusy(id: string): boolean;
	isCompacting(id: string): boolean;
	readMetadata(name: "render-settings.json" | "format.json"): unknown;
}

const pluginKind = (kind: "teach" | "practice" | "infinite"): "teach" | "practice" => kind === "infinite" ? "practice" : kind;

/** A deliberately thin, read-only facade. Every read is fresh; this is not a
 * transaction spanning several files. Native transcript content is preserved.
 * Raw ledgers use the same version guards and validation as the core store. */
export function createPluginLearningData(deps: PluginLearningDeps): PluginLearningData {
	const readers: { [K in keyof PluginGraphFileData]: () => PluginGraphFileData[K] } = {
		"nodes.jsonl": () => deps.graphStore.readNodes(),
		"chains.jsonl": () => deps.graphStore.readChains(),
		"sessions.jsonl": () => deps.graphStore.readCheckpoints(),
		"coverage.jsonl": () => deps.graphStore.readCoverage(),
		"sources.json": () => deps.graphStore.readSources(),
		"positions.json": () => deps.graphStore.readPositions(),
		"render-settings.json": () => deps.readMetadata("render-settings.json"),
		"format.json": () => deps.readMetadata("format.json"),
	};
	return {
		directory: deps.directory,
		// Plugins know two session kinds. An Infinite session runs the practice
		// machinery, so it presents as practice here (plugin API unchanged).
		listSessions: () => deps.chatStore.listChats().map((s) => ({ ...s, kind: pluginKind(s.kind), busy: deps.isBusy(s.id), compacting: deps.isCompacting(s.id) })),
		getSession: (id) => {
			if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid learning session id");
			const record = deps.chatStore.getChat(id);
			return record?.kind === "infinite" ? { ...record, kind: "practice" as const } : record;
		},
		graph: () => graphSnapshot({ chatStore: deps.chatStore, graphStore: deps.graphStore }),
		readGraphFile: (name) => {
			if (!Object.hasOwn(readers, name)) throw new Error("Unknown learning-data file");
			return readers[name]();
		},
	};
}
