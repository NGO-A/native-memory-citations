import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answerFromMemory, fetchMemorySource, searchMemory, toSafePath } from "./core.js";

async function fixtureWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "native-memory-citations-"));
  await mkdir(path.join(workspace, "memory"), { recursive: true });
  await writeFile(
    path.join(workspace, "memory", "2026-06-16.md"),
    [
      "# 2026-06-16",
      "",
      "- Mo decided Ninja should create a native memory citation plugin.",
      "- The plugin should return source citations instead of unsupported claims.",
    ].join("\n"),
  );
  await writeFile(path.join(workspace, "MEMORY.md"), "- Private long-term memory about agent orchestration.\n");
  return workspace;
}

describe("native memory citations core", () => {
  it("searches memory with line citations", async () => {
    const workspace = await fixtureWorkspace();
    const hits = await searchMemory("native memory citation plugin", { config: { workspace }, limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("memory/2026-06-16.md");
    expect(hits[0]?.lineStart).toBeGreaterThan(0);
  });

  it("fetches cited memory ranges", async () => {
    const workspace = await fixtureWorkspace();
    const result = await fetchMemorySource({ sourceId: "memory/2026-06-16.md", lineStart: 3, lineEnd: 4 }, { workspace });
    expect(result.content).toContain("native memory citation plugin");
    expect(result.citation).toBe("memory/2026-06-16.md:3");
  });

  it("answers with citations when memory contains the fact", async () => {
    const workspace = await fixtureWorkspace();
    const result = await answerFromMemory("What should the plugin return?", { config: { workspace } });
    expect(result.known).toBe(true);
    expect(result.answer).toContain("[memory/2026-06-16.md:");
  });

  it("blocks paths outside allowed roots", async () => {
    const workspace = await fixtureWorkspace();
    expect(() => toSafePath({ workspace }, "../secret.txt")).toThrow(/outside allowed/);
  });

  it("shared mode excludes private MEMORY.md by default", async () => {
    const workspace = await fixtureWorkspace();
    const hits = await searchMemory("private long-term", { config: { workspace, sharedMode: true } });
    expect(hits).toHaveLength(0);
  });
});
