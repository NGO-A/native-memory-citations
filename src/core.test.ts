import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
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

  it("merges adjacent matches into a single region instead of overlapping hits", async () => {
    const workspace = await fixtureWorkspace();
    const hits = await searchMemory("plugin", { config: { workspace }, contextLines: 2 });
    const fromFixture = hits.filter((hit) => hit.path === "memory/2026-06-16.md");
    expect(fromFixture).toHaveLength(1);
  });

  it("fetches cited memory ranges", async () => {
    const workspace = await fixtureWorkspace();
    const result = await fetchMemorySource(
      { sourceId: "memory/2026-06-16.md", lineStart: 3, lineEnd: 4 },
      { workspace },
    );
    expect(result.content).toContain("native memory citation plugin");
    expect(result.citation).toBe("memory/2026-06-16.md:3");
  });

  it("answers with citations when memory contains the fact", async () => {
    const workspace = await fixtureWorkspace();
    const result = await answerFromMemory("What should the plugin return?", { config: { workspace } });
    expect(result.known).toBe(true);
    expect(result.answer).toContain("[memory/2026-06-16.md:");
  });

  it("reports known:false when nothing relevant is found", async () => {
    const workspace = await fixtureWorkspace();
    const result = await answerFromMemory("quantum chromodynamics lagrangian", { config: { workspace } });
    expect(result.known).toBe(false);
    expect(result.citations).toHaveLength(0);
  });

  it("requires multiple distinct query terms before claiming a cited answer", async () => {
    const workspace = await fixtureWorkspace();
    const result = await answerFromMemory("plugin zzqx-token-not-present", { config: { workspace } });
    expect(result.known).toBe(false);
  });

  it("blocks paths outside allowed roots", async () => {
    const workspace = await fixtureWorkspace();
    await expect(toSafePath({ workspace }, "../secret.txt")).rejects.toThrow(/outside allowed/);
  });

  it("blocks symlinks that escape allowed roots", async () => {
    const workspace = await fixtureWorkspace();
    const target = path.join(workspace, "outside-secret.txt");
    await writeFile(target, "secret material\n");
    await symlink(target, path.join(workspace, "memory", "leak.md"));
    await expect(fetchMemorySource({ sourceId: "memory/leak.md" }, { workspace })).rejects.toThrow(/symlink/);
  });

  it("applies a custom allowedRoots from config", async () => {
    const workspace = await fixtureWorkspace();
    const hits = await searchMemory("native memory citation plugin", {
      config: { workspace, allowedRoots: ["USER.md"] },
    });
    expect(hits).toHaveLength(0);
  });

  it("shared mode excludes private MEMORY.md by default", async () => {
    const workspace = await fixtureWorkspace();
    const hits = await searchMemory("private long-term", { config: { workspace, sharedMode: true } });
    expect(hits).toHaveLength(0);
  });
});
