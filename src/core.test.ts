import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  answerFromMemory,
  extractMemoryGraph,
  fetchMemorySource,
  queryMemoryGraph,
  searchMemory,
  toSafePath,
} from "./core.js";

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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

async function publicOutputsFor(
  workspace: string,
  options: {
    query: string;
    sourceId: string;
    lineStart?: number;
    lineEnd?: number;
    contextLines?: number;
  },
): Promise<string> {
  const [hits, fetched, answer] = await Promise.all([
    searchMemory(options.query, { config: { workspace }, contextLines: options.contextLines ?? 2 }),
    fetchMemorySource(
      { sourceId: options.sourceId, lineStart: options.lineStart, lineEnd: options.lineEnd },
      { workspace },
    ),
    answerFromMemory(options.query, { config: { workspace } }),
  ]);
  return JSON.stringify({ hits, fetched, answer });
}

function expectNoRawValue(serialized: string, rawValue: string): void {
  expect(serialized).not.toContain(rawValue);
}

describe("native memory citations core", () => {
  it("searches memory with line citations", async () => {
    const workspace = await fixtureWorkspace();
    const hits = await searchMemory("native memory citation plugin", { config: { workspace }, limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("memory/2026-06-16.md");
    expect(hits[0]?.lineStart).toBeGreaterThan(0);
    expect(hits[0]?.matchLine).toBeGreaterThanOrEqual(hits[0]?.lineStart ?? 0);
    expect(hits[0]?.matchLine).toBeLessThanOrEqual(hits[0]?.lineEnd ?? 0);
    expect(hits[0]?.matchText).toContain("native memory");
    expect(hits[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps graph extraction inert in bounded mode", async () => {
    const workspace = await fixtureWorkspace();
    const result = await extractMemoryGraph({ workspace });
    expect(result).toMatchObject({
      enabled: false,
      mode: "bounded",
      edgeCount: 0,
      skipped: "mode is bounded",
    });
    await expect(readFile(path.join(workspace, "memory", "graph.jsonl"), "utf8")).rejects.toThrow();
  });

  it("extracts deterministic graph edges only when enhanced graph mode is enabled", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "graph-source.md"),
      [
        "Alice Example works at Native Memory Labs.",
        "Native Memory Labs mentions Citation Engine.",
        "Citation Engine advises Alice Example.",
      ].join("\n"),
    );

    const config = { workspace, mode: "enhanced" as const, graph: { enabled: true, maxDepth: 3 } };
    const first = await extractMemoryGraph(config);
    const firstText = await readFile(path.join(workspace, "memory", "graph.jsonl"), "utf8");
    const second = await extractMemoryGraph(config);
    const secondText = await readFile(path.join(workspace, "memory", "graph.jsonl"), "utf8");

    expect(first.enabled).toBe(true);
    expect(first.edgeCount).toBeGreaterThanOrEqual(3);
    expect(second.edgeCount).toBe(first.edgeCount);
    expect(secondText).toBe(firstText);
    expect(firstText).toContain("\"type\":\"works_at\"");
    expect(firstText).toContain("\"extractedAt\":\"1970-01-01T00:00:00.000Z\"");
  });

  it("extracts graph edges only from configured allowedRoots", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "MEMORY.md"), "Private Person works at Private Graph Co.\n");
    await writeFile(path.join(workspace, "USER.md"), "Public Person works at Public Graph Co.\n");

    const config = {
      workspace,
      mode: "enhanced" as const,
      allowedRoots: ["USER.md"],
      graph: { enabled: true },
    };
    const result = await extractMemoryGraph(config);
    const graph = await readFile(path.join(workspace, "memory", "graph.jsonl"), "utf8");

    expect(result.enabled).toBe(true);
    expect(graph).toContain("Public Graph Co");
    expect(graph).not.toContain("Private Graph Co");
  });

  it("honors sharedMode during enhanced graph extraction", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "MEMORY.md"), "Private Person works at Shared Mode Secret Co.\n");
    await writeFile(path.join(workspace, "USER.md"), "Shared Person works at Shared Mode Public Co.\n");

    await extractMemoryGraph({
      workspace,
      mode: "enhanced",
      sharedMode: true,
      graph: { enabled: true },
    });
    const graph = await readFile(path.join(workspace, "memory", "graph.jsonl"), "utf8");

    expect(graph).toContain("Shared Mode Public Co");
    expect(graph).not.toContain("Shared Mode Secret Co");
  });

  it("queries graph paths with depth caps and cycle prevention", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "graph-query.md"),
      [
        "Alice Example works at Native Memory Labs.",
        "Native Memory Labs mentions Citation Engine.",
        "Citation Engine advises Alice Example.",
      ].join("\n"),
    );
    const config = { workspace, mode: "enhanced" as const, graph: { enabled: true, maxDepth: 3 } };
    await extractMemoryGraph(config);
    const result = await queryMemoryGraph("Alice Example", { config, maxDepth: 3 });

    expect(result.enabled).toBe(true);
    expect(result.paths.length).toBeGreaterThan(0);
    for (const graphPath of result.paths) {
      expect(new Set(graphPath.nodes).size).toBe(graphPath.nodes.length);
      expect(graphPath.edges.length).toBeLessThanOrEqual(3);
    }
  });

  it("hashes the complete searched file content", async () => {
    const workspace = await fixtureWorkspace();
    const text = ["hash target alpha", "hash target beta", "hash target gamma"].join("\n");
    await writeFile(path.join(workspace, "memory", "hash.md"), text);
    const hits = await searchMemory("hash target", { config: { workspace }, contextLines: 0 });
    const hit = hits.find((item) => item.path === "memory/hash.md");
    expect(hit?.sha256).toBe(sha256Text(text));
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

  it("rejects unsafe allowedRoots config entries", async () => {
    const workspace = await fixtureWorkspace();
    const unsafeRoots = ["", ".", "..", "../outside", "/tmp", "memory/.dreams", ".secret.md"];
    for (const root of unsafeRoots) {
      await expect(searchMemory("native", { config: { workspace, allowedRoots: [root] } })).rejects.toThrow(
        /Invalid allowedRoots/,
      );
    }
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
    const text = [
      "# 2026-06-16",
      "",
      "- Mo decided Ninja should create a native memory citation plugin.",
      "- The plugin should return source citations instead of unsupported claims.",
      "- Native Memory Citations registers tools native_memory_search, native_memory_fetch, and native_memory_answer.",
    ].join("\n");
    const result = await fetchMemorySource(
      { sourceId: "memory/2026-06-16.md", lineStart: 3, lineEnd: 4 },
      { workspace },
    );
    expect(result.content).toContain("native memory citation plugin");
    expect(result.citation).toBe("memory/2026-06-16.md:3");
    expect(result.sha256).toBe(sha256Text(text));
    expect(result.stale).toBeUndefined();
  });

  it("marks fetch results stale when the expected citation hash differs", async () => {
    const workspace = await fixtureWorkspace();
    const searchHits = await searchMemory("native memory citation plugin", { config: { workspace } });
    const originalHash = searchHits[0]?.sha256 ?? "";
    expect(originalHash).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(
      path.join(workspace, "memory", "2026-06-16.md"),
      [
        "# 2026-06-16",
        "",
        "- Mo decided Ninja should create a native memory citation plugin.",
        "- The plugin should return source citations after this file changed.",
      ].join("\n"),
    );
    const result = await fetchMemorySource(
      { sourceId: "memory/2026-06-16.md", lineStart: 3, lineEnd: 4, expectedSha256: originalHash },
      { workspace },
    );
    expect(result.stale).toBe(true);
    expect(result.staleMessage).toContain("Citation hash mismatch");
    expect(result.staleMessage).toContain(originalHash);
    expect(result.sha256).not.toBe(originalHash);
  });

  it("does not mark fetch results stale when the expected citation hash matches", async () => {
    const workspace = await fixtureWorkspace();
    const searchHits = await searchMemory("native memory citation plugin", { config: { workspace } });
    const originalHash = searchHits[0]?.sha256 ?? "";
    const result = await fetchMemorySource(
      { sourceId: "memory/2026-06-16.md", lineStart: 3, lineEnd: 4, expectedSha256: originalHash },
      { workspace },
    );
    expect(result.sha256).toBe(originalHash);
    expect(result.stale).toBeUndefined();
    expect(result.staleMessage).toBeUndefined();
  });

  it("fetches by filePath and clamps ranges", async () => {
    const workspace = await fixtureWorkspace();
    const result = await fetchMemorySource(
      { filePath: "memory/2026-06-16.md", lineStart: 99, lineEnd: 2 },
      { workspace },
    );
    expect(result.lineStart).toBe(5);
    expect(result.lineEnd).toBe(5);
    expect(result.citation).toBe("memory/2026-06-16.md:5");
    expect(result.content).toContain("native_memory_answer");
  });

  it("normalizes non-finite fetch line ranges", async () => {
    const workspace = await fixtureWorkspace();
    const result = await fetchMemorySource(
      { filePath: "memory/2026-06-16.md", lineStart: Number.NaN, lineEnd: Number.POSITIVE_INFINITY },
      { workspace },
    );
    expect(result.lineStart).toBe(1);
    expect(result.lineEnd).toBe(5);
    expect(result.citation).toBe("memory/2026-06-16.md:1");
    expect(result.content).toContain("# 2026-06-16");
  });

  it("truncates fetched content at maxChars", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "long.md"), `${"long-content ".repeat(80)}\n`);
    const result = await fetchMemorySource(
      { sourceId: "memory/long.md", maxChars: 256 },
      { workspace },
    );
    expect(result.content).toHaveLength(256);
  });

  it("rejects hidden files and directories during fetch", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", ".env"), "SECRET=abc123\n");
    await mkdir(path.join(workspace, "memory", ".dreams"), { recursive: true });
    await writeFile(path.join(workspace, "memory", ".dreams", "events.jsonl"), "hidden event\n");
    await expect(fetchMemorySource({ filePath: "memory/.env" }, { workspace })).rejects.toThrow(/hidden/);
    await expect(fetchMemorySource({ filePath: "memory/.dreams/events.jsonl" }, { workspace })).rejects.toThrow(/hidden/);
  });

  it("rejects non-text files during fetch", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "blob.bin"), "binary-ish content\n");
    await expect(fetchMemorySource({ filePath: "memory/blob.bin" }, { workspace })).rejects.toThrow(/text memory/);
  });

  it("rejects oversized files during fetch", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "too-big.md"), `${"too-big-token ".repeat(100)}\n`);
    await expect(
      fetchMemorySource({ filePath: "memory/too-big.md" }, { workspace, maxFileBytes: 1024 }),
    ).rejects.toThrow(/maxFileBytes/);
  });

  it("normalizes non-finite maxFileBytes to the default cap", async () => {
    const workspace = await fixtureWorkspace();
    const oversized = `oversizedtoken\n${"x".repeat((1024 * 1024) + 1)}\n`;
    await writeFile(path.join(workspace, "memory", "nan-too-big.md"), oversized);
    await writeFile(path.join(workspace, "memory", "infinity-too-big.md"), oversized);

    const hits = await searchMemory("oversizedtoken", { config: { workspace, maxFileBytes: Number.NaN } });
    expect(hits.some((hit) => hit.path === "memory/nan-too-big.md")).toBe(false);

    await expect(
      fetchMemorySource({ filePath: "memory/infinity-too-big.md" }, { workspace, maxFileBytes: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/maxFileBytes/);
  });

  it("clamps excessive and non-finite fetch maxChars", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "very-long.md"), `${"x".repeat(25000)}\n`);
    const capped = await fetchMemorySource(
      { sourceId: "memory/very-long.md", maxChars: 999999 },
      { workspace },
    );
    expect(capped.content).toHaveLength(20000);
    const normalized = await fetchMemorySource(
      { sourceId: "memory/very-long.md", maxChars: Number.POSITIVE_INFINITY },
      { workspace },
    );
    expect(normalized.content).toHaveLength(8000);
  });

  it("redacts secrets from search, fetch, and answer output without changing citation hashes", async () => {
    const workspace = await fixtureWorkspace();
    const secretText = [
      "deploy note OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      "Bearer abcdefghijklmnopqrstuvwxyz1234567890",
      "github_pat_abcdefghijklmnopqrstuvwxyz1234567890_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "-----BEGIN PRIVATE KEY-----",
      "super-secret-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    await writeFile(path.join(workspace, "memory", "secret-note.md"), secretText);

    const hits = await searchMemory("deploy note", { config: { workspace }, contextLines: 4 });
    const hit = hits.find((item) => item.path === "memory/secret-note.md");
    expect(hit?.sha256).toBe(sha256Text(secretText));
    expect(hit?.snippet).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(hit?.snippet).toContain("Bearer [REDACTED]");
    expect(hit?.snippet).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(hit?.snippet).toContain("[REDACTED_PRIVATE_KEY]");
    expect(hit?.snippet).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(hit?.snippet).not.toContain("super-secret-key-material");

    const fetched = await fetchMemorySource({ sourceId: "memory/secret-note.md" }, { workspace });
    expect(fetched.sha256).toBe(sha256Text(secretText));
    expect(fetched.content).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(fetched.content).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");

    const answer = await answerFromMemory("deploy note", { config: { workspace } });
    expect(answer.known).toBe(true);
    expect(answer.answer).toContain("[REDACTED]");
    expect(answer.answer).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
  });

  it("keeps a normal long file path (does not over-redact it as a high-entropy token)", async () => {
    const workspace = await fixtureWorkspace();
    const filePath = "deploy/production-east/configuration/values";
    await writeFile(
      path.join(workspace, "memory", "paths.md"),
      ["# paths", "", `- Config lives at ${filePath} on the cluster.`].join("\n"),
    );

    const fetched = await fetchMemorySource({ sourceId: "memory/paths.md" }, { workspace });
    expect(fetched.content).toContain(filePath);
    expect(fetched.content).not.toContain("[REDACTED_HIGH_ENTROPY]");

    const hits = await searchMemory("Config lives", { config: { workspace }, contextLines: 4 });
    const hit = hits.find((item) => item.path === "memory/paths.md");
    expect(hit).toBeDefined();
    expect(hit?.snippet).toContain(filePath);
    expect(hit?.snippet).not.toContain("[REDACTED_HIGH_ENTROPY]");
  });

  it("redacts a private-key body line fetched without block markers", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "key.md"),
      [
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    );

    const result = await fetchMemorySource({ sourceId: "memory/key.md", lineStart: 2, lineEnd: 2 }, { workspace });
    expect(result.content).toBe("[REDACTED_PRIVATE_KEY]");
    expect(result.content).not.toContain("MIIEvQIB");
  });

  it("redacts a private-key body line found by zero-context search", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "key-search.md"),
      [
        "-----BEGIN PRIVATE KEY-----",
        "secretKEYmaterialONLYline",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    );

    const hits = await searchMemory("secretKEYmaterialONLYline", { config: { workspace }, contextLines: 0 });
    expect(hits[0]?.snippet).toBe("[REDACTED_PRIVATE_KEY]");
    expect(hits[0]?.matchText).toBe("[REDACTED_PRIVATE_KEY]");
    expect(JSON.stringify(hits)).not.toContain("secretKEYmaterialONLYline");
  });

  it("redacts private-key body content when merged search regions cross a block edge", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "key-edge.md"),
      [
        "-----BEGIN PRIVATE KEY-----",
        "edgeKEYmaterialONLYline",
        "-----END PRIVATE KEY-----",
        "edgeKEYmaterialONLYline normal note",
      ].join("\n"),
    );

    const hits = await searchMemory("edgeKEYmaterialONLYline", { config: { workspace }, contextLines: 1 });
    expect(hits[0]?.snippet).toContain("[REDACTED_PRIVATE_KEY]");
    expect(hits[0]?.snippet).toContain("edgeKEYmaterialONLYline normal note");
    expect(hits[0]?.snippet).not.toContain("-----BEGIN PRIVATE KEY-----");
  });

  it("redacts an unclosed private-key block through EOF", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "unclosed-key.md"),
      [
        "before note",
        "-----BEGIN PRIVATE KEY-----",
        "unclosedKEYmaterialONLYline",
        "stillKEYmaterialONLYline",
      ].join("\n"),
    );

    const result = await fetchMemorySource({ sourceId: "memory/unclosed-key.md", lineStart: 2, lineEnd: 4 }, { workspace });
    expect(result.content).toBe([
      "[REDACTED_PRIVATE_KEY]",
      "[REDACTED_PRIVATE_KEY]",
      "[REDACTED_PRIVATE_KEY]",
    ].join("\n"));
    expect(result.content).not.toContain("unclosedKEYmaterialONLYline");
  });

  it("redacts a bounded non-blank run before an orphan private-key end marker", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "orphan-end.md"),
      [
        "safe prose above",
        "",
        "orphanKEYmaterialONLYline",
        "anotherKEYmaterialONLYline",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    );

    const result = await fetchMemorySource({ sourceId: "memory/orphan-end.md" }, { workspace });
    expect(result.content).toContain("safe prose above");
    expect(result.content).toContain("[REDACTED_PRIVATE_KEY]");
    expect(result.content).not.toContain("orphanKEYmaterialONLYline");
  });

  it("redacts indented private-key markers from markdown blocks", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "indented-key.md"),
      [
        "    -----BEGIN PRIVATE KEY-----",
        "    indentedKEYmaterialONLYline",
        "    -----END PRIVATE KEY-----",
      ].join("\n"),
    );

    const hits = await searchMemory("indentedKEYmaterialONLYline", { config: { workspace }, contextLines: 0 });
    expect(hits[0]?.snippet).toBe("[REDACTED_PRIVATE_KEY]");
    expect(JSON.stringify(hits)).not.toContain("indentedKEYmaterialONLYline");
  });

  it("redacts PGP private-key blocks", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "pgp-key.md"),
      [
        "-----BEGIN PGP PRIVATE KEY BLOCK-----",
        "pgpKEYmaterialONLYline",
        "-----END PGP PRIVATE KEY BLOCK-----",
      ].join("\n"),
    );

    const result = await fetchMemorySource({ sourceId: "memory/pgp-key.md", lineStart: 2, lineEnd: 2 }, { workspace });
    expect(result.content).toBe("[REDACTED_PRIVATE_KEY]");
    expect(result.content).not.toContain("pgpKEYmaterialONLYline");
  });

  it("preserves prose above a blank before a stray private-key end marker", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(
      path.join(workspace, "memory", "stray-end-prose.md"),
      [
        "first prose line",
        "second prose line",
        "",
        "This paragraph mentions -----END PRIVATE KEY-----",
      ].join("\n"),
    );

    const result = await fetchMemorySource({ sourceId: "memory/stray-end-prose.md" }, { workspace });
    expect(result.content).toContain("first prose line");
    expect(result.content).toContain("second prose line");
  });

  it("uses raw relevance while emitting only redacted answer text", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "deploy.md"), "deploy_token: production-east\n");
    const result = await answerFromMemory("production", { config: { workspace } });
    expect(result.known).toBe(true);
    expect(result.answer).toContain("[REDACTED]");
    expect(result.answer).not.toContain("production-east");
    expect(result.citations).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("rawSnippet");
    expect(JSON.stringify(result)).not.toContain("rawMatchText");
  });

  it("keeps raw fields out of public search results", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "deploy-search.md"), "deploy_token: production-east\n");
    const hits = await searchMemory("production", { config: { workspace } });
    const serialized = JSON.stringify(hits);
    expect(serialized).not.toContain("rawSnippet");
    expect(serialized).not.toContain("rawMatchText");
    expect(serialized).not.toContain("production-east");
    expect(hits[0]?.snippet).toContain("[REDACTED]");
  });

  it("redacts expanded single-line credential patterns", async () => {
    const workspace = await fixtureWorkspace();
    const secretText = [
      "AccountKey=azureAccountSecretValue",
      "SharedAccessKey=azureSharedSecretValue",
      "https://example.blob.core.windows.net/container?sig=azureSignatureValue&sv=1",
      "AKIAABCDEFGHIJKLMNOP",
      "ASIAABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdefghijklmnop",
      "AIza0123456789ABCDEFGHIJKLMNOabcdefghij",
      "eyJheader.eyJpayload.signatureSegment",
      "https://user:password123@example.com/path",
    ].join("\n");
    await writeFile(path.join(workspace, "memory", "pattern-fixtures.md"), secretText);

    const fetched = await fetchMemorySource({ sourceId: "memory/pattern-fixtures.md" }, { workspace });
    expect(fetched.content).toContain("AccountKey=[REDACTED]");
    expect(fetched.content).toContain("SharedAccessKey=[REDACTED]");
    expect(fetched.content).toContain("sig=[REDACTED]");
    expect(fetched.content).toContain("[REDACTED_AWS_KEY_ID]");
    expect(fetched.content).toContain("[REDACTED_SLACK_TOKEN]");
    expect(fetched.content).toContain("[REDACTED_GOOGLE_KEY]");
    expect(fetched.content).toContain("[REDACTED_JWT]");
    expect(fetched.content).toContain("https://user:[REDACTED]@example.com/path");
    expect(fetched.content).not.toContain("azureAccountSecretValue");
    expect(fetched.content).not.toContain("password123");
  });

  it("redacts sufficiently long high-entropy tokens without a named pattern", async () => {
    const workspace = await fixtureWorkspace();
    const rawToken = "q7Zp9Lm2Va8Wx4Rn6Tc0Yb3Kd5Jf1Hs";
    await writeFile(path.join(workspace, "memory", "opaque-token.md"), `opaque token ${rawToken}\n`);

    const serialized = await publicOutputsFor(workspace, {
      query: rawToken,
      sourceId: "memory/opaque-token.md",
    });
    expect(serialized).toContain("[REDACTED_HIGH_ENTROPY]");
    expectNoRawValue(serialized, rawToken);
  });

  it("keeps adversarial raw values out of every public output field", async () => {
    const workspace = await fixtureWorkspace();
    const fixtures = [
      {
        name: "partial private-key lines",
        sourceId: "memory/adversarial-partial-key.md",
        query: "AdversarialPartialKeyLineOnly",
        lineStart: 2,
        lineEnd: 2,
        rawValue: "AdversarialPartialKeyLineOnly",
        content: [
          "-----BEGIN PRIVATE KEY-----",
          "AdversarialPartialKeyLineOnly",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
      },
      {
        name: "zero-context private-key snippets",
        sourceId: "memory/adversarial-zero-context.md",
        query: "ZeroContextPrivateKeyOnlyLine",
        lineStart: 2,
        lineEnd: 2,
        contextLines: 0,
        rawValue: "ZeroContextPrivateKeyOnlyLine",
        content: [
          "-----BEGIN PRIVATE KEY-----",
          "ZeroContextPrivateKeyOnlyLine",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
      },
      {
        name: "rawSnippet and rawMatchText escape",
        sourceId: "memory/adversarial-raw-fields.md",
        query: "rawfield",
        rawValue: "RawFieldSecretValue123456789",
        content: "rawfield_token: RawFieldSecretValue123456789\n",
      },
      {
        name: "citation offsets",
        sourceId: "memory/adversarial-offset.md",
        query: "OffsetSecretValue123456789",
        lineStart: 2,
        lineEnd: 2,
        rawValue: "OffsetSecretValue123456789",
        content: [
          "safe line above",
          "offset_token: OffsetSecretValue123456789",
          "safe line below",
        ].join("\n"),
      },
      {
        name: "credential URLs",
        sourceId: "memory/adversarial-url.md",
        query: "dbuser",
        rawValue: "UltraPrivatePassword123!",
        content: "database_url=https://dbuser:UltraPrivatePassword123!@example.com/prod\n",
      },
    ];

    for (const fixture of fixtures) {
      await writeFile(path.join(workspace, fixture.sourceId), fixture.content);
      const serialized = await publicOutputsFor(workspace, fixture);
      expect(serialized, fixture.name).not.toContain("rawSnippet");
      expect(serialized, fixture.name).not.toContain("rawMatchText");
      expectNoRawValue(serialized, fixture.rawValue);
    }
  });

  it("answers with citations when memory contains the fact", async () => {
    const workspace = await fixtureWorkspace();
    const result = await answerFromMemory("What should the plugin return?", { config: { workspace } });
    expect(result.known).toBe(true);
    expect(result.answer).toContain("[memory/2026-06-16.md:4]");
    expect(result.answer).toContain("The plugin should return source citations");
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

  it("does not claim an answer when required terms are split across files", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "alpha.md"), "alpha only\n");
    await writeFile(path.join(workspace, "memory", "beta.md"), "beta only\n");
    const result = await answerFromMemory("alpha beta", { config: { workspace } });
    expect(result.known).toBe(false);
    expect(result.citations).toHaveLength(0);
  });

  it("claims an answer when one hit supports enough query terms", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "alpha-beta.md"), "alpha and beta together\n");
    const result = await answerFromMemory("alpha beta", { config: { workspace } });
    expect(result.known).toBe(true);
    expect(result.answer).toContain("[memory/alpha-beta.md:1]");
  });

  it("returns only supporting citations for a confident answer", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "alpha-only.md"), "alpha only\n");
    await writeFile(path.join(workspace, "memory", "alpha-beta.md"), "alpha beta together\n");
    const result = await answerFromMemory("alpha beta", { config: { workspace }, limit: 10 });
    expect(result.known).toBe(true);
    expect(result.citations.map((hit) => hit.path)).toContain("memory/alpha-beta.md");
    expect(result.citations.map((hit) => hit.path)).not.toContain("memory/alpha-only.md");
  });

  it("returns no hits for stopword-only queries", async () => {
    const workspace = await fixtureWorkspace();
    const hits = await searchMemory("what should the", { config: { workspace } });
    expect(hits).toHaveLength(0);
  });

  it("uses boundaries for short terms", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "google.md"), "google workspace note\n");
    const hits = await searchMemory("go", { config: { workspace } });
    expect(hits).toHaveLength(0);
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

  it("skips symlinked files during search traversal", async () => {
    const workspace = await fixtureWorkspace();
    const target = path.join(workspace, "outside-symlink-search.md");
    await writeFile(target, "symlink-only-search-token\n");
    await symlink(target, path.join(workspace, "memory", "search-leak.md"));
    const hits = await searchMemory("symlink-only-search-token", { config: { workspace } });
    expect(hits).toHaveLength(0);
  });

  it("skips files exceeding maxFileBytes and logs the skip", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "oversized.md"), `${"oversized-token ".repeat(100)}\n`);
    const warnings: string[] = [];
    const hits = await searchMemory("oversized-token", {
      config: { workspace, maxFileBytes: 1024 },
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(hits).toHaveLength(0);
    expect(warnings.some((message) => message.includes("skipped oversized file"))).toBe(true);
  });

  it("orders higher scoring files first", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "alpha.md"), "alpha only\n");
    await writeFile(path.join(workspace, "memory", "alpha-beta-gamma.md"), "alpha beta gamma\n");
    const hits = await searchMemory("alpha beta gamma", { config: { workspace }, contextLines: 0, limit: 2 });
    expect(hits[0]?.path).toBe("memory/alpha-beta-gamma.md");
  });

  it("refreshes cached file contents after rewrite", async () => {
    const workspace = await fixtureWorkspace();
    const file = path.join(workspace, "memory", "cache.md");
    await writeFile(file, "old-cache-token\n");
    expect(await searchMemory("old-cache-token", { config: { workspace } })).toHaveLength(1);
    await writeFile(file, "fresh-cache-token with a different size\n");
    const freshHits = await searchMemory("fresh-cache-token", { config: { workspace } });
    expect(freshHits).toHaveLength(1);
    expect(freshHits[0]?.matchText).toContain("fresh-cache-token");
  });

  it("caps search snippets and match lines", async () => {
    const workspace = await fixtureWorkspace();
    await writeFile(path.join(workspace, "memory", "long-line.md"), `longlinetoken ${"x".repeat(6000)}\n`);
    const hits = await searchMemory("longlinetoken", { config: { workspace }, contextLines: 0 });
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(4000);
    expect(hits[0]?.matchText.length).toBeLessThanOrEqual(2000);
  });

  it("honors an already-aborted search signal", async () => {
    const workspace = await fixtureWorkspace();
    const controller = new AbortController();
    controller.abort();
    await expect(searchMemory("plugin", { config: { workspace }, signal: controller.signal })).rejects.toThrow();
  });

  it("debug logs scanned file and hit counts", async () => {
    const workspace = await fixtureWorkspace();
    const debug: string[] = [];
    await searchMemory("plugin", {
      config: { workspace },
      logger: { debug: (message) => debug.push(message) },
    });
    expect(debug.some((message) => message.includes("scanned") && message.includes("hits"))).toBe(true);
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
