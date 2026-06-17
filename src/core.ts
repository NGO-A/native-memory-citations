import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type PluginConfig = {
  workspace?: string;
  allowedRoots?: string[];
  sharedMode?: boolean;
  maxFileBytes?: number;
};

export type SearchHit = {
  sourceId: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
};

export type FetchResult = {
  sourceId: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  citation: string;
  content: string;
};

const DEFAULT_WORKSPACE = "/home/ad/.openclaw/workspace";
const DEFAULT_PRIVATE_ROOTS = ["memory", "MEMORY.md", "USER.md", "IDENTITY.md", "TOOLS.md"];
const DEFAULT_SHARED_ROOTS = ["memory", "USER.md", "IDENTITY.md", "TOOLS.md"];
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"]);

export function workspaceFromConfig(config: PluginConfig = {}): string {
  return path.resolve(config.workspace?.trim() || DEFAULT_WORKSPACE);
}

export function allowedRoots(config: PluginConfig = {}): string[] {
  const roots = config.allowedRoots && config.allowedRoots.length > 0
    ? config.allowedRoots
    : config.sharedMode
      ? DEFAULT_SHARED_ROOTS
      : DEFAULT_PRIVATE_ROOTS;
  const workspace = workspaceFromConfig(config);
  return roots.map((root) => path.resolve(workspace, root));
}

export function toSafePath(config: PluginConfig, requested: string): string {
  const workspace = workspaceFromConfig(config);
  const resolved = path.resolve(workspace, requested);
  const roots = allowedRoots(config);
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`Path is outside allowed memory roots: ${requested}`);
  }
  return resolved;
}

export function sourceIdForPath(config: PluginConfig, absolutePath: string): string {
  return path.relative(workspaceFromConfig(config), absolutePath).split(path.sep).join("/");
}

export function pathForSourceId(config: PluginConfig, sourceId: string): string {
  return toSafePath(config, sourceId);
}

async function collectFiles(root: string): Promise<string[]> {
  const info = await stat(root).catch(() => null);
  if (!info) {
    return [];
  }
  if (info.isFile()) {
    return TEXT_EXTENSIONS.has(path.extname(root)) ? [root] : [];
  }
  if (!info.isDirectory()) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".venv") {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(child));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(child);
    }
  }
  return files;
}

function terms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_@.+-]+/g)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  );
}

function lineScore(line: string, queryTerms: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (lower.includes(term)) {
      score += term.length >= 5 ? 3 : 1;
    }
  }
  return score;
}

function snippetAround(lines: string[], index: number, contextLines: number): { lineStart: number; lineEnd: number; snippet: string } {
  const start = Math.max(0, index - contextLines);
  const end = Math.min(lines.length - 1, index + contextLines);
  return {
    lineStart: start + 1,
    lineEnd: end + 1,
    snippet: lines.slice(start, end + 1).join("\n").trim(),
  };
}

export async function searchMemory(
  query: string,
  options: { limit?: number; contextLines?: number; config?: PluginConfig } = {},
): Promise<SearchHit[]> {
  const config = options.config ?? {};
  const queryTerms = terms(query);
  if (queryTerms.length === 0) {
    return [];
  }
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 8)));
  const contextLines = Math.min(8, Math.max(0, Math.floor(options.contextLines ?? 2)));
  const maxFileBytes = Math.max(1024, Math.floor(config.maxFileBytes ?? 1024 * 1024));
  const files = (await Promise.all(allowedRoots(config).map((root) => collectFiles(root)))).flat();
  const hits: SearchHit[] = [];
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info || info.size > maxFileBytes) {
      continue;
    }
    const text = await readFile(file, "utf8").catch(() => "");
    if (!text.trim()) {
      continue;
    }
    const lines = text.split(/\r?\n/g);
    for (let index = 0; index < lines.length; index += 1) {
      const score = lineScore(lines[index] ?? "", queryTerms);
      if (score <= 0) {
        continue;
      }
      const snippet = snippetAround(lines, index, contextLines);
      hits.push({
        sourceId: sourceIdForPath(config, file),
        path: sourceIdForPath(config, file),
        lineStart: snippet.lineStart,
        lineEnd: snippet.lineEnd,
        score,
        snippet: snippet.snippet,
      });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.lineStart - b.lineStart)
    .slice(0, limit);
}

export async function fetchMemorySource(
  input: { sourceId?: string; filePath?: string; lineStart?: number; lineEnd?: number; maxChars?: number },
  config: PluginConfig = {},
): Promise<FetchResult> {
  const requested = input.sourceId || input.filePath;
  if (!requested) {
    throw new Error("sourceId or filePath is required");
  }
  const file = input.sourceId ? pathForSourceId(config, input.sourceId) : toSafePath(config, requested);
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/g);
  const lineStart = Math.max(1, Math.floor(input.lineStart ?? 1));
  const lineEnd = Math.min(lines.length, Math.max(lineStart, Math.floor(input.lineEnd ?? lines.length)));
  const maxChars = Math.max(256, Math.floor(input.maxChars ?? 8000));
  const content = lines.slice(lineStart - 1, lineEnd).join("\n").slice(0, maxChars);
  const sourceId = sourceIdForPath(config, file);
  return {
    sourceId,
    path: sourceId,
    lineStart,
    lineEnd,
    citation: `${sourceId}:${lineStart}`,
    content,
  };
}

function extractSentences(snippet: string, queryTerms: string[]): string[] {
  return snippet
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => queryTerms.some((term) => sentence.toLowerCase().includes(term)))
    .slice(0, 2);
}

export async function answerFromMemory(
  query: string,
  options: { limit?: number; config?: PluginConfig } = {},
): Promise<{ answer: string; citations: SearchHit[]; known: boolean }> {
  const hits = await searchMemory(query, { limit: options.limit ?? 6, contextLines: 2, config: options.config });
  const queryTerms = terms(query);
  if (hits.length === 0) {
    return {
      answer: "I did not find a cited memory source for that.",
      citations: [],
      known: false,
    };
  }
  const points: string[] = [];
  for (const hit of hits.slice(0, 4)) {
    const sentences = extractSentences(hit.snippet, queryTerms);
    const text = sentences[0] || hit.snippet.split(/\n+/g).find(Boolean) || "";
    if (text.trim()) {
      points.push(`- ${text.trim()} [${hit.path}:${hit.lineStart}]`);
    }
  }
  return {
    answer: points.length > 0 ? points.join("\n") : `Found cited memory, but no concise extractive answer could be formed. Start with ${hits[0]?.path}:${hits[0]?.lineStart}.`,
    citations: hits,
    known: true,
  };
}
