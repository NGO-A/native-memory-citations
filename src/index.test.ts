import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { enhancedLifecycleForTest } from "./enhanced.js";
import plugin from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "..", "openclaw.plugin.json");

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "native-memory-citations-index-"));
  await mkdir(path.join(workspace, "memory"), { recursive: true });
  await writeFile(path.join(workspace, "memory", "note.md"), "native memory citation plugin\n");
  return workspace;
}

function registeredPluginTools(workspace: string, pluginConfig: Record<string, unknown> = {}) {
  const registeredTools: Array<{
    name: string;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }> = [];
  plugin.register({
    pluginConfig: { workspace, ...pluginConfig },
    registerTool(tool: unknown) {
      registeredTools.push(tool as typeof registeredTools[number]);
    },
  } as never);
  return registeredTools;
}

function registeredPluginSurface(workspace: string, pluginConfig: Record<string, unknown> = {}) {
  const registeredTools: Array<{
    name: string;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }> = [];
  const registeredHooks: string[] = [];
  plugin.register({
    pluginConfig: { workspace, ...pluginConfig },
    registerTool(tool: unknown) {
      registeredTools.push(tool as typeof registeredTools[number]);
    },
    on(event: string) {
      registeredHooks.push(event);
    },
    registerHook() {
      throw new Error("enhanced lifecycle hooks must use the typed api.on hook surface");
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  } as never);
  return { registeredTools, registeredHooks };
}

function registeredHookHandlers(workspace: string, pluginConfig: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  plugin.register({
    pluginConfig: { workspace, ...pluginConfig },
    registerTool() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  } as never);
  return handlers;
}

async function waitForFileSizeAtMost(file: string, maxBytes: number): Promise<number> {
  const deadline = Date.now() + 2000;
  let lastSize = Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    const size = (await stat(file).catch(() => null))?.size ?? 0;
    lastSize = size;
    if (size > 0 && size <= maxBytes) {
      return size;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return lastSize;
}

describe("plugin manifest contract", () => {
  it("declares the expected id and tool names", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      id?: string;
      contracts?: { tools?: string[] };
    };
    expect(manifest.id).toBe("native-memory-citations");
    expect([...(manifest.contracts?.tools ?? [])].sort()).toEqual(
      [
        "native_memory_answer",
        "native_memory_extract",
        "native_memory_fetch",
        "native_memory_graph",
        "native_memory_search",
      ].sort(),
    );
  });

  it("ships a non-empty config schema so plugin config is accepted", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      configSchema?: { properties?: Record<string, unknown> };
    };
    const properties = manifest.configSchema?.properties ?? {};
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining([
        "workspace",
        "allowedRoots",
        "sharedMode",
        "maxFileBytes",
        "mode",
        "dreaming",
        "graph",
        "recall",
        "injection",
        "observations",
        "wikiBridge",
      ]),
    );
  });

  it("marks enhanced maintenance tools optional in generated metadata", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      toolMetadata?: Record<string, { optional?: boolean }>;
    };
    expect(manifest.toolMetadata?.native_memory_graph?.optional).toBe(true);
    expect(manifest.toolMetadata?.native_memory_extract?.optional).toBe(true);
  });

  it("registers enhanced tools only in enhanced mode", async () => {
    const workspace = await fixtureWorkspace();
    const boundedNames = registeredPluginTools(workspace).map((tool) => tool.name).sort();
    const enhancedNames = registeredPluginTools(workspace, { mode: "enhanced" }).map((tool) => tool.name).sort();

    expect(boundedNames).toEqual(["native_memory_answer", "native_memory_fetch", "native_memory_search"]);
    expect(enhancedNames).toEqual(
      [
        "native_memory_answer",
        "native_memory_extract",
        "native_memory_fetch",
        "native_memory_graph",
        "native_memory_search",
      ].sort(),
    );
  });

  it("registers enhanced hooks only when enhanced pillars are enabled", async () => {
    const workspace = await fixtureWorkspace();
    const bounded = registeredPluginSurface(workspace, {
      mode: "bounded",
      injection: { enabled: true },
      observations: { enabled: true },
      recall: { snapshotFirst: true },
    });
    expect(bounded.registeredHooks).toEqual([]);

    const enhanced = registeredPluginSurface(workspace, {
      mode: "enhanced",
      injection: { enabled: true },
      observations: { enabled: true },
      recall: { snapshotFirst: true },
    });
    expect(enhanced.registeredHooks.sort()).toEqual([
      "agent_end",
      "before_prompt_build",
      "cron_changed",
      "session_start",
    ].sort());
  });

  it("keeps core tools working when enhanced hooks never fire", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "MEMORY.md"), "harness neutral recall fact\n");
    const surface = registeredPluginSurface(workspace, {
      mode: "enhanced",
      graph: { enabled: true },
      injection: { enabled: true },
      observations: { enabled: true, extraction: false },
      recall: { snapshotFirst: true },
    });
    expect(surface.registeredHooks).toEqual(
      expect.arrayContaining(["agent_end", "before_prompt_build", "cron_changed", "session_start"]),
    );

    const searchTool = surface.registeredTools.find((tool) => tool.name === "native_memory_search");
    const fetchTool = surface.registeredTools.find((tool) => tool.name === "native_memory_fetch");
    const answerTool = surface.registeredTools.find((tool) => tool.name === "native_memory_answer");
    expect(searchTool).toBeTruthy();
    expect(fetchTool).toBeTruthy();
    expect(answerTool).toBeTruthy();

    const searchResult = await searchTool?.execute("call-search", { query: "harness neutral" });
    expect(searchResult).toMatchObject({
      details: [expect.objectContaining({ sourceId: "MEMORY.md" })],
    });
    const fetchResult = await fetchTool?.execute("call-fetch", { sourceId: "MEMORY.md" });
    expect(fetchResult).toMatchObject({
      details: expect.objectContaining({ content: expect.stringContaining("harness neutral recall fact") }),
    });
    const answerResult = await answerTool?.execute("call-answer", { query: "harness neutral" });
    expect(answerResult).toMatchObject({
      details: expect.objectContaining({ known: true }),
    });
  });

  it("enables host dreaming through the memory-core plugin config path", () => {
    const draft: Record<string, unknown> = {
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: { enabled: false },
            },
          },
        },
      },
    };

    enhancedLifecycleForTest.setDreamingEnabledOnConfig(draft);

    expect(draft).toMatchObject({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: { enabled: true },
            },
          },
        },
      },
    });
    expect(draft).not.toHaveProperty("memory");
  });

  it("bounds enhanced observation append storage", async () => {
    const workspace = await fixtureWorkspace();
    const handlers = registeredHookHandlers(workspace, {
      mode: "enhanced",
      observations: { enabled: true, extraction: false, maxBytes: 64 * 1024 },
    });
    const agentEnd = handlers.get("agent_end");
    expect(agentEnd).toBeTruthy();

    for (let i = 0; i < 140; i += 1) {
      agentEnd?.({ runId: `turn-${i}`, content: "observation ".repeat(120) }, {});
    }

    const observationsPath = path.join(workspace, "memory", "observations.jsonl");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const size = await waitForFileSizeAtMost(observationsPath, 64 * 1024);
    expect(size).toBeLessThanOrEqual(64 * 1024);
    const content = await readFile(observationsPath, "utf8");
    expect(content.trim().split("\n").length).toBeGreaterThan(0);
  });

  it("passes resolved plugin config into tool execute handlers", async () => {
    const workspace = await fixtureWorkspace();
    const registeredTools: Array<{
      name: string;
      execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
    }> = [];
    plugin.register({
      pluginConfig: { workspace, allowedRoots: ["USER.md"] },
      registerTool(tool: unknown) {
        registeredTools.push(tool as typeof registeredTools[number]);
      },
    } as never);

    const searchTool = registeredTools.find((tool) => tool.name === "native_memory_search");
    expect(searchTool).toBeTruthy();
    const result = await searchTool?.execute("call-1", { query: "native memory citation plugin" });
    expect(result).toMatchObject({
      details: [],
    });
  });

  it("does not expose raw fields or raw secret values through tool outputs", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "deploy.md"), "deploy_token: production-east\n");
    const registeredTools = registeredPluginTools(workspace);
    const searchTool = registeredTools.find((tool) => tool.name === "native_memory_search");
    const fetchTool = registeredTools.find((tool) => tool.name === "native_memory_fetch");
    const answerTool = registeredTools.find((tool) => tool.name === "native_memory_answer");

    const searchResult = await searchTool?.execute("call-search", { query: "production" });
    const fetchResult = await fetchTool?.execute("call-fetch", { sourceId: "memory/deploy.md" });
    const answerResult = await answerTool?.execute("call-answer", { query: "production" });
    const serialized = JSON.stringify({ searchResult, fetchResult, answerResult });

    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("rawSnippet");
    expect(serialized).not.toContain("rawMatchText");
    expect(serialized).not.toContain("production-east");
  });
});
