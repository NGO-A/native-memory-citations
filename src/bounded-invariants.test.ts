import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
const http = require("node:http") as typeof import("node:http");
const https = require("node:https") as typeof import("node:https");

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
};

const BOUNDED_TOOL_NAMES = ["native_memory_answer", "native_memory_fetch", "native_memory_search"];
const ENHANCED_TOOL_NAMES = ["native_memory_extract", "native_memory_graph"];

const BOUNDED_CONFIGS: Array<[string, Record<string, unknown>]> = [
  ["default (mode unset)", {}],
  ["explicit bounded", { mode: "bounded" }],
  [
    "mode unset with enhanced keys present",
    {
      graph: { enabled: true },
      recall: { semantic: true, rerank: true, snapshotFirst: true },
      injection: { enabled: true },
      observations: { enabled: true, extraction: true },
      dreaming: { autoEnable: true },
    },
  ],
  [
    "bounded with enhanced keys present",
    {
      mode: "bounded",
      graph: { enabled: true },
      recall: { semantic: true, rerank: true, snapshotFirst: true },
      injection: { enabled: true },
      observations: { enabled: true, extraction: true },
      dreaming: { autoEnable: true },
      wikiBridge: { enabled: true },
    },
  ],
];

const FS_WRITERS = ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "rename", "cp", "truncate"] as const;
const FS_SYNC_WRITERS = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "renameSync",
  "truncateSync",
] as const;

async function seedTestRoot(): Promise<{ root: string; workspace: string }> {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "native-memory-citations-bounded-"));
  const workspace = path.join(root, "workspace");
  await fsp.mkdir(path.join(workspace, "memory"), { recursive: true });
  await fsp.writeFile(
    path.join(workspace, "memory", "note.md"),
    [
      "# Bounded fixture",
      "",
      "- alpha memory proves bounded search stays extractive.",
      "- native_memory_answer should cite this file without a model call.",
    ].join("\n"),
  );
  await fsp.writeFile(path.join(workspace, "USER.md"), "User profile mentions alpha memory.\n");
  await fsp.mkdir(path.join(root, "plugin-state"), { recursive: true });
  return { root, workspace };
}

function snapshotDir(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(root)) {
    return out;
  }

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

function expectUnchanged(before: Map<string, string>, after: Map<string, string>): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [file, hash] of before) {
    expect(after.get(file)).toBe(hash);
  }
}

function installSideEffectSpies() {
  const fsSpies = [
    ...FS_WRITERS.map((method) => vi.spyOn(fsp, method)),
    ...FS_SYNC_WRITERS.map((method) => vi.spyOn(fs, method)),
  ];
  const networkBlocked = () => {
    throw new Error("bounded mode must not perform network I/O");
  };
  const netSpies = [
    vi.spyOn(globalThis, "fetch").mockImplementation(networkBlocked as never),
    vi.spyOn(http, "request").mockImplementation(networkBlocked as never),
    vi.spyOn(https, "request").mockImplementation(networkBlocked as never),
    vi.spyOn(http, "get").mockImplementation(networkBlocked as never),
    vi.spyOn(https, "get").mockImplementation(networkBlocked as never),
  ];

  return {
    assertNoSideEffects() {
      for (const spy of fsSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
      for (const spy of netSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    },
    restore() {
      for (const spy of [...fsSpies, ...netSpies]) {
        spy.mockRestore();
      }
    },
  };
}

function makeSpiedApi(workspace: string, config: Record<string, unknown>) {
  const registeredTools: RegisteredTool[] = [];
  const onSpy = vi.fn();
  const setConfigSpy = vi.fn();
  const modelSpy = vi.fn();
  const api = {
    pluginConfig: { workspace, ...config },
    registerTool(tool: unknown) {
      registeredTools.push(tool as RegisteredTool);
    },
    on: onSpy,
    setConfig: setConfigSpy,
    updateConfig: setConfigSpy,
    model: modelSpy,
    invokeModel: modelSpy,
    runModel: modelSpy,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
  return { api, registeredTools, onSpy, setConfigSpy, modelSpy };
}

function registerTools(workspace: string, config: Record<string, unknown>) {
  const spied = makeSpiedApi(workspace, config);
  plugin.register(spied.api as never);
  return spied;
}

function toolByName(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((item) => item.name === name);
  expect(tool, `expected tool ${name} to be registered`).toBeTruthy();
  return tool as RegisteredTool;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe.each(BOUNDED_CONFIGS)("bounded-mode invariants: %s", (_name, config) => {
  let root: string;
  let workspace: string;
  let sideEffects: ReturnType<typeof installSideEffectSpies> | undefined;

  beforeEach(async () => {
    ({ root, workspace } = await seedTestRoot());
  });

  afterEach(() => {
    sideEffects?.restore();
    vi.restoreAllMocks();
  });

  it("registers only the three read tools and no hooks", () => {
    const { registeredTools, onSpy } = registerTools(workspace, config);
    const toolNames = registeredTools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual(BOUNDED_TOOL_NAMES);
    for (const enhancedTool of ENHANCED_TOOL_NAMES) {
      expect(toolNames).not.toContain(enhancedTool);
    }
    expect(onSpy, "bounded mode must register no hooks").not.toHaveBeenCalled();
  });

  it("performs no writes, network calls, model calls, hook registration, or config mutation", async () => {
    const before = snapshotDir(root);
    const configBefore = structuredClone(config);
    sideEffects = installSideEffectSpies();
    const { registeredTools, onSpy, setConfigSpy, modelSpy } = registerTools(workspace, config);

    const searchTool = toolByName(registeredTools, "native_memory_search");
    const fetchTool = toolByName(registeredTools, "native_memory_fetch");
    const answerTool = toolByName(registeredTools, "native_memory_answer");

    const searchResult = await searchTool.execute("call-search", { query: "alpha" }) as { details?: Array<{ sourceId?: string }> };
    const hit = searchResult.details?.[0];
    expect(hit?.sourceId).toBe("memory/note.md");

    await searchTool.execute("call-search-second", { query: "native memory", contextLines: 1 });
    await fetchTool.execute("call-fetch", { sourceId: hit.sourceId, lineStart: 1, lineEnd: 4 });
    await answerTool.execute("call-answer", { query: "alpha memory" });
    await answerTool.execute("call-answer-empty", { query: "no-such-term-xyz" });
    await flushAsyncWork();

    sideEffects.assertNoSideEffects();
    expect(onSpy, "bounded mode must register no hooks").not.toHaveBeenCalled();
    expect(setConfigSpy, "bounded mode must not mutate host config").not.toHaveBeenCalled();
    expect(modelSpy, "bounded answer must remain extractive").not.toHaveBeenCalled();
    expect(config).toEqual(configBefore);
    expectUnchanged(before, snapshotDir(root));
  });
});
