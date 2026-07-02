import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  answerFromMemory,
  extractMemoryGraph,
  queryMemoryGraph,
  redactMemoryText,
  searchMemory,
} from "./core.js";

// ---------------------------------------------------------------------------
// Reference oracle: the ORIGINAL (pre-2026.6.18) private-key masking logic.
// The current implementation replaced the O(n^2) backward-scan-per-marker form
// with an O(n) run scan. These tests prove the two are byte-for-byte equivalent
// on random and adversarial inputs, so the performance fix cannot silently
// change which lines are redacted. Keep this copy frozen; it is the contract.
// ---------------------------------------------------------------------------
function refIsBeginMarker(line: string): boolean {
  return /^\s*-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----\s*$/.test(line);
}
function refIsEndMarker(line: string): boolean {
  return /^\s*-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----\s*$/.test(line);
}
function referenceMask(rawLines: string[]): boolean[] {
  const mask = new Array<boolean>(rawLines.length).fill(false);
  let open = -1;
  for (let i = 0; i < rawLines.length; i += 1) {
    if (refIsBeginMarker(rawLines[i] ?? "")) {
      open = i;
      mask[i] = true;
      continue;
    }
    if (open >= 0) {
      mask[i] = true;
      if (refIsEndMarker(rawLines[i] ?? "")) {
        open = -1;
      }
    }
  }
  for (let j = 0; j < rawLines.length; j += 1) {
    if (refIsEndMarker(rawLines[j] ?? "") && !mask[j]) {
      let k = j;
      while (k >= 0 && (rawLines[k] ?? "").trim() !== "") {
        mask[k] = true;
        k -= 1;
      }
    }
  }
  return mask;
}

// Recover the current implementation's private-key mask from its public output.
// A masked line is always exactly the sentinel; single-line secret redaction
// never emits that exact string, and the fuzz alphabet never contains it.
const PRIVATE_KEY_SENTINEL = "[REDACTED_PRIVATE_KEY]";
function currentMask(text: string): boolean[] {
  return redactMemoryText(text).split("\n").map((line) => line === PRIVATE_KEY_SENTINEL);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every masking branch: blanks, matched blocks, orphan ends, indented markers,
// non-marker prose that mentions an END string, and PGP/RSA/ENCRYPTED variants.
const LINE_TEMPLATES = [
  "",
  "   ",
  "ordinary content line",
  "  indented content  ",
  "-----BEGIN PRIVATE KEY-----",
  "-----END PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "-----END PGP PRIVATE KEY BLOCK-----",
  "    -----END PRIVATE KEY-----",
  "    -----BEGIN PRIVATE KEY-----",
  "prose mentioning -----END PRIVATE KEY----- inline text",
  "-----END RSA PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "keymaterialline0123456789abcdef",
];

describe("redaction masking O(n) rewrite equivalence", () => {
  it("matches the original masking on adversarial fixtures", () => {
    const fixtures: string[] = [
      // Orphan END after a non-blank run: the run is redacted back to the blank.
      ["safe prose above", "", "orphanKEYmaterial", "anotherKEYmaterial", "-----END PRIVATE KEY-----"].join("\n"),
      // Complete block adjacent to a later orphan END, no intervening blanks.
      [
        "lead content",
        "-----BEGIN PRIVATE KEY-----",
        "blockKEYmaterial",
        "-----END PRIVATE KEY-----",
        "trailing content",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
      // Many stray END markers in one run (the O(n^2) worst case).
      ["filler a", "filler b", ...Array.from({ length: 40 }, () => "-----END PRIVATE KEY-----")].join("\n"),
      // Interleaved orphan ENDs and content across paragraphs.
      [
        "-----END PRIVATE KEY-----",
        "content 1",
        "",
        "content 2",
        "-----END PRIVATE KEY-----",
        "content 3",
      ].join("\n"),
      // Non-marker prose separated by a blank must be preserved.
      ["first prose line", "second prose line", "", "This paragraph mentions -----END PRIVATE KEY-----"].join("\n"),
      // Trailing whitespace-only run before an orphan end.
      ["content", "   ", "-----END PRIVATE KEY-----"].join("\n"),
    ];
    for (const text of fixtures) {
      expect(currentMask(text), `mask mismatch for fixture:\n${text}`).toEqual(referenceMask(text.split(/\r?\n/)));
    }
  });

  it("matches the original masking across randomized inputs", () => {
    const rand = mulberry32(0x1234abcd);
    const iterations = 3000;
    for (let n = 0; n < iterations; n += 1) {
      const length = Math.floor(rand() * 61); // 0..60 lines
      const lines: string[] = [];
      for (let i = 0; i < length; i += 1) {
        lines.push(LINE_TEMPLATES[Math.floor(rand() * LINE_TEMPLATES.length)] ?? "");
      }
      const text = lines.join("\n");
      const got = currentMask(text);
      const want = referenceMask(text.split(/\r?\n/));
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`mask mismatch (iteration ${n}) for input:\n${text}`);
      }
    }
  });

  it("redacts private-key runs in linear, not quadratic, time", () => {
    // The original backward-scan was ~1.4s at 16k lines; the O(n) rewrite is ~10ms.
    // A 400ms ceiling still catches any reintroduced quadratic behavior with margin.
    const lines: string[] = [];
    for (let i = 0; i < 8000; i += 1) {
      lines.push(`filler content line ${i}`);
    }
    for (let i = 0; i < 8000; i += 1) {
      lines.push("-----END PRIVATE KEY-----");
    }
    const text = lines.join("\n");
    const started = performance.now();
    const out = redactMemoryText(text);
    const elapsed = performance.now() - started;
    expect(out).toContain(PRIVATE_KEY_SENTINEL);
    expect(elapsed).toBeLessThan(400);
  });
});

