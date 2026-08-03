import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isSupportedSemver } from "./semver";
import { stableJson } from "./stable-json";
import { assertStandaloneBridgeBuildInfo } from "./standalone-bridge";
import { assertToolingSourceIdentity } from "./tooling-source";

const [directoryArgument, revisionArgument, ...extra] = Bun.argv.slice(2);
if (!directoryArgument || !revisionArgument || extra.length !== 0 || !/^[a-f0-9]{40}$/u.test(revisionArgument)) {
  throw new Error("Usage: bun run tools/verify-standalone-bridge.ts <release-directory> <full-source-revision>");
}
const directory = resolve(directoryArgument);
const files = await Array.fromAsync(new Bun.Glob("blackglass-bridge-v*-macos-arm64.json").scan({ cwd: directory, onlyFiles: true }));
if (files.length !== 1) throw new Error("Standalone release directory must contain exactly one manifest");
const manifestPath = join(directory, files[0]!);
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
if (
  manifest.schemaVersion !== 2 || manifest.name !== "blackglass-bridge" ||
  !isSupportedSemver(manifest.version) || manifest.sourceRevision !== revisionArgument ||
  !isRecord(manifest.target) || manifest.target.operatingSystem !== "macOS" ||
  manifest.target.architecture !== "arm64" || typeof manifest.executable !== "string" ||
  !isSha256(manifest.executableSha256) || !Array.isArray(manifest.embeddedCompatibilityBaselines)
) throw new Error("Standalone release manifest is malformed or source-mismatched");
assertToolingSourceIdentity(manifest.toolingSource);
if (manifest.toolingSource.gitRevision !== revisionArgument || manifest.toolingSource.worktreeClean !== true) {
  throw new Error("Standalone release manifest is not bound to its clean source revision");
}
const base = `blackglass-bridge-v${manifest.version}-macos-arm64`;
if (basename(manifestPath) !== `${base}.json` || manifest.executable !== base) {
  throw new Error("Standalone release filenames do not match the manifest");
}
const executable = join(directory, base);
const archive = `${executable}.zip`;
for (const path of [executable, `${executable}.sha256`, archive, `${archive}.sha256`, manifestPath]) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Standalone release asset is not a regular file: ${path}`);
}
const executableSha256 = await sha256File(executable);
if (executableSha256 !== manifest.executableSha256) throw new Error("Standalone executable hash differs from its manifest");
await verifyChecksum(`${executable}.sha256`, base, executableSha256);
await verifyChecksum(`${archive}.sha256`, `${base}.zip`, await sha256File(archive));
const architectures = runText(["/usr/bin/lipo", "-archs", executable]).split(/\s+/u).filter(Boolean);
if (architectures.length !== 1 || architectures[0] !== "arm64") throw new Error("Standalone executable is not arm64-only");
const infoResult = Bun.spawnSync([executable, "build-info"], { stdout: "pipe", stderr: "pipe" });
if (infoResult.exitCode !== 0) throw new Error("Standalone executable build-info failed");
const info = JSON.parse(infoResult.stdout.toString("utf8")) as unknown;
assertStandaloneBridgeBuildInfo(info);
if (info.version !== manifest.version || info.sourceRevision !== revisionArgument ||
    stableJson(info.toolingSource) !== stableJson(manifest.toolingSource)) {
  throw new Error("Standalone executable identity differs from its release manifest");
}
const archiveEntries = runText(["/usr/bin/unzip", "-Z1", archive]).split("\n").filter(Boolean).sort();
const expectedEntries = ["INSTALL.md", "LICENSE", base, `${base}.json`].sort();
if (JSON.stringify(archiveEntries) !== JSON.stringify(expectedEntries)) {
  throw new Error("Standalone archive contains unexpected files");
}
for (const [entry, expected] of [
  [base, await readFile(executable)],
  [`${base}.json`, await readFile(manifestPath)],
  ["INSTALL.md", await readFile(resolve(import.meta.dir, "../docs/bridge-cli.md"))],
  ["LICENSE", await readFile(resolve(import.meta.dir, "../LICENSE"))],
] as const) {
  const archived = runBytes(["/usr/bin/unzip", "-p", archive, entry]);
  if (!archived.equals(expected)) throw new Error(`Standalone archive entry differs from its attested source: ${entry}`);
}
console.log(JSON.stringify({ passed: true, version: manifest.version, sourceRevision: revisionArgument, executableSha256 }, null, 2));

async function verifyChecksum(path: string, expectedName: string, expectedHash: string): Promise<void> {
  const contents = (await readFile(path, "utf8")).trim();
  if (contents !== `${expectedHash}  ${expectedName}`) throw new Error(`Invalid checksum file: ${path}`);
}
async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
function runText(arguments_: string[]): string {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
  return result.stdout.toString("utf8").trim();
}
function runBytes(arguments_: string[]): Buffer {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
  return Buffer.from(result.stdout);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
