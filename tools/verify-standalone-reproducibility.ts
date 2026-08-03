import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const [firstArgument, secondArgument, revision, outputArgument, ...extra] = Bun.argv.slice(2);
if (!firstArgument || !secondArgument || !outputArgument || extra.length !== 0 || !/^[a-f0-9]{40}$/u.test(revision ?? "")) {
  throw new Error("Usage: bun run tools/verify-standalone-reproducibility.ts <first-directory> <second-directory> <revision> <output.json>");
}
const first = resolve(firstArgument);
const second = resolve(secondArgument);
if (first === second) throw new Error("Standalone reproducibility requires separate output directories");
for (const directory of [first, second]) {
  const verified = Bun.spawnSync([
    Bun.which("bun") ?? "bun", "run", resolve(import.meta.dir, "verify-standalone-bridge.ts"), directory, revision!,
  ], { stdout: "pipe", stderr: "pipe" });
  if (verified.exitCode !== 0) throw new Error(verified.stderr.toString("utf8").trim());
}
const manifests = await Array.fromAsync(new Bun.Glob("blackglass-bridge-v*-macos-arm64.json").scan({ cwd: first, onlyFiles: true }));
if (manifests.length !== 1) throw new Error("First standalone output has no unique manifest");
const base = manifests[0]!.replace(/\.json$/u, "");
const files = [base, `${base}.sha256`, `${base}.zip`, `${base}.zip.sha256`, `${base}.json`];
const identities = [];
for (const name of files) {
  const firstBytes = await readFile(join(first, name));
  const secondBytes = await readFile(join(second, name));
  if (!firstBytes.equals(secondBytes)) throw new Error(`Independent standalone assets differ: ${name}`);
  identities.push({ name: basename(name), sha256: createHash("sha256").update(firstBytes).digest("hex") });
}
const output = resolve(outputArgument);
await writeFile(output, `${JSON.stringify({
  schemaVersion: 1, passed: true, sourceRevision: revision, separateOutputs: true, assets: identities,
}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ passed: true, output, assets: identities }, null, 2));
