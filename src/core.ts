import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  matchLine: number;
  matchText: string;
  sha256: string;
};

export type FetchResult = {
  sourceId: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  citation: string;
  content: string;
  sha256: string;
  stale?: boolean;
  staleMessage?: string;
};

export type AnswerResult = {
  answer: string;
  citations: SearchHit[];
  known: boolean;
};

export type MemoryLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

const DEFAULT_PRIVATE_ROOTS = ["memory", "MEMORY.md", "USER.md", "IDENTITY.md", "TOOLS.md"];
const DEFAULT_SHARED_ROOTS = ["memory", "USER.md", "IDENTITY.md", "TOOLS.md"];
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"]);
const ANSWER_MIN_SCORE = 3;
const ANSWER_MIN_TERM_RATIO = 0.5;
const MAX_REGION_LINES = 25;
const FILE_CACHE_MAX = 512;
const MAX_LINE_CHARS = 2000;
const MAX_SNIPPET_CHARS = 4000;
const DEFAULT_FETCH_CHARS = 8000;
const MAX_FETCH_CHARS = 20000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const SCAN_CONCURRENCY = 8;
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "on",
  "for",
  "from",
  "is",
  "it",
  "its",
  "at",
  "by",
  "as",
  "with",
  "this",
  "that",
  "what",
  "which",
  "who",
  "how",
  "why",
  "when",
  "where",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "you",
  "your",
  "i",
  "my",
  "me",
  "we",
  "our",
  "are",
  "was",
  "were",
  "be",
  "been",
]);

