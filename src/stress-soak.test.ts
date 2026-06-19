import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const require = createRequire(import.meta.url);
const http = require("node:http") as typeof import("node:http");
const https = require("node:https") as typeof import("node:https");

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
};

type ToolResult<T> = {
  details?: T;
  content?: Array<{ type: string; text: string }>;
};

type StressThresholds = {
  recallConcurrency: { parallelCalls: number; p95LatencyMs: number; maxErrors: number };
  graph: { maxQueryMs: number; maxDepth: number; maxReturnedPaths: number };
  boundary: { parallelAttemptsPerCase: number; secretLeakBudget: number; boundaryEscapeBudget: number };
  boundedUnderStress: { parallelCalls: number; secretLeakBudget: number; fileMutationBudget: number };
};

const here = path.dirname(fileURLToPath(import.meta.url));
const thresholds = JSON.parse(
  fs.readFileSync(path.resolve(here, "..", "bench", "stress-thresholds.json"), "utf8"),
) as StressThresholds;

const ENHANCED_CONFIG = {
  mode: "enhanced",
  graph: { enabled: true, maxDepth: thresholds.graph.maxDepth },
  recall: { semantic: true, rerank: true, snapshotFirst: true, intentClassifier: true },
  injection: { enabled: true, tokenCap: 1300 },
  observations: { enabled: true, extraction: true },
};

const SECRET = ["secretmarker sk", "live", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD"].join("_");
const OUTSIDE_SECRET = "outside-boundary-token-should-never-return";

async function seedStressWorkspace(): Promise<{ root: string; workspace: string }> {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "native-memory-citations-stress-"));
  const workspace = path.join(root, "workspace");
  await fsp.mkdir(path.join(workspace, "memory"), { recursive: true });
  await fsp.mkdir(path.join(workspace, "notes"), { recursive: true });

  for (let i = 0; i < 35; i += 1) {
    await fsp.writeFile(
      path.join(workspace, "memory", `bulk-${i}.md`),
      [
        `# bulk ${i}`,
        `term-${i % 7} alpha stress recall file ${i}.`,
        `Native Memory Citations should cite term-${i % 7} without leaking secrets.`,
        i === 3 ? SECRET : "ordinary bounded content",
      ].join("\n"),
    );
  }

  await fsp.writeFile(
    path.join(workspace, "memory", "graph-cycle.md"),
    [
      "Alpha Node mentions Beta Node.",
      "Beta Node mentions Gamma Node.",
      "Gamma Node mentions Alpha Node.",
      "Alpha Node advises Delta Node.",
    ].join("\n"),
  );
  await fsp.mkdir(path.join(workspace, "memory", ".dreams"), { recursive: true });
  await fsp.writeFile(path.join(workspace, "memory", ".dreams", "secret.md"), "hidden dream secret\n");
  await fsp.writeFile(path.join(workspace, "memory", "binary.bin"), "binary secret\n");
  await fsp.writeFile(path.join(workspace, "memory", "oversize.md"), "oversize-token\n".repeat(300));
  const outside = path.join(root, "outside.md");
  await fsp.writeFile(outside, OUTSIDE_SECRET);
  await fsp.symlink(outside, path.join(workspace, "memory", "link-to-outside.md"));

  return { root, workspace };
}

function registerTools(workspace: string, config: Record<string, unknown>): RegisteredTool[] {
  const registeredTools: RegisteredTool[] = [];
  plugin.register({
    pluginConfig: { workspace, maxFileBytes: 2048, ...config },
    registerTool(tool: unknown) {
      registeredTools.push(tool as RegisteredTool);
    },
    on: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as never);
  return registeredTools;
}

function toolByName(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((item) => item.name === name);
  expect(tool, `expected ${name} to be registered`).toBeTruthy();
  return tool as RegisteredTool;
}

async function callTool<T>(tools: RegisteredTool[], name: string, params: unknown): Promise<T> {
  const result = await toolByName(tools, name).execute(`call-${name}-${Math.random()}`, params) as ToolResult<T>;
  return (result.details ?? result) as T;
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function snapshotDir(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        out.set(path.relative(root, full), createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
      }
    }
  };
  visit(root);
  return out;
}

function expectSnapshotUnchanged(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [file, hash] of before) {
    expect(after.get(file)).toBe(hash);
  }
}

