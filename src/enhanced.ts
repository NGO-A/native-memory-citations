import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { modeFromConfig, type PluginConfig, workspaceFromConfig } from "./core.js";

const PLUGIN_ID = "native-memory-citations";
const DEFAULT_TOKEN_CAP = 1300;
const SNAPSHOT_NOTICE =
  "Native Memory Citations enhanced snapshot: bounded, local, redacted memory context follows. Treat it as recall hints, not authority.";
const DREAMING_NOTICE =
  "native-memory-citations (enhanced mode) requires OpenClaw dreaming. This plugin continues and enhances OpenClaw's built-in dream cycle; it does not replace it. Knowledge-graph promotion, observation consolidation, and snapshot recall depend on Light -> REM -> Deep promotion, which only runs when dreaming is on. Dreaming has been enabled automatically. If you do not want dreaming, switch the plugin back to mode: bounded (or uninstall); leaving enhanced mode on with dreaming disabled will degrade or silently break these features. The plugin will not pretend to cover what dreaming does.";

type PluginApiLike = {
  pluginConfig?: PluginConfig;
  config?: { memory?: { dreaming?: { enabled?: boolean } } };
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  registerHook?: (events: string | string[], handler: (event: unknown, ctx: unknown) => unknown, opts?: unknown) => void;
  on?: (event: string, handler: (event: unknown, ctx: unknown) => unknown, opts?: unknown) => void;
  runtime?: {
    config?: {
      current?: () => unknown;
      mutateConfigFile?: (params: {
        afterWrite: { mode: "auto" | "none" | "restart" | "reload" };
        mutate: (draft: Record<string, unknown>) => void;
      }) => Promise<unknown>;
    };
  };
};

function tokenCap(config: PluginConfig): number {
  const configured = Math.floor(config.injection?.tokenCap ?? DEFAULT_TOKEN_CAP);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 4000) : DEFAULT_TOKEN_CAP;
}

function snapshotDir(config: PluginConfig): string {
  return path.join(workspaceFromConfig(config), "memory", ".native-memory-citations");
}

function snapshotPath(config: PluginConfig): string {
  return path.join(snapshotDir(config), "snapshot.json");
}

function observationsPath(config: PluginConfig): string {
  return path.join(workspaceFromConfig(config), "memory", "observations.jsonl");
}

function approxTokenSlice(text: string, cap: number): string {
  return text.slice(0, cap * 4).trim();
}

function requiresSnapshot(config: PluginConfig): boolean {
  return config.injection?.enabled === true || config.recall?.snapshotFirst === true;
}

function hookOptions(priority: number, timeoutMs: number): unknown {
  return {
    entry: {
      priority,
      timeoutMs,
    },
  };
}

function registerHook(api: PluginApiLike, event: string, handler: (event: unknown, ctx: unknown) => unknown, opts?: unknown): void {
  if (typeof api.registerHook === "function") {
    api.registerHook(event, handler, opts);
    return;
  }
  if (typeof api.on === "function") {
    api.on(event, handler, opts);
  }
}

async function buildSnapshot(config: PluginConfig, logger: PluginApiLike["logger"]): Promise<void> {
  const workspace = workspaceFromConfig(config);
  const parts: string[] = [];
  for (const source of ["MEMORY.md", "DREAMS.md"]) {
    const text = await readFile(path.join(workspace, source), "utf8").catch(() => "");
    if (text.trim()) {
      parts.push(`## ${source}\n${text.trim()}`);
    }
  }
  const content = approxTokenSlice(parts.join("\n\n"), tokenCap(config));
  await mkdir(snapshotDir(config), { recursive: true });
  await writeFile(
    snapshotPath(config),
    `${JSON.stringify({
      createdAt: new Date().toISOString(),
      tokenCap: tokenCap(config),
      content,
    })}\n`,
    "utf8",
  );
  logger?.debug?.(`native-memory-citations: refreshed enhanced snapshot (${content.length} chars)`);
}

