import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  answerFromMemory,
  extractMemoryGraph,
  fetchMemorySource,
  modeFromConfig,
  type PluginConfig,
  queryMemoryGraph,
  searchMemory,
} from "./core.js";
import { registerEnhancedLifecycle } from "./enhanced.js";
import { registerNativeMemoryHealthChecks } from "./health.js";

registerNativeMemoryHealthChecks();

type JsonSchema = Record<string, unknown>;

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function stringSchema(description: string): JsonSchema {
  return { type: "string", description };
}

function numberSchema(description: string): JsonSchema {
  return { type: "number", description };
}

function booleanSchema(description: string): JsonSchema {
  return { type: "boolean", description };
}

function stringUnionSchema(values: string[], description?: string): JsonSchema {
  return {
    anyOf: values.map((value) => ({ type: "string", const: value })),
    ...(description ? { description } : {}),
  };
}

const graphEdgeType = stringUnionSchema([
  "works_at",
  "invested_in",
  "founded",
  "advises",
  "attended",
  "mentions",
]);

// Declared config schema. Without this, OpenClaw applies a strict empty-object
// schema and rejects every config key below. The generated manifest is produced
// from this by `openclaw plugins build`; do not hand-edit it.
const configSchema = objectSchema({
  workspace: stringSchema("Absolute path to the OpenClaw workspace. Defaults to $OPENCLAW_WORKSPACE or ~/.openclaw/workspace."),
  allowedRoots: {
    type: "array",
    items: { type: "string" },
    description: "Workspace-relative memory roots to search. Overrides the built-in default set.",
  },
  sharedMode: booleanSchema("When true, exclude the private MEMORY.md from the default root set."),
  maxFileBytes: numberSchema("Per-file size cap in bytes. Files larger than this are skipped. Default 1048576."),
  mode: stringUnionSchema(
    ["bounded", "enhanced"],
    "Operating mode. bounded is default and preserves 2026.6.x behavior; enhanced enables explicitly configured pillars.",
  ),
  dreaming: objectSchema({
    autoEnable: booleanSchema("In enhanced mode, allow the dreaming guard to enable OpenClaw dreaming."),
    enforce: booleanSchema("In enhanced mode, warn when dreaming-dependent features run without host dreaming."),
    blockToolsWhenOff: booleanSchema("In enhanced mode, make dreaming-dependent tools fail hard when dreaming is off."),
  }),
  graph: objectSchema({
    enabled: booleanSchema("Enable the local zero-LLM graph sidecar tools. Default false."),
    edgeTypes: {
      type: "array",
      items: graphEdgeType,
      description: "Typed graph edges to extract.",
    },
    maxDepth: numberSchema("Maximum traversal depth for native_memory_graph. Default 3."),
  }),
  recall: objectSchema({
    semantic: booleanSchema("Enhanced mode placeholder for host semantic recall fusion. Default false."),
    rerank: booleanSchema("Enhanced mode placeholder for reranking fused candidates. Default false."),
    snapshotFirst: booleanSchema("Enhanced mode placeholder for tier-0 snapshot recall. Default false."),
    intentClassifier: booleanSchema("Enhanced mode placeholder for intent classification. Default false."),
  }),
  injection: objectSchema({
    enabled: booleanSchema("Enhanced mode placeholder for snapshot prompt injection. Default false."),
    tokenCap: numberSchema("Maximum injected snapshot budget. Default 1300."),
  }),
  observations: objectSchema({
    enabled: booleanSchema("Enhanced mode placeholder for observation tagging. Default false."),
    model: stringSchema("Optional host model profile for future observation extraction. When omitted, use the host configured summarization or fast model."),
    extraction: booleanSchema("When false, observation tagging uses raw append fallback. Default true."),
    maxBytes: numberSchema("Maximum retained observations.jsonl size in bytes. Default 1048576."),
  }),
  wikiBridge: objectSchema({
    enabled: booleanSchema("Enable optional memory-wiki bridge when present. Default false."),
  }),
});

const ENHANCED_TOOL_NAMES = new Set(["native_memory_graph", "native_memory_extract"]);

