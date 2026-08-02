import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const root = await mkdtemp(path.join(tmpdir(), "nmc-pack-smoke-"));
const packDir = path.join(root, "pack");
const scratch = path.join(root, "scratch");
const workspace = path.join(root, "workspace");
await mkdir(packDir, { recursive: true });
await mkdir(path.join(workspace, "memory"), { recursive: true });
await mkdir(scratch, { recursive: true });
await writeFile(path.join(workspace, "memory", "note.md"), "tarball smoke bounded marker\n");
await writeFile(path.join(scratch, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);

const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], repo));
const filename = packed[0]?.filename;
if (!filename) {
  throw new Error("npm pack did not report a tarball filename");
}
run("npm", ["install", "--no-audit", "--no-fund", path.join(packDir, filename)], scratch);

const packageJson = JSON.parse(await readFile(path.join(scratch, "node_modules", "@ngo-a", "native-memory-citations", "package.json"), "utf8"));
const entry = path.join(scratch, "node_modules", "@ngo-a", "native-memory-citations", packageJson.openclaw.extensions[0]);
const { default: plugin } = await import(pathToFileURL(entry).href);
const tools = [];
plugin.register({
  pluginConfig: { workspace },
  registerTool(tool) { tools.push(tool); },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
const names = tools.map((tool) => tool.name).sort();
if (JSON.stringify(names) !== JSON.stringify(["native_memory_answer", "native_memory_fetch", "native_memory_search"])) {
  throw new Error(`unexpected bounded tarball tools: ${names.join(", ")}`);
}
const search = tools.find((tool) => tool.name === "native_memory_search");
const result = await search.execute("pack-smoke", { query: "tarball smoke marker" });
if (!result?.details?.hits?.some((hit) => hit.sourceId === "memory/note.md")) {
  throw new Error(`packed bounded search did not return the fixture: ${JSON.stringify(result)}`);
}
process.stdout.write(`tarball smoke passed: ${filename}\n`);