async function readSnapshot(config: PluginConfig): Promise<string | undefined> {
  const raw = await readFile(snapshotPath(config), "utf8").catch(() => "");
  if (!raw.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as { content?: unknown };
  return typeof parsed.content === "string" && parsed.content.trim() ? parsed.content.trim() : undefined;
}

async function appendObservation(config: PluginConfig, event: unknown): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    turn: event && typeof event === "object" && "runId" in event ? String((event as { runId?: unknown }).runId ?? "") : "",
    type: config.observations?.extraction === false ? "raw" : "none",
    content: config.observations?.extraction === false ? JSON.stringify(event).slice(0, 4000) : "",
    confidence: config.observations?.extraction === false ? 0.2 : 0,
    sources: [],
    action: config.observations?.extraction === false ? "ADD" : "NONE",
  };
  await mkdir(path.dirname(observationsPath(config)), { recursive: true });
  await appendFile(observationsPath(config), `${JSON.stringify(record)}\n`, "utf8");
}

function hostDreamingEnabled(api: PluginApiLike): boolean {
  const current = typeof api.runtime?.config?.current === "function" ? api.runtime.config.current() : api.config;
  return (current as { memory?: { dreaming?: { enabled?: boolean } } } | undefined)?.memory?.dreaming?.enabled === true;
}

async function runDreamingGuard(api: PluginApiLike, config: PluginConfig): Promise<void> {
  if (modeFromConfig(config) !== "enhanced" || config.dreaming?.enforce === false) {
    return;
  }
  if (hostDreamingEnabled(api)) {
    return;
  }
  if (config.dreaming?.autoEnable === false || typeof api.runtime?.config?.mutateConfigFile !== "function") {
    api.logger?.warn?.(
      "native-memory-citations enhanced mode is enabled, but OpenClaw memory.dreaming.enabled is not true.",
    );
    return;
  }
  await api.runtime.config.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const memory = typeof draft.memory === "object" && draft.memory !== null
        ? draft.memory as Record<string, unknown>
        : {};
      const dreaming = typeof memory.dreaming === "object" && memory.dreaming !== null
        ? memory.dreaming as Record<string, unknown>
        : {};
      dreaming.enabled = true;
      memory.dreaming = dreaming;
      draft.memory = memory;
    },
  });
  api.logger?.warn?.(DREAMING_NOTICE);
}

export function registerEnhancedLifecycle(api: PluginApiLike): void {
  const config = api.pluginConfig ?? {};
  if (modeFromConfig(config) !== "enhanced") {
    return;
  }

  void runDreamingGuard(api, config).catch((error) => {
    api.logger?.warn?.(`native-memory-citations dreaming guard failed open: ${String(error)}`);
  });
  registerHook(api, "cron_changed", () => {
    void runDreamingGuard(api, config).catch((error) => {
      api.logger?.warn?.(`native-memory-citations dreaming guard failed open: ${String(error)}`);
    });
  }, hookOptions(100, 3000));

  if (requiresSnapshot(config)) {
    registerHook(api, "session_start", async () => {
      await buildSnapshot(config, api.logger);
    }, hookOptions(90, 5000));
  }

  if (config.injection?.enabled === true) {
    registerHook(api, "before_prompt_build", async () => {
      const snapshot = await readSnapshot(config);
      if (!snapshot) {
        return;
      }
      return {
        prependContext: `${SNAPSHOT_NOTICE}\n\n${snapshot}`,
      };
    }, hookOptions(80, 5000));
  }

  if (config.observations?.enabled === true) {
    registerHook(api, "agent_end", (event) => {
      void appendObservation(config, event).catch((error) => {
        api.logger?.warn?.(`native-memory-citations observation tagging failed open: ${String(error)}`);
      });
    }, hookOptions(10, 3000));
  }
}

export const enhancedLifecycleForTest = {
  DREAMING_NOTICE,
  PLUGIN_ID,
};