async function seedWorkspace(files: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "native-memory-citations-hardening-"));
  await mkdir(path.join(workspace, "memory"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(workspace, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return workspace;
}

describe("query size bounding (matcher-count DoS)", () => {
  it("still matches a selective term buried in an oversized junk query", async () => {
    const workspace = await seedWorkspace({
      "memory/note.md": "The distinctzebramarker sits in this cited memory line.\n",
    });
    const junk = Array.from({ length: 20000 }, (_v, i) => `qa${i.toString(36)}`).join(" ");
    const query = `distinctzebramarker ${junk}`;
    const started = performance.now();
    const hits = await searchMemory(query, { config: { workspace } });
    const elapsed = performance.now() - started;
    expect(hits.some((hit) => hit.sourceId === "memory/note.md")).toBe(true);
    // Uncapped, this query built 20k matchers (~1.3s on this corpus). Capped, it
    // builds at most 64. A 300ms ceiling catches a regression to the uncapped path.
    expect(elapsed).toBeLessThan(300);
  });

  it("leaves ordinary multi-term queries unchanged", async () => {
    const workspace = await seedWorkspace({
      "memory/note.md": [
        "# Notes",
        "",
        "- deployment ran against the production east region cleanly.",
      ].join("\n"),
    });
    const hits = await searchMemory("production deployment", { config: { workspace } });
    expect(hits[0]?.sourceId).toBe("memory/note.md");
    const answer = await answerFromMemory("production deployment region", { config: { workspace } });
    expect(answer.known).toBe(true);
  });
});

describe("graph extractor oversized-line bounding", () => {
  const enhancedGraphConfig = (workspace: string) => ({
    workspace,
    mode: "enhanced" as const,
    graph: { enabled: true },
  });

  it("extracts from normal lines but skips lines over the length cap", async () => {
    // Short line yields a typed edge. The oversized line begins with a clean
    // "X works at Y" that WOULD match if scanned, proving the skip is by length.
    const oversized = `Zoe Zenith works at Zenith Labs ${"z".repeat(5000)}`;
    const workspace = await seedWorkspace({
      "memory/graph-src.md": [
        "Alice Anderson works at Acme Corporation.",
        oversized,
      ].join("\n"),
    });
    const config = enhancedGraphConfig(workspace);
    const extract = await extractMemoryGraph(config);
    expect(extract.enabled).toBe(true);
    // Exactly one edge is persisted: the short line's. The oversized line, which
    // begins with a matchable "Zoe Zenith works at ...", contributes nothing.
    expect(extract.edgeCount).toBe(1);

    const alice = await queryMemoryGraph("Acme", { config });
    expect(alice.paths.length).toBeGreaterThan(0);

    const zoe = await queryMemoryGraph("Zoe Zenith", { config });
    expect(zoe.edgeCount).toBe(1);
    expect(zoe.paths).toHaveLength(0);
  });

  it("completes extraction on a single very long line within budget", async () => {
    const workspace = await seedWorkspace({
      "memory/one-line.md": `Systems Notes: uses ${"Alpha Beta plugin ".repeat(30000)}`,
    });
    const started = performance.now();
    const extract = await extractMemoryGraph(enhancedGraphConfig(workspace));
    const elapsed = performance.now() - started;
    expect(extract.enabled).toBe(true);
    expect(elapsed).toBeLessThan(300);
  });
});
