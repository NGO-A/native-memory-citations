import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHealthCheck, type HealthFinding } from "openclaw/plugin-sdk/health";
import { graphEnabled, modeFromConfig, type PluginConfig, workspaceFromConfig } from "./core.js";

const PLUGIN_ID = "native-memory-citations";
const EXPECTED_TOOLS = [
  "native_memory_answer",
  "native_memory_extract",
  "native_memory_fetch",
  "native_memory_graph",
  "native_memory_search",
];

let registered = false;

type OpenClawLikeConfig = {
  memory?: { dreaming?: { enabled?: boolean } };
  plugins?: {
    entries?: Record<string, unknown>;
  };
};

function memoryDreamingEnabled(cfg: unknown): boolean {
  const record = cfg as OpenClawLikeConfig;
  if (record.memory?.dreaming?.enabled === true) {
    return true;
  }
  const memoryCore = record.plugins?.entries?.["memory-core"];
  if (memoryCore && typeof memoryCore === "object") {
    return (memoryCore as { config?: { dreaming?: { enabled?: boolean } } }).config?.dreaming?.enabled === true;
  }
  return false;
}

function pluginConfigFromOpenClawConfig(cfg: unknown): PluginConfig {
  const record = cfg as OpenClawLikeConfig;
  const entry = record.plugins?.entries?.[PLUGIN_ID];
  if (entry && typeof entry === "object") {
    const maybeConfig = (entry as { config?: unknown }).config;
    if (maybeConfig && typeof maybeConfig === "object") {
      return maybeConfig as PluginConfig;
    }
    return entry as PluginConfig;
  }
  return {};
}

async function manifestTools(): Promise<string[]> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, "..", "openclaw.plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { contracts?: { tools?: string[] } };
  return manifest.contracts?.tools ?? [];
}

async function collectMemoryMtimes(root: string): Promise<number[]> {
  const info = await stat(root).catch(() => null);
  if (!info) {
    return [];
  }
  if (info.isFile()) {
    return [info.mtimeMs];
  }
  if (!info.isDirectory()) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const mtimes: number[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      mtimes.push(...await collectMemoryMtimes(child));
    } else if (entry.isFile()) {
      const childInfo = await stat(child).catch(() => null);
      if (childInfo) {
        mtimes.push(childInfo.mtimeMs);
      }
    }
  }
  return mtimes;
}

export function registerNativeMemoryHealthChecks(): void {
  if (registered) {
    return;
  }
  registered = true;

  registerHealthCheck({
    id: "native-memory-citations/manifest-tools",
    kind: "plugin",
    source: PLUGIN_ID,
    description: "Native Memory Citations generated manifest lists the registered tools.",
    async detect() {
      const tools = await manifestTools().catch((): string[] => []);
      const missing = EXPECTED_TOOLS.filter((tool) => !tools.includes(tool));
      if (missing.length === 0) {
        return [];
      }
      return [{
        checkId: "native-memory-citations/manifest-tools",
        severity: "error",
        message: `Generated manifest is missing tools: ${missing.join(", ")}`,
        source: PLUGIN_ID,
        fixHint: "Run npm run plugin:build and commit the regenerated openclaw.plugin.json.",
      }];
    },
  });

  registerHealthCheck({
    id: "native-memory-citations/dreaming-required",
    kind: "plugin",
    source: PLUGIN_ID,
    description: "Enhanced mode warns when OpenClaw dreaming is disabled.",
    async detect(ctx) {
      const config = pluginConfigFromOpenClawConfig(ctx.cfg);
      if (modeFromConfig(config) !== "enhanced") {
        return [];
      }
      if (memoryDreamingEnabled(ctx.cfg)) {
        return [];
      }
      return [{
        checkId: "native-memory-citations/dreaming-required",
        severity: config.dreaming?.blockToolsWhenOff ? "error" : "warning",
        message: "native-memory-citations enhanced mode is enabled but OpenClaw memory-core dreaming is not true.",
        source: PLUGIN_ID,
        ocPath: "plugins.entries.memory-core.config.dreaming.enabled",
        fixHint: "Enable OpenClaw dreaming or switch native-memory-citations back to mode: bounded.",
      }];
    },
  });

  registerHealthCheck({
    id: "native-memory-citations/graph-fresh",
    kind: "plugin",
    source: PLUGIN_ID,
    description: "Enhanced graph sidecar exists and is fresh enough for configured memory files.",
    async detect(ctx) {
      const config = pluginConfigFromOpenClawConfig(ctx.cfg);
      if (!graphEnabled(config)) {
        return [];
      }
      const workspace = workspaceFromConfig(config);
      const graphPath = path.join(workspace, "memory", "graph.jsonl");
      const graphInfo = await stat(graphPath).catch(() => null);
      if (!graphInfo?.isFile()) {
        return [{
          checkId: "native-memory-citations/graph-fresh",
          severity: "warning",
          message: "Enhanced graph mode is enabled but memory/graph.jsonl does not exist yet.",
          source: PLUGIN_ID,
          path: graphPath,
          fixHint: "Run native_memory_extract to build the graph sidecar.",
        }];
      }
      const memoryMtimes = [
        ...await collectMemoryMtimes(path.join(workspace, "memory")),
        ...await collectMemoryMtimes(path.join(workspace, "MEMORY.md")),
      ];
      const newestMemory = Math.max(0, ...memoryMtimes);
      const findings: HealthFinding[] = [];
      if (newestMemory > graphInfo.mtimeMs + 1000) {
        findings.push({
          checkId: "native-memory-citations/graph-fresh",
          severity: "warning",
          message: "memory/graph.jsonl is older than at least one memory source file.",
          source: PLUGIN_ID,
          path: graphPath,
          fixHint: "Run native_memory_extract to refresh the graph sidecar.",
        });
      }
      return findings;
    },
  });
}