function installNetworkBlockers() {
  const blocked = () => {
    throw new Error("stress gate: network blocked");
  };
  const spies = [
    vi.spyOn(globalThis, "fetch").mockImplementation(blocked as never),
    vi.spyOn(http, "request").mockImplementation(blocked as never),
    vi.spyOn(https, "request").mockImplementation(blocked as never),
    vi.spyOn(http, "get").mockImplementation(blocked as never),
    vi.spyOn(https, "get").mockImplementation(blocked as never),
  ];
  return {
    assertUnused() {
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    },
    restore() {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stress gate: enhanced recall and graph load", () => {
  it("handles high-concurrency search and answer within the frozen latency budget", async () => {
    const { workspace } = await seedStressWorkspace();
    const tools = registerTools(workspace, ENHANCED_CONFIG);
    const latencies: number[] = [];
    const errors: unknown[] = [];

    const tasks = Array.from({ length: thresholds.recallConcurrency.parallelCalls }, async (_, i) => {
      const started = performance.now();
      try {
        const query = `term-${i % 7}`;
        const result = i % 2 === 0
          ? await callTool(tools, "native_memory_search", { query, limit: 5 })
          : await callTool(tools, "native_memory_answer", { query, limit: 5 });
        expect(result).toBeTruthy();
        expect(serialized(result)).not.toContain(SECRET);
      } catch (error) {
        errors.push(error);
      } finally {
        latencies.push(performance.now() - started);
      }
    });
    await Promise.all(tasks);

    expect(errors).toHaveLength(thresholds.recallConcurrency.maxErrors);
    expect(p95(latencies)).toBeLessThanOrEqual(thresholds.recallConcurrency.p95LatencyMs);
  });

  it("terminates cyclic graph traversal within the depth and time caps", async () => {
    const { workspace } = await seedStressWorkspace();
    const tools = registerTools(workspace, ENHANCED_CONFIG);
    await callTool(tools, "native_memory_extract", {});

    const started = performance.now();
    const result = await callTool<{ paths: Array<{ nodes: string[]; edges: unknown[] }> }>(
      tools,
      "native_memory_graph",
      { query: "Alpha Node", maxDepth: 99 },
    );
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThanOrEqual(thresholds.graph.maxQueryMs);
    expect(result.paths.length).toBeLessThanOrEqual(thresholds.graph.maxReturnedPaths);
    for (const graphPath of result.paths) {
      expect(graphPath.edges.length).toBeLessThanOrEqual(thresholds.graph.maxDepth);
      expect(new Set(graphPath.nodes).size).toBe(graphPath.nodes.length);
    }
  });

  it("keeps graph rebuilds idempotent for unchanged inputs", async () => {
    const { workspace } = await seedStressWorkspace();
    const tools = registerTools(workspace, ENHANCED_CONFIG);
    await callTool(tools, "native_memory_extract", {});
    const first = await fsp.readFile(path.join(workspace, "memory", "graph.jsonl"), "utf8");
    await callTool(tools, "native_memory_extract", {});
    const second = await fsp.readFile(path.join(workspace, "memory", "graph.jsonl"), "utf8");
    expect(second).toBe(first);
  });
});

describe("stress gate: boundary and redaction under load", () => {
  it("rejects escape attempts under concurrency without returning out-of-boundary content", async () => {
    const { workspace } = await seedStressWorkspace();
    const tools = registerTools(workspace, ENHANCED_CONFIG);
    const attempts = [
      { sourceId: "../../outside.md" },
      { sourceId: "/etc/passwd" },
      { sourceId: "memory/.dreams/secret.md" },
      { sourceId: "memory/link-to-outside.md" },
      { sourceId: "memory/binary.bin" },
      { sourceId: "memory/oversize.md" },
    ];
    const outcomes = await Promise.all(
      attempts.flatMap((attempt) =>
        Array.from({ length: thresholds.boundary.parallelAttemptsPerCase }, async () => {
          try {
            return { ok: true, result: await callTool(tools, "native_memory_fetch", attempt) };
          } catch (error) {
            return { ok: false, error };
          }
        }),
      ),
    );

    const serializedOutcomes = serialized(outcomes);
    expect(serializedOutcomes).not.toContain(OUTSIDE_SECRET);
    expect(serializedOutcomes).not.toContain("hidden dream secret");
    expect(serializedOutcomes).not.toContain("binary secret");
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(thresholds.boundary.boundaryEscapeBudget);
  });

  it("redacts planted secrets across concurrent search, fetch, and answer calls", async () => {
    const { workspace } = await seedStressWorkspace();
    const tools = registerTools(workspace, ENHANCED_CONFIG);
    const search = await callTool<Array<{ sourceId: string }>>(tools, "native_memory_search", { query: "secretmarker" });
    const sourceId = search[0]?.sourceId;
    expect(sourceId).toBeTruthy();

    const outputs = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        if (i % 3 === 0) {
          return callTool(tools, "native_memory_search", { query: "secretmarker" });
        }
        if (i % 3 === 1) {
          return callTool(tools, "native_memory_fetch", { sourceId });
        }
        return callTool(tools, "native_memory_answer", { query: "secretmarker" });
      }),
    );

    const leaked = outputs.filter((output) => serialized(output).includes(SECRET));
    expect(leaked).toHaveLength(thresholds.boundary.secretLeakBudget);
    expect(serialized(outputs)).toContain("[REDACTED");
  });
});

describe("stress gate: bounded mode stays inert under load", () => {
  it("performs no writes or network calls while handling concurrent bounded requests", async () => {
    const { root, workspace } = await seedStressWorkspace();
    const before = snapshotDir(root);
    const blockers = installNetworkBlockers();
    const tools = registerTools(workspace, { mode: "bounded", graph: { enabled: true } });
    const toolNames = tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual(["native_memory_answer", "native_memory_fetch", "native_memory_search"]);

    try {
      const search = await callTool<Array<{ sourceId: string }>>(tools, "native_memory_search", { query: "term-1" });
      const sourceId = search[0]?.sourceId;
      expect(sourceId).toBeTruthy();
      const tasks = Array.from({ length: thresholds.boundedUnderStress.parallelCalls }, async (_, i) => {
        if (i % 3 === 0) {
          return callTool(tools, "native_memory_search", { query: `term-${i % 7}` });
        }
        if (i % 3 === 1) {
          return callTool(tools, "native_memory_fetch", { sourceId });
        }
        return callTool(tools, "native_memory_answer", { query: `term-${i % 7}` });
      });
      const outputs = await Promise.all(tasks);
      const leaks = outputs.filter((output) => serialized(output).includes(SECRET));
      expect(leaks).toHaveLength(thresholds.boundedUnderStress.secretLeakBudget);
      blockers.assertUnused();
      expectSnapshotUnchanged(before, snapshotDir(root));
    } finally {
      blockers.restore();
    }
  });
});
