import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { modeFromConfig, readAuthorizedMemoryFile, type PluginConfig, redactMemoryText, workspaceFromConfig } from "./core.js";

const PLUGIN_ID = "native-memory-citations";
const DEFAULT_TOKEN_CAP = 1300;
const SNAPSHOT_NOTICE =
  "Native Memory Citations enhanced snapshot: bounded, local, redacted memory context follows. Treat it as recall hints, not authority.";
const DREAMING_NOTICE =
  "native-memory-citations enhanced mode is enabled, but OpenClaw memory-core dreaming is off. Enable plugins.entries.memory-core.config.dreaming.enabled yourself; dreaming-dependent enhanced features are degraded.";
const OBSERVATION_EXTRACTION_NOTICE =
  "native-memory-citations observation logging requires structured extraction, which is not available in this release; no raw conversation-derived observation was written.";

type PluginApiLike = {
  pluginConfig?: PluginConfig;
  config?: OpenClawConfigLike;
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
    };
  };
};

type OpenClawConfigLike = {
  memory?: { dreaming?: { enabled?: boolean } };
  plugins?: {
    entries?: Record<string, {
      config?: {
        dreaming?: { enabled?: boolean };
      };
    } | unknown>;
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
  if (typeof api.on === "function") {
    api.on(event, handler, opts);
    return;
  }
  if (typeof api.registerHook === "function") {
    api.registerHook(event, handler, opts);
  }
}

async function buildSnapshot(config: PluginConfig, logger: PluginApiLike["logger"]): Promise<void> {
  const parts: string[] = [];
  for (const source of ["MEMORY.md", "DREAMS.md"]) {
    const file = await readAuthorizedMemoryFile(config, source, { logger }).catch((error) => {
      logger?.debug?.(`native-memory-citations: skipped unauthorized snapshot source ${source}: ${String(error)}`);
      return null;
    });
    const text = file?.loaded.rawText ?? "";
    if (text.trim()) {
      parts.push(`## ${source}\n${text.trim()}`);
    }
  }
  const content = redactMemoryText(approxTokenSlice(parts.join("\n\n"), tokenCap(config)));
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

function hostDreamingEnabled(api: PluginApiLike): boolean {
  const current = (typeof api.runtime?.config?.current === "function" ? api.runtime.config.current() : api.config) as OpenClawConfigLike | undefined;
  if (current?.memory?.dreaming?.enabled === true) {
    return true;
  }
  const memoryCore = current?.plugins?.entries?.["memory-core"];
  if (memoryCore && typeof memoryCore === "object") {
    return (memoryCore as { config?: { dreaming?: { enabled?: boolean } } }).config?.dreaming?.enabled === true;
  }
  return false;
}

function emitObservationUnavailable(api: PluginApiLike): void {
  api.logger?.warn?.(OBSERVATION_EXTRACTION_NOTICE);
}

async function runDreamingGuard(api: PluginApiLike, config: PluginConfig): Promise<void> {
  if (modeFromConfig(config) !== "enhanced" || config.dreaming?.notify === false) {
    return;
  }
  if (hostDreamingEnabled(api)) {
    return;
  }
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
    let noticeEmitted = false;
    registerHook(api, "agent_end", () => {
      if (!noticeEmitted) {
        noticeEmitted = true;
        emitObservationUnavailable(api);
      }
    }, hookOptions(10, 3000));
  }
}

export const enhancedLifecycleForTest = {
  DREAMING_NOTICE,
  OBSERVATION_EXTRACTION_NOTICE,
  PLUGIN_ID,
  buildSnapshot,
  emitObservationUnavailable,
  runDreamingGuard,
};