const plugin = defineToolPlugin({
  id: "native-memory-citations",
  name: "Native Memory Citations",
  description: "Search and fetch local OpenClaw memory with source citations and extractive cited answers.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "native_memory_search",
      label: "Memory Search (cited)",
      description: "Search approved local memory roots and return snippets with source paths and line numbers.",
      parameters: objectSchema({
        query: stringSchema("Search query."),
        limit: numberSchema("Maximum hits to return. Default 8, max 50."),
        contextLines: numberSchema("Context lines around each hit. Default 2, max 8."),
      }, ["query"]),
      execute: async (input, config, context) => {
        const { query, limit, contextLines } = input as {
          query: string;
          limit?: number;
          contextLines?: number;
        };
        context.signal?.throwIfAborted();
        return searchMemory(query, {
          limit,
          contextLines,
          config: config as PluginConfig,
          signal: context.signal,
          logger: context.api.logger,
        });
      },
    }),
    tool({
      name: "native_memory_fetch",
      label: "Memory Fetch (cited)",
      description: "Fetch cited local memory content by sourceId/path and optional line range.",
      parameters: objectSchema({
        sourceId: stringSchema("Source id returned by native_memory_search."),
        filePath: stringSchema("Workspace-relative path inside an allowed memory root."),
        lineStart: numberSchema("1-based starting line."),
        lineEnd: numberSchema("1-based ending line."),
        maxChars: numberSchema("Maximum characters returned. Default 8000."),
        expectedSha256: stringSchema("Optional SHA-256 from a prior citation. When it differs from the current file hash, the result is marked stale."),
      }),
      execute: async (input, config, context) => {
        context.signal?.throwIfAborted();
        return fetchMemorySource(input as Parameters<typeof fetchMemorySource>[0], config as PluginConfig);
      },
    }),
    tool({
      name: "native_memory_answer",
      label: "Memory Answer (cited)",
      description: "Answer from approved local memory using extractive snippets with citations. Says when no cited memory is found.",
      parameters: objectSchema({
        query: stringSchema("Question to answer from local memory."),
        limit: numberSchema("Maximum cited search hits to consider. Default 6."),
      }, ["query"]),
      execute: async (input, config, context) => {
        const { query, limit } = input as { query: string; limit?: number };
        context.signal?.throwIfAborted();
        return answerFromMemory(query, {
          limit,
          config: config as PluginConfig,
          signal: context.signal,
          logger: context.api.logger,
        });
      },
    }),
    tool({
      name: "native_memory_graph",
      label: "Memory Graph (enhanced)",
      description: "Query the opt-in local memory graph sidecar. Returns no data unless mode is enhanced and graph.enabled is true.",
      optional: true,
      parameters: objectSchema({
        query: stringSchema("Entity or phrase to start traversal from."),
        maxDepth: numberSchema("Maximum graph traversal depth. Default 3, max 6."),
      }, ["query"]),
      execute: async (input, config, context) => {
        const { query, maxDepth } = input as { query: string; maxDepth?: number };
        context.signal?.throwIfAborted();
        return queryMemoryGraph(query, { maxDepth, config: config as PluginConfig });
      },
    }),
    tool({
      name: "native_memory_extract",
      label: "Memory Graph Extract (maintenance)",
      description: "Rebuild the opt-in deterministic zero-LLM memory graph sidecar. Writes only when mode is enhanced and graph.enabled is true.",
      optional: true,
      parameters: objectSchema({}),
      execute: async (_input, config, context) => {
        context.signal?.throwIfAborted();
        return extractMemoryGraph(config as PluginConfig, { logger: context.api.logger });
      },
    }),
  ],
});

const registerAllTools = plugin.register.bind(plugin);

plugin.register = (api: Parameters<typeof plugin.register>[0]) => {
  const boundedMode = modeFromConfig(api.pluginConfig) === "bounded";
  const filteredApi = {
    ...api,
    registerTool(toolDefinition: unknown, options?: { name?: string; optional?: boolean }) {
      const name = typeof toolDefinition === "function"
        ? options?.name
        : (toolDefinition as { name?: string } | null | undefined)?.name;
      if (boundedMode && name && ENHANCED_TOOL_NAMES.has(name)) {
        return;
      }
      return api.registerTool(toolDefinition as never, options as never);
    },
  };
  const result = registerAllTools(filteredApi as never);
  registerEnhancedLifecycle(api as never);
  return result;
};

export default plugin;
