import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { answerFromMemory, fetchMemorySource, searchMemory, type PluginConfig } from "./core.js";

function pluginConfig(context: unknown): PluginConfig {
  return ((context as { pluginConfig?: PluginConfig })?.pluginConfig ?? {}) as PluginConfig;
}

export default defineToolPlugin({
  id: "native-memory-citations",
  name: "Native Memory Citations",
  description: "Search and fetch local OpenClaw memory with source citations and extractive cited answers.",
  tools: (tool) => [
    tool({
      name: "native_memory_search",
      description: "Search approved local memory roots and return snippets with source paths and line numbers.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum hits to return. Default 8, max 50." })),
        contextLines: Type.Optional(Type.Number({ description: "Context lines around each hit. Default 2, max 8." })),
      }),
      execute: async ({ query, limit, contextLines }, context) =>
        searchMemory(query, { limit, contextLines, config: pluginConfig(context) }),
    }),
    tool({
      name: "native_memory_fetch",
      description: "Fetch cited local memory content by sourceId/path and optional line range.",
      parameters: Type.Object({
        sourceId: Type.Optional(Type.String({ description: "Source id returned by native_memory_search." })),
        filePath: Type.Optional(Type.String({ description: "Workspace-relative path inside an allowed memory root." })),
        lineStart: Type.Optional(Type.Number({ description: "1-based starting line." })),
        lineEnd: Type.Optional(Type.Number({ description: "1-based ending line." })),
        maxChars: Type.Optional(Type.Number({ description: "Maximum characters returned. Default 8000." })),
      }),
      execute: async (input, context) => fetchMemorySource(input, pluginConfig(context)),
    }),
    tool({
      name: "native_memory_answer",
      description: "Answer from approved local memory using extractive snippets with citations. Says when no cited memory is found.",
      parameters: Type.Object({
        query: Type.String({ description: "Question to answer from local memory." }),
        limit: Type.Optional(Type.Number({ description: "Maximum cited search hits to consider. Default 6." })),
      }),
      execute: async ({ query, limit }, context) => answerFromMemory(query, { limit, config: pluginConfig(context) }),
    }),
  ],
});
