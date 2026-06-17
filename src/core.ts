import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
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

export type AnswerResult = {
  answer: string;
  citations: SearchHit[];
  known: boolean;
};

const DEFAULT_PRIVATE_ROOTS = ["memory", "MEMORY.md", "USER.md", "IDENTITY.md", "TOOLS.md"];
const DEFAULT_SHARED_ROOTS = ["memory", "USER.md", "IDENTITY.md", "TOOLS.md"];
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"]);
const ANSWER_MIN_SCORE = 3;

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Math.floor(value ?? fallback);
  if (Number.isNaN(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function defaultWorkspace(): string {
  const fromEnv = process.env.OPENCLAW_WORKSPACE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".openclaw", "workspace");
}

export function workspaceFromConfig(config: PluginConfig = {}): string {
  return path.resolve(config.workspace?.trim() || defaultWorkspace());
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

function within(target: string, roots: string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
}

async function realpathOrSelf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

export async function toSafePath(config: PluginConfig, requested: string): Promise<string> {
  const workspace = workspaceFromConfig(config);
  const resolved = path.resolve(workspace, requested);
  const roots = allowedRoots(config);

  if (!within(resolved, roots)) {
    throw new Error(`Path is outside allowed memory roots: ${requested}`);
  }

  const realTarget = await realpathOrSelf(resolved);
  const realRoots = await Promise.all(roots.map(realpathOrSelf));
  if (!within(realTarget, realRoots)) {
    throw new Error(`Path resolves via symlink outside allowed memory roots: ${requested}`);
  }

  return resolved;
}

export function sourceIdForPath(config: PluginConfig, absolutePath: string): string {
  return path.relative(workspaceFromConfig(config), absolutePath).split(path.sep).join("/");
}

export async function pathForSourceId(config: PluginConfig, sourceId: string): Promise<string> {
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

type Region = { start: number; end: number; score: number };

function mergeRegions(
  matches: { index: number; score: number }[],
  contextLines: number,
  lineCount: number,
): Region[] {
  const regions: Region[] = [];
  let current: Region | null = null;
  for (const match of matches) {
    const start = Math.max(0, match.index - contextLines);
    const end = Math.min(lineCount - 1, match.index + contextLines);
    if (current && start <= current.end + 1) {
      current.end = Math.max(current.end, end);
      current.score += match.score;
    } else {
      if (current) {
        regions.push(current);
      }
      current = { start, end, score: match.score };
    }
  }
  if (current) {
    regions.push(current);
  }
  return regions;
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
  const limit = clampInt(options.limit, 8, 1, 50);
  const contextLines = clampInt(options.contextLines, 2, 0, 8);
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
    const matches: { index: number; score: number }[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const score = lineScore(lines[index] ?? "", queryTerms);
      if (score > 0) {
        matches.push({ index, score });
      }
    }
    if (matches.length === 0) {
      continue;
    }
    const sourceId = sourceIdForPath(config, file);
    for (const region of mergeRegions(matches, contextLines, lines.length)) {
      hits.push({
        sourceId,
        path: sourceId,
        lineStart: region.start + 1,
        lineEnd: region.end + 1,
        score: region.score,
        snippet: lines.slice(region.start, region.end + 1).join("\n").trim(),
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
  const file = await toSafePath(config, requested);
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
): Promise<AnswerResult> {
  const hits = await searchMemory(query, {
    limit: options.limit ?? 6,
    contextLines: 2,
    config: options.config,
  });
  const queryTerms = terms(query);

  const distinctTermsMatched = queryTerms.filter((term) =>
    hits.some((hit) => hit.snippet.toLowerCase().includes(term)),
  ).length;
  const requiredDistinctTerms = Math.min(2, queryTerms.length);
  const topScore = hits[0]?.score ?? 0;
  const confident = hits.length > 0
    && topScore >= ANSWER_MIN_SCORE
    && distinctTermsMatched >= requiredDistinctTerms;

  if (!confident) {
    return {
      answer: "I did not find a sufficiently specific cited memory source for that.",
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
    answer: points.length > 0
      ? points.join("\n")
      : `Found cited memory, but no concise extractive answer could be formed. Start with ${hits[0]?.path}:${hits[0]?.lineStart}.`,
    citations: hits,
    known: true,
  };
}
