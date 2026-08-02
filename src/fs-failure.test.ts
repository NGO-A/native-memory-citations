import { mkdtemp, mkdir, readFile as actualReadFile, writeFile as actualWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const failureState = vi.hoisted(() => ({
  writeTemporary: false,
  renameTemporary: false,
  unreadablePath: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async writeFile(file: Parameters<typeof actual.writeFile>[0], ...args: unknown[]) {
      if (failureState.writeTemporary && String(file).endsWith(".tmp")) {
        throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
      }
      return (actual.writeFile as (...values: unknown[]) => unknown)(file, ...args);
    },
    async rename(from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) {
      if (failureState.renameTemporary && String(from).endsWith(".tmp")) {
        throw Object.assign(new Error("simulated interrupted rename"), { code: "EIO" });
      }
      return actual.rename(from, to);
    },
    async readFile(file: Parameters<typeof actual.readFile>[0], ...args: unknown[]) {
      if (failureState.unreadablePath && path.resolve(String(file)) === path.resolve(failureState.unreadablePath)) {
        throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
      }
      return (actual.readFile as (...values: unknown[]) => unknown)(file, ...args);
    },
  };
});

import { searchMemoryDetailed } from "./core.js";
import { atomicWriteText } from "./sidecar.js";

afterEach(() => {
  failureState.writeTemporary = false;
  failureState.renameTemporary = false;
  failureState.unreadablePath = "";
});

describe("filesystem failure injection", () => {
  it("serializes concurrent atomic replacements of the same sidecar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nmc-concurrent-replace-"));
    const file = path.join(root, "sidecar.json");
    const replacements = Array.from({ length: 8 }, (_, index) => `replacement-${index}\n`);

    await Promise.all(replacements.map((content) => atomicWriteText(file, content)));

    expect(replacements).toContain(await actualReadFile(file, "utf8"));
  });

  it("keeps the original sidecar intact on ENOSPC before rename", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nmc-enospc-"));
    const file = path.join(root, "sidecar.json");
    await actualWriteFile(file, "original\n");
    failureState.writeTemporary = true;
    await expect(atomicWriteText(file, "replacement\n")).rejects.toThrow(/ENOSPC/);
    expect(await actualReadFile(file, "utf8")).toBe("original\n");
  });

  it("keeps the original sidecar intact when rename is interrupted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nmc-rename-"));
    const file = path.join(root, "sidecar.json");
    await actualWriteFile(file, "original\n");
    failureState.renameTemporary = true;
    await expect(atomicWriteText(file, "replacement\n")).rejects.toThrow(/interrupted rename/);
    expect(await actualReadFile(file, "utf8")).toBe("original\n");
  });

  it("counts EACCES files while returning readable search results", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "nmc-eacces-"));
    await mkdir(path.join(workspace, "memory"), { recursive: true });
    const unreadable = path.join(workspace, "memory", "denied.md");
    await actualWriteFile(unreadable, "permissionmarker denied\n");
    await actualWriteFile(path.join(workspace, "memory", "readable.md"), "permissionmarker readable\n");
    failureState.unreadablePath = unreadable;
    const debug: string[] = [];
    const result = await searchMemoryDetailed("permissionmarker", {
      config: { workspace },
      logger: { debug: (message) => debug.push(message) },
    });
    expect(result.hits.some((hit) => hit.path === "memory/readable.md")).toBe(true);
    expect(result.skippedFiles).toBe(1);
    expect(debug.join("\n")).toContain("skipped unreadable file");
  });
});
