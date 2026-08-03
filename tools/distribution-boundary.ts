import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const forbiddenIdentity = ["bea", "ini"].join("");
const forbiddenDomain = ["mkna", "ca"].join(".");
const forbiddenText = [
  new RegExp(forbiddenIdentity, "iu"),
  new RegExp(`(?:[a-z0-9-]+\\.)*${forbiddenDomain.replace(".", "\\.")}`, "iu"),
  /\/Users\/m\/Software\//u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
];
const forbiddenArtifactPath = /(?:^|\/)[^/]+\.(?:asar|dmg|pkg|zip|tar\.gz)(?:$|\/)|(?:^|\/)[^/]+\.app(?:$|\/)/iu;

const arguments_ = Bun.argv.slice(2);
const roots = arguments_.length === 0
  ? [resolve(import.meta.dir, "..")]
  : arguments_.map((argument) => resolve(argument));
const failures: string[] = [];
for (const root of roots) await inspectRepository(root);
if (failures.length !== 0) {
  throw new Error(`Distribution boundary violations:\n${failures.join("\n")}`);
}
console.log(JSON.stringify({ passed: true, repositories: roots }, null, 2));

async function inspectRepository(root: string): Promise<void> {
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of files) {
    if (forbiddenArtifactPath.test(path)) failures.push(`${basename(root)}:${path}: proprietary artifact path`);
    let bytes: Buffer;
    try { bytes = await readFile(resolve(root, path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" &&
          git(root, ["diff", "--name-only", "--diff-filter=D", "--", path]).trim() === path) {
        continue;
      }
      throw error;
    }
    inspectText(`${basename(root)}:${path}`, bytes.toString("latin1"));
    if (/^compatibility\/obsidian-[0-9.]+\.json$/u.test(path)) {
      inspectBaseline(`${basename(root)}:${path}`, JSON.parse(bytes.toString("utf8")) as unknown);
    }
  }
  const historicalPaths = git(root, ["log", "--all", "--name-only", "--format=", "-z"])
    .split("\0").filter(Boolean);
  for (const path of historicalPaths) {
    if (forbiddenArtifactPath.test(path)) {
      failures.push(`${basename(root)}:${path}: proprietary/archive path in reachable Git history`);
    }
  }
  const history = git(root, ["log", "--all", "--format=fuller", "-p", "--text"]);
  inspectText(`${basename(root)}:reachable-git-history`, history);
}

function inspectText(label: string, text: string): void {
  for (const pattern of forbiddenText) {
    if (pattern.test(text)) failures.push(`${label}: matched forbidden private identifier or secret pattern`);
  }
}

function inspectBaseline(label: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${label}: baseline is not an object`);
    return;
  }
  const record = value as Record<string, unknown>;
  if (containsKey(record, "literal")) failures.push(`${label}: contains a proprietary source literal`);
  for (const field of ["patchIncisions", "wrapperIncisions"] as const) {
    if (!Array.isArray(record[field]) || record[field].length === 0) {
      failures.push(`${label}: missing reviewed ${field}`);
      continue;
    }
    for (const range of record[field] as Array<Record<string, unknown>>) {
      if (
        !Number.isSafeInteger(range.offset) || Number(range.offset) < 0 ||
        !Number.isSafeInteger(range.length) || Number(range.length) < 1 ||
        typeof range.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(range.sha256)
      ) failures.push(`${label}: malformed hash-and-offset incision`);
    }
  }
}

function containsKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, key) ||
    Object.values(record).some((entry) => containsKey(entry, key));
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString();
}
