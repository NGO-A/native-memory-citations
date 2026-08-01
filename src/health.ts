import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHealthCheck, type HealthFinding } from "openclaw/plugin-sdk/health";
import {
  authorizedMemoryFiles,
  cacheEnvelopeHealthState,
  graphEnabled,
  graphPath,
  memoryDreamingEnabled,
  modeFromConfig,
  type OpenClawConfigLike,
  sourceIdForPath,
  type PluginConfig,
} from "./core.js";
import { droppedUnknownRegistrationCount } from "./registration-state.js";

const PLUGIN_ID = "native-memory-citations";
const EXPECTED_TOOLS = [
  "native_memory_answer",
  "native_memory_extract",
  "native_memory_fetch",
  "native_memory_graph",
  "native_memory_search",
];

let registered = false;

function pluginConfigFromOpenClawConfig(cfg: unknown): PluginConfig {
  const record = cfg as OpenClawConfigLike;
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

async function authorizedMemoryMtimes(config: PluginConfig): Promise<number[]> {
  const files = await authorizedMemoryFiles(config).catch(() => []);
  return files
    .filter((file) => sourceIdForPath(config, file.absolutePath) !== "memory/graph.jsonl")
    .map((file) => file.loaded.mtimeMs);
}

export function registerNativeMemoryHealthChecks(): void {
  if (registered) {
    return;
  }
  registered = true;

  registerHealthCheck({
    id: "native-memory-citations/cache-envelope",
    kind: "plugin",
    source: PLUGIN_ID,
    description: "Authorized memory scans remain within the documented local cache envelope.",
    async detect() {
      const state = cacheEnvelopeHealthState();
      if (!state) {
        return [];
      }
      return [{
        checkId: "native-memory-citations/cache-envelope",
        severity: "warning",
        message: `Authorized memory scan loaded ${state.files} files / ${state.bytes} bytes, exceeding the ${state.budgetBytes}-byte cache budget.`,
        source: PLUGIN_ID,
        fixHint: "Reduce the bounded local corpus to <=500 files / <=50 MB or review the scan-based scaling decision.",
      }];
    },
  });

  registerHealthCheck({
    id: "native-memory-citations/registration-shape",
    kind: "plugin",
    source: PLUGIN_ID,
    description: "Bounded mode rejects tool registration shapes it cannot positively identify.",
    async detect() {
      const dropped = droppedUnknownRegistrationCount();
      if (dropped === 0) {
        return [];
      }
      return [{
        checkId: "native-memory-citations/registration-shape",
        severity: "warning",
        message: `Bounded mode dropped ${dropped} unrecognized tool registration shape(s).`,
        source: PLUGIN_ID,
        fixHint: "Update native-memory-citations for the current OpenClaw SDK registration shape before enabling new tools.",
      }];
    },
  });

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
        severity: "warning",
        message: "native-memory-citations enhanced mode is enabled but OpenClaw memory-core dreaming is not true.",
        source: PLUGIN_ID,
        ocPath: "plugins.entries.memory-core.config.dreaming.enabled",
        fixHint: "Set plugins.entries.memory-core.config.dreaming.enabled to true yourself, or switch native-memory-citations back to mode: bounded.",
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
      const file = graphPath(config);
      const graphInfo = await stat(file).catch(() => null);
      if (!graphInfo?.isFile()) {
        return [{
          checkId: "native-memory-citations/graph-fresh",
          severity: "warning",
          message: "Enhanced graph mode is enabled but memory/graph.jsonl does not exist yet.",
          source: PLUGIN_ID,
          path: file,
          fixHint: "Run native_memory_extract to build the graph sidecar.",
        }];
      }
      const memoryMtimes = await authorizedMemoryMtimes(config);
      const newestMemory = Math.max(0, ...memoryMtimes);
      const findings: HealthFinding[] = [];
      if (newestMemory > graphInfo.mtimeMs + 1000) {
        findings.push({
          checkId: "native-memory-citations/graph-fresh",
          severity: "warning",
          message: "memory/graph.jsonl is older than at least one memory source file.",
          source: PLUGIN_ID,
          path: file,
          fixHint: "Run native_memory_extract to refresh the graph sidecar.",
        });
      }
      return findings;
    },
  });
}
