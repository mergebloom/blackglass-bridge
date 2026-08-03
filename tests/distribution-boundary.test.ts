import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

const tool = resolve(import.meta.dir, "../tools/distribution-boundary.ts");

test("rejects prohibited artifact paths containing spaces in reachable history", async () => {
  const root = await repository();
  const artifact = join(root, "vendor/Official App.app/Contents");
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "binary"), Buffer.from([0, 1, 2, 3]));
  commit(root, "add prohibited path");
  Bun.spawnSync(["git", "-C", root, "rm", "-r", "vendor"], { stdout: "ignore" });
  commit(root, "remove prohibited path");
  const result = run(root);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("reachable Git history");
});

test("scans NUL-containing tracked files for private identifiers", async () => {
  const root = await repository();
  await writeFile(join(root, "binary.dat"), Buffer.concat([
    Buffer.from([0, 1, 2]),
    Buffer.from(["private", "mk" + "na", "ca"].join(".")),
  ]));
  commit(root, "add binary secret");
  git(root, "rm", "binary.dat");
  commit(root, "remove binary secret");
  const result = run(root);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("matched forbidden private identifier");
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackglass-distribution-boundary-"));
  git(root, "init", "--quiet");
  await writeFile(join(root, "README.md"), "safe\n");
  commit(root, "initial");
  return root;
}

function commit(root: string, message: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.name=mergebloom", "-c", "user.email=mergebloom@users.noreply.github.com", "commit", "--quiet", "-m", message);
}

function git(root: string, ...arguments_: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...arguments_], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function run(root: string) {
  return Bun.spawnSync([Bun.which("bun")!, "run", tool, root], { stdout: "pipe", stderr: "pipe" });
}
