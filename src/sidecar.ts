import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type SidecarFormat = "native-memory-citations/graph" | "native-memory-citations/snapshot";

type FormatHeader = {
  format: SidecarFormat;
  version: number;
};

function isHeader(value: unknown): value is FormatHeader {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as Partial<FormatHeader>).format === "string"
    && typeof (value as Partial<FormatHeader>).version === "number",
  );
}

export async function atomicWriteText(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    if (process.platform === "win32") {
      await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonLines<T>(
  file: string,
  format: SidecarFormat,
  version: number,
  entries: T[],
): Promise<void> {
  const lines = [JSON.stringify({ format, version }), ...entries.map((entry) => JSON.stringify(entry))];
  await atomicWriteText(file, `${lines.join("\n")}\n`);
}

export async function readJsonLines<T>(
  file: string,
  format: SidecarFormat,
  supportedVersion: number,
  options: { warn?: (message: string) => void } = {},
): Promise<{ entries: T[]; skippedLines: number; version: number }> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (!text.trim()) {
    return { entries: [], skippedLines: 0, version: 0 };
  }
  const lines = text.split(/\r?\n/g).filter((line) => line.trim());
  let version = 0;
  let start = 0;
  try {
    const first = JSON.parse(lines[0] ?? "") as unknown;
    if (isHeader(first)) {
      if (first.format !== format) {
        throw new Error(`Unexpected sidecar format ${first.format}; expected ${format}`);
      }
      if (first.version > supportedVersion) {
        throw new Error(`Unsupported ${format} sidecar version ${first.version}; maximum supported is ${supportedVersion}`);
      }
      version = first.version;
      start = 1;
    }
  } catch (error) {
    if ((error as Error).message.startsWith("Unexpected sidecar format") || (error as Error).message.startsWith("Unsupported ")) {
      throw error;
    }
  }

  const entries: T[] = [];
  let skippedLines = 0;
  for (let index = start; index < lines.length; index += 1) {
    try {
      entries.push(JSON.parse(lines[index]!) as T);
    } catch (error) {
      skippedLines += 1;
      options.warn?.(`native-memory-citations: skipped corrupt ${format} line ${index + 1}: ${String(error)}`);
    }
  }
  return { entries, skippedLines, version };
}

export async function writeVersionedJson<T extends Record<string, unknown>>(
  file: string,
  format: SidecarFormat,
  version: number,
  value: T,
): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify({ format, version, ...value })}\n`);
}

export async function readVersionedJson<T extends Record<string, unknown>>(
  file: string,
  format: SidecarFormat,
  supportedVersion: number,
): Promise<(T & Partial<FormatHeader>) | undefined> {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (!text.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(text) as T & Partial<FormatHeader>;
  if (parsed.format !== undefined && parsed.format !== format) {
    throw new Error(`Unexpected sidecar format ${parsed.format}; expected ${format}`);
  }
  if (typeof parsed.version === "number" && parsed.version > supportedVersion) {
    throw new Error(`Unsupported ${format} sidecar version ${parsed.version}; maximum supported is ${supportedVersion}`);
  }
  return parsed;
}
