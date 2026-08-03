import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isSupportedSemver } from "./semver";
import { computeToolingSourceIdentityAtRevision } from "./tooling-source";

const [revision, ...extra] = Bun.argv.slice(2);
if (!revision || extra.length !== 0 || !/^[a-f0-9]{40}$/u.test(revision)) {
  throw new Error("Usage: bun run tools/release-build-metadata.ts <full-source-revision>");
}
const root = resolve(import.meta.dir, "..");
const head = git(root, ["rev-parse", "HEAD"]);
if (head !== revision || git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
  throw new Error("Standalone Bridge builds require the exact clean source revision");
}
const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
  version?: unknown;
};
if (!isSupportedSemver(metadata.version)) throw new Error("Blackglass package version is invalid");
console.log(JSON.stringify({
  version: metadata.version,
  revision,
  toolingSource: computeToolingSourceIdentityAtRevision(root, revision),
}));

function git(root: string, arguments_: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...arguments_]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}
