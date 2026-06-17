import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, "..", "openclaw.plugin.json");

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "native-memory-citations-index-"));
  await mkdir(path.join(workspace, "memory"), { recursive: true });
  await writeFile(path.join(workspace, "memory", "note.md"), "native memory citation plugin\n");
  return workspace;
}

describe("plugin manifest contract", () => {
  it("declares the expected id and tool names", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      id?: string;
      contracts?: { tools?: string[] };
    };
    expect(manifest.id).toBe("native-memory-citations");
    expect([...(manifest.contracts?.tools ?? [])].sort()).toEqual(
      ["native_memory_answer", "native_memory_fetch", "native_memory_search"].sort(),
    );
  });

  it("ships a non-empty config schema so plugin config is accepted", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      configSchema?: { properties?: Record<string, unknown> };
    };
    const properties = manifest.configSchema?.properties ?? {};
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["workspace", "allowedRoots", "sharedMode", "maxFileBytes"]),
    );
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
});