type CachedFile = { mtimeMs: number; size: number; lines: string[]; sha256: string };
const fileCache = new Map<string, CachedFile>();

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Math.floor(value ?? fallback);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function maxFileBytes(config: PluginConfig = {}): number {
  const n = Math.floor(config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  if (!Number.isFinite(n)) {
    return DEFAULT_MAX_FILE_BYTES;
  }
  return Math.max(1024, n);
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
  return roots.map((root) => {
    const trimmed = root.trim();
    const segments = trimmed.split(/[\\/]+/g);
    if (
      !trimmed
      || trimmed === "."
      || trimmed === ".."
      || path.isAbsolute(trimmed)
      || segments.some((segment) => segment === "..")
      || segments.some((segment) => segment.startsWith("."))
    ) {
      throw new Error(`Invalid allowedRoots entry: ${root}`);
    }
    return path.resolve(workspace, trimmed);
  });
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

function hasHiddenPathSegment(sourceId: string): boolean {
  return sourceId.split("/").some((segment) => segment.startsWith("."));
}

function isTextFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(file));
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function redactSecrets(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/[\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-proj-|sk-)[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgh[psuor]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(
      /\b([A-Za-z0-9_.-]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|CLIENT[_-]?SECRET)[A-Za-z0-9_.-]*\s*[:=]\s*)([^\s"'`]+|"[^"\n]+"|'[^'\n]+')/gi,
      "$1[REDACTED]",
    );
}

async function collectFiles(root: string, logger?: MemoryLogger): Promise<string[]> {
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
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(child, logger));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(child);
    } else if (entry.isSymbolicLink()) {
      logger?.warn?.(`native-memory-citations: skipped symlink during search: ${child}`);
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
        .filter((term) => term.length >= 2 && !STOPWORDS.has(term)),
    ),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Matcher = { test: (lower: string) => boolean; weight: number };

function buildMatchers(queryTerms: string[]): Matcher[] {
  return queryTerms.map((term) => {
    const weight = term.length >= 5 ? 3 : 1;
    if (term.length >= 4) {
      return { test: (lower: string) => lower.includes(term), weight };
    }
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:[^a-z0-9]|$)`);
    return { test: (lower: string) => re.test(lower), weight };
  });
}

function scoreLine(line: string, matchers: Matcher[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const matcher of matchers) {
    if (matcher.test(lower)) {
      score += matcher.weight;
    }
  }
  return score;
}

async function loadFile(file: string, maxFileBytes: number, logger?: MemoryLogger): Promise<CachedFile | null> {
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) {
    fileCache.delete(file);
    return null;
  }
  if (info.size > maxFileBytes) {
    fileCache.delete(file);
    logger?.warn?.(`native-memory-citations: skipped oversized file: ${file}`);
    return null;
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    fileCache.delete(file);
    fileCache.set(file, cached);
    return cached;
  }
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text.trim()) {
    fileCache.delete(file);
    return null;
  }
  const lines = text.split(/\r?\n/g);
  const loaded = { mtimeMs: info.mtimeMs, size: info.size, lines, sha256: sha256Text(text) };
  fileCache.set(file, loaded);
  if (fileCache.size > FILE_CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    if (oldest !== undefined) {
      fileCache.delete(oldest);
    }
  }
  return loaded;
}

type Region = { start: number; end: number; score: number; anchorIndex: number; anchorScore: number };

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
    const currentLineCount = current ? current.end - current.start + 1 : 0;
    if (current && start <= current.end + 1 && currentLineCount < MAX_REGION_LINES) {
      current.end = Math.max(current.end, end);
      current.score += match.score;
      if (match.score > current.anchorScore) {
        current.anchorScore = match.score;
        current.anchorIndex = match.index;
      }
    } else {
      if (current) {
        regions.push(current);
      }
      current = { start, end, score: match.score, anchorIndex: match.index, anchorScore: match.score };
    }
  }
  if (current) {
    regions.push(current);
  }
  return regions;
}

export async function searchMemory(
  query: string,
  options: {
    limit?: number;
    contextLines?: number;
    config?: PluginConfig;
    signal?: AbortSignal;
    logger?: MemoryLogger;
  } = {},
): Promise<SearchHit[]> {
  const config = options.config ?? {};
  const queryTerms = terms(query);
  options.signal?.throwIfAborted();
  const matchers = buildMatchers(queryTerms);
  if (matchers.length === 0) {
    return [];
  }
  const limit = clampInt(options.limit, 8, 1, 50);
  const contextLines = clampInt(options.contextLines, 2, 0, 8);
  const fileSizeLimit = maxFileBytes(config);
  const files = (await Promise.all(allowedRoots(config).map((root) => collectFiles(root, options.logger)))).flat();

  const hits: SearchHit[] = [];
  for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
    options.signal?.throwIfAborted();
    const batch = files.slice(i, i + SCAN_CONCURRENCY);
    const batchHits = await Promise.all(batch.map(async (file) => {
      options.signal?.throwIfAborted();
      const loaded = await loadFile(file, fileSizeLimit, options.logger);
      if (!loaded) {
        return [] as SearchHit[];
      }
      const { lines, sha256 } = loaded;
      const matches: { index: number; score: number }[] = [];
      for (let index = 0; index < lines.length; index += 1) {
        if (index % 512 === 0) {
          options.signal?.throwIfAborted();
        }
        const score = scoreLine(lines[index] ?? "", matchers);
        if (score > 0) {
          matches.push({ index, score });
        }
      }
      if (matches.length === 0) {
        return [] as SearchHit[];
      }
      const sourceId = sourceIdForPath(config, file);
      return mergeRegions(matches, contextLines, lines.length).map((region) => {
        const rawSnippet = lines.slice(region.start, region.end + 1).join("\n").slice(0, MAX_SNIPPET_CHARS).trim();
        const distinctTerms = matchedTermCount(rawSnippet, matchers);
        return {
          sourceId,
          path: sourceId,
          lineStart: region.start + 1,
          lineEnd: region.end + 1,
          score: distinctTerms * 100 + Math.min(region.score, 50),
          snippet: redactSecrets(rawSnippet),
          matchLine: region.anchorIndex + 1,
          matchText: redactSecrets((lines[region.anchorIndex] ?? "").slice(0, MAX_LINE_CHARS).trim()),
          sha256,
        } satisfies SearchHit;
      });
    }));
    for (const fileHits of batchHits) {
      hits.push(...fileHits);
    }
  }

  const sortedHits = hits
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.lineStart - b.lineStart)
    .slice(0, limit);
  options.logger?.debug?.(`native-memory-citations: scanned ${files.length} files, returned ${sortedHits.length} hits`);
  return sortedHits;
}

export async function fetchMemorySource(
  input: {
    sourceId?: string;
    filePath?: string;
    lineStart?: number;
    lineEnd?: number;
    maxChars?: number;
    expectedSha256?: string;
  },
  config: PluginConfig = {},
): Promise<FetchResult> {
  const requested = input.sourceId || input.filePath;
  if (!requested) {
    throw new Error("sourceId or filePath is required");
  }
  const file = await toSafePath(config, requested);
  const sourceId = sourceIdForPath(config, file);
  if (hasHiddenPathSegment(sourceId)) {
    throw new Error(`Path includes a hidden memory segment: ${sourceId}`);
  }
  if (!isTextFile(file)) {
    throw new Error(`Path is not an approved text memory file: ${sourceId}`);
  }
  const info = await stat(file).catch(() => null);
  const fileSizeLimit = maxFileBytes(config);
  if (!info || !info.isFile()) {
    throw new Error(`Path is not a readable memory file: ${sourceId}`);
  }
  if (info.size > fileSizeLimit) {
    throw new Error(`Memory file exceeds maxFileBytes: ${sourceId}`);
  }
  const text = await readFile(file, "utf8");
  const sha256 = sha256Text(text);
  const lines = text.split(/\r?\n/g);
  const requestedStart = Math.max(1, Math.floor(input.lineStart ?? 1));
  const lineStart = Math.min(lines.length, requestedStart);
  const requestedEnd = Math.max(1, Math.floor(input.lineEnd ?? lines.length));
  const lineEnd = Math.min(lines.length, Math.max(lineStart, requestedEnd));
  const maxChars = clampInt(input.maxChars, DEFAULT_FETCH_CHARS, 256, MAX_FETCH_CHARS);
  const content = redactSecrets(lines.slice(lineStart - 1, lineEnd).join("\n").slice(0, maxChars));
  const expectedSha256 = input.expectedSha256?.trim().toLowerCase();
  const stale = Boolean(expectedSha256 && expectedSha256 !== sha256);
  return {
    sourceId,
    path: sourceId,
    lineStart,
    lineEnd,
    citation: `${sourceId}:${lineStart}`,
    content,
    sha256,
    ...(stale
      ? {
          stale: true,
          staleMessage: `Citation hash mismatch for ${sourceId}: expected ${expectedSha256}, current ${sha256}`,
        }
      : {}),
  };
}

function extractSentences(snippet: string, matchers: Matcher[]): string[] {
  return snippet
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence, index) => ({ sentence, index, score: scoreLine(sentence, matchers) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.sentence)
    .slice(0, 2);
}

function matchedTermCount(snippet: string, matchers: Matcher[]): number {
  const lower = snippet.toLowerCase();
  return matchers.filter((matcher) => matcher.test(lower)).length;
}

function requiredMatchedTerms(queryTerms: string[]): number {
  if (queryTerms.length <= 1) {
    return queryTerms.length;
  }
  return Math.min(
    queryTerms.length,
    Math.max(2, Math.ceil(queryTerms.length * ANSWER_MIN_TERM_RATIO)),
  );
}

export async function answerFromMemory(
  query: string,
  options: { limit?: number; config?: PluginConfig; signal?: AbortSignal; logger?: MemoryLogger } = {},
): Promise<AnswerResult> {
  const queryTerms = terms(query);
  const matchers = buildMatchers(queryTerms);
  const hits = await searchMemory(query, {
    limit: options.limit ?? 6,
    contextLines: 2,
    config: options.config,
    signal: options.signal,
    logger: options.logger,
  });

  const distinctTermsMatched = matchers.filter((matcher) =>
    hits.some((hit) => matcher.test(hit.snippet.toLowerCase())),
  ).length;
  const requiredDistinctTerms = requiredMatchedTerms(queryTerms);
  const topScore = hits[0]?.score ?? 0;
  const hasSupportingHit = hits.some((hit) => matchedTermCount(hit.snippet, matchers) >= requiredDistinctTerms);
  const supportingHits = hits.filter((hit) => matchedTermCount(hit.snippet, matchers) >= requiredDistinctTerms);
  const confident = hits.length > 0
    && topScore >= ANSWER_MIN_SCORE
    && distinctTermsMatched >= requiredDistinctTerms
    && hasSupportingHit;

  if (!confident) {
    return {
      answer: "I did not find a sufficiently specific cited memory source for that.",
      citations: [],
      known: false,
    };
  }

  const points: string[] = [];
  for (const hit of supportingHits.slice(0, 1)) {
    const sentences = extractSentences(hit.snippet, matchers);
    const text = hit.matchText || sentences[0] || hit.snippet.split(/\n+/g).find(Boolean) || "";
    if (text.trim()) {
      points.push(`- ${text.trim()} [${hit.path}:${hit.matchLine}]`);
    }
  }

  return {
    answer: points.length > 0
      ? points.join("\n")
      : `Found cited memory, but no concise extractive answer could be formed. Start with ${supportingHits[0]?.path}:${supportingHits[0]?.matchLine ?? supportingHits[0]?.lineStart}.`,
    citations: supportingHits,
    known: true,
  };
}
