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
      "- Native Memory Citations registers tools native_memory_search, native_memory_fetch, and native_memory_answer.",
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

  it("skips hidden memory directories like .dreams by default", async () => {
    const workspace = await fixtureWorkspace();
    await mkdir(path.join(workspace, "memory", ".dreams"), { recursive: true });
    await writeFile(path.join(workspace, "memory", ".dreams", "events.jsonl"), "native memory citations hidden\n");
    const hits = await searchMemory("hidden native memory citations", { config: { workspace }, contextLines: 2 });
    expect(hits.some((hit) => hit.path.includes(".dreams"))).toBe(false);
  });

  it("caps very dense merged regions", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "dense.md"),
      Array.from({ length: 60 }, (_, index) => `dense repeated term ${index}`).join("\n"),
    );
    const hits = await searchMemory("dense repeated", { config: { workspace }, contextLines: 2, limit: 1 });
    expect((hits[0]?.lineEnd ?? 0) - (hits[0]?.lineStart ?? 0) + 1).toBeLessThanOrEqual(25);
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

  it("extracts the highest-signal line from a cited region", async () => {
    const workspace = await fixtureWorkspace();
    const result = await answerFromMemory("What tools does Native Memory Citations register?", { config: { workspace } });
    expect(result.known).toBe(true);
    expect(result.answer).toContain("native_memory_search");
    expect(result.answer).not.toContain("Private long-term memory");
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

  it("does not claim an answer when only generic terms match", async () => {
    const workspace = await fixtureWorkspace();
    const result = await answerFromMemory("zzqx blorple nonpresent memory answer", { config: { workspace } });
    expect(result.known).toBe(false);
    expect(result.citations).toHaveLength(0);
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
