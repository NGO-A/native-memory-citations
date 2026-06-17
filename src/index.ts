import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { answerFromMemory, fetchMemorySource, searchMemory } from "./core.js";

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
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
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
  ],
});
