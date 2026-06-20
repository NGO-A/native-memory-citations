import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  answerFromMemory,
  extractMemoryGraph,
  fetchMemorySource,
  modeFromConfig,
  queryMemoryGraph,
  searchMemory,
} from "./core.js";
import { registerEnhancedLifecycle } from "./enhanced.js";
import { registerNativeMemoryHealthChecks } from "./health.js";

registerNativeMemoryHealthChecks();

const graphEdgeType = Type.Union([
  Type.Literal("works_at"),
  Type.Literal("invested_in"),
  Type.Literal("founded"),
  Type.Literal("advises"),
  Type.Literal("attended"),
  Type.Literal("mentions"),
]);

// Declared config schema. Without this, OpenClaw applies a strict empty-object
// schema and rejects every config key below. The generated manifest is produced
// from this by `openclaw plugins build`; do not hand-edit it.
const configSchema = Type.Object(
  {
    workspace: Type.Optional(
      Type.String({
        description: "Absolute path to the OpenClaw workspace. Defaults to $OPENCLAW_WORKSPACE or ~/.openclaw/workspace.",
      }),
    ),
    allowedRoots: Type.Optional(
      Type.Array(Type.String(), {
        description: "Workspace-relative memory roots to search. Overrides the built-in default set.",
      }),
    ),
    sharedMode: Type.Optional(
      Type.Boolean({ description: "When true, exclude the private MEMORY.md from the default root set." }),
    ),
    maxFileBytes: Type.Optional(
      Type.Number({
        description: "Per-file size cap in bytes. Files larger than this are skipped. Default 1048576.",
      }),
    ),
    mode: Type.Optional(Type.Union([Type.Literal("bounded"), Type.Literal("enhanced")], {
      description: "Operating mode. bounded is default and preserves 2026.6.x behavior; enhanced enables explicitly configured pillars.",
    })),
    dreaming: Type.Optional(Type.Object({
      autoEnable: Type.Optional(Type.Boolean({ description: "In enhanced mode, allow the dreaming guard to enable OpenClaw dreaming." })),
      enforce: Type.Optional(Type.Boolean({ description: "In enhanced mode, warn when dreaming-dependent features run without host dreaming." })),
      blockToolsWhenOff: Type.Optional(Type.Boolean({ description: "In enhanced mode, make dreaming-dependent tools fail hard when dreaming is off." })),
    }, { additionalProperties: false })),
    graph: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: "Enable the local zero-LLM graph sidecar tools. Default false." })),
      edgeTypes: Type.Optional(Type.Array(graphEdgeType, {
        description: "Typed graph edges to extract.",
      })),
      maxDepth: Type.Optional(Type.Number({ description: "Maximum traversal depth for native_memory_graph. Default 3." })),
    }, { additionalProperties: false })),
    recall: Type.Optional(Type.Object({
      semantic: Type.Optional(Type.Boolean({ description: "Enhanced mode placeholder for host semantic recall fusion. Default false." })),
      rerank: Type.Optional(Type.Boolean({ description: "Enhanced mode placeholder for reranking fused candidates. Default false." })),
      snapshotFirst: Type.Optional(Type.Boolean({ description: "Enhanced mode placeholder for tier-0 snapshot recall. Default false." })),
      intentClassifier: Type.Optional(Type.Boolean({ description: "Enhanced mode placeholder for intent classification. Default false." })),
    }, { additionalProperties: false })),
    injection: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: "Enhanced mode placeholder for snapshot prompt injection. Default false." })),
      tokenCap: Type.Optional(Type.Number({ description: "Maximum injected snapshot budget. Default 1300." })),
    }, { additionalProperties: false })),
    observations: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: "Enhanced mode placeholder for observation tagging. Default false." })),
      model: Type.Optional(Type.String({ description: "Optional host model profile for future observation extraction. When omitted, use the host configured summarization or fast model." })),
      extraction: Type.Optional(Type.Boolean({ description: "When false, observation tagging uses raw append fallback. Default true." })),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum retained observations.jsonl size in bytes. Default 1048576." })),
    }, { additionalProperties: false })),
    wikiBridge: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: "Enable optional memory-wiki bridge when present. Default false." })),
    }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

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
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum hits to return. Default 8, max 50." })),
        contextLines: Type.Optional(Type.Number({ description: "Context lines around each hit. Default 2, max 8." })),
      }),
      execute: async ({ query, limit, contextLines }, config, context) => {
        context.signal?.throwIfAborted();
        return searchMemory(query, { limit, contextLines, config, signal: context.signal, logger: context.api.logger });
      },
    }),
    tool({
      name: "native_memory_fetch",
      label: "Memory Fetch (cited)",
      description: "Fetch cited local memory content by sourceId/path and optional line range.",
      parameters: Type.Object({
        sourceId: Type.Optional(Type.String({ description: "Source id returned by native_memory_search." })),
        filePath: Type.Optional(Type.String({ description: "Workspace-relative path inside an allowed memory root." })),
        lineStart: Type.Optional(Type.Number({ description: "1-based starting line." })),
        lineEnd: Type.Optional(Type.Number({ description: "1-based ending line." })),
        maxChars: Type.Optional(Type.Number({ description: "Maximum characters returned. Default 8000." })),
        expectedSha256: Type.Optional(
          Type.String({
            description: "Optional SHA-256 from a prior citation. When it differs from the current file hash, the result is marked stale.",
          }),
        ),
      }),
      execute: async (input, config, context) => {
        context.signal?.throwIfAborted();
        return fetchMemorySource(input, config);
      },
    }),
    tool({
      name: "native_memory_answer",
      label: "Memory Answer (cited)",
      description: "Answer from approved local memory using extractive snippets with citations. Says when no cited memory is found.",
      parameters: Type.Object({
        query: Type.String({ description: "Question to answer from local memory." }),
        limit: Type.Optional(Type.Number({ description: "Maximum cited search hits to consider. Default 6." })),
      }),
      execute: async ({ query, limit }, config, context) => {
        context.signal?.throwIfAborted();
        return answerFromMemory(query, { limit, config, signal: context.signal, logger: context.api.logger });
      },
    }),
    tool({
      name: "native_memory_graph",
      label: "Memory Graph (enhanced)",
      description: "Query the opt-in local memory graph sidecar. Returns no data unless mode is enhanced and graph.enabled is true.",
      optional: true,
      parameters: Type.Object({
        query: Type.String({ description: "Entity or phrase to start traversal from." }),
        maxDepth: Type.Optional(Type.Number({ description: "Maximum graph traversal depth. Default 3, max 6." })),
      }),
      execute: async ({ query, maxDepth }, config, context) => {
        context.signal?.throwIfAborted();
        return queryMemoryGraph(query, { maxDepth, config });
      },
    }),
    tool({
      name: "native_memory_extract",
      label: "Memory Graph Extract (maintenance)",
      description: "Rebuild the opt-in deterministic zero-LLM memory graph sidecar. Writes only when mode is enhanced and graph.enabled is true.",
      optional: true,
      parameters: Type.Object({}),
      execute: async (_input, config, context) => {
        context.signal?.throwIfAborted();
        return extractMemoryGraph(config, { logger: context.api.logger });
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
