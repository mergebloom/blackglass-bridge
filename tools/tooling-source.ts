import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";
import { compareCodeUnitStrings } from "./stable-json";
import { resolveReleaseGitExecutable } from "./packaging-toolchain";

export const TOOLING_SOURCE_IDENTITY_FORMAT_VERSION = 2;
export const TOOLING_SOURCE_SCOPE = "release-critical-v1" as const;

export const TOOLING_SOURCE_FILES = [
  ".bun-version",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
] as const;

export const TOOLING_SOURCE_DIRECTORIES = [
  ".github/workflows",
  "compatibility",
  "docs",
  "packages",
  "scripts",
  "tests",
  "tools",
] as const;

export interface ToolingSourceIdentity {
  formatVersion: typeof TOOLING_SOURCE_IDENTITY_FORMAT_VERSION;
  scope: typeof TOOLING_SOURCE_SCOPE;
  gitRevision: string | null;
  worktreeClean: boolean;
  treeSha256: string;
  files: number;
  fileBytes: number;
}

interface ToolingFileRecord {
  path: string;
  executable: boolean;
  bytes: number;
  sha256: string;
}

interface GitTreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

export async function computeToolingSourceIdentity(
  rootArgument = resolve(import.meta.dir, ".."),
): Promise<ToolingSourceIdentity> {
  const root = resolve(rootArgument);
  const records = new Map<string, ToolingFileRecord>();
  const trackedPaths = gitTrackedPaths(root);
  if (!trackedPaths) {
    throw new Error("Tooling source identity requires a Git worktree");
  }
  assertRequiredScope(trackedPaths);
  for (const path of trackedPaths
    .filter(isToolingSourcePath)
    .sort(compareCodeUnitStrings)) {
    await addToolingFile(root, join(root, path), records);
  }
  const git = gitIdentity(root);
  return buildToolingSourceIdentity(records, git.revision, git.clean);
}

export function computeToolingSourceIdentityAtRevision(
  rootArgument: string,
  revision: string,
): ToolingSourceIdentity {
  assertGitRevision(revision, "Tooling source revision");
  const root = resolve(rootArgument);
  const resolvedRevision = runGitText(root, [
    "rev-parse",
    "--verify",
    `${revision}^{commit}`,
  ]);
  if (resolvedRevision !== revision) {
    throw new Error("Tooling source revision does not resolve to the exact commit");
  }

  const result = Bun.spawnSync([
    resolveReleaseGitExecutable(),
    "-C",
    root,
    "ls-tree",
    "-r",
    "-z",
    "--long",
    revision,
    "--",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to read tooling source tree: ${stderrText(result)}`);
  }
  const entries = Buffer.from(result.stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const paths: string[] = [];
  const records = new Map<string, ToolingFileRecord>();
  for (const entry of entries) {
    const match = /^(\d{6}) ([a-z]+) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new Error("Git returned a malformed tooling source tree entry");
    const mode = match[1]!;
    const type = match[2]!;
    const object = match[3]!;
    const declaredSize = match[4]!;
    const rawPath = match[5]!;
    const path = normalizedGitPath(rawPath);
    paths.push(path);
    if (!isToolingSourcePath(path)) continue;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`Unsupported tracked tooling source entry: ${path}`);
    }
    if (records.has(path)) {
      throw new Error(`Duplicate normalized tooling source path: ${path}`);
    }
    const blob = Bun.spawnSync([
      resolveReleaseGitExecutable(),
      "-C",
      root,
      "cat-file",
      "blob",
      object,
    ]);
    if (blob.exitCode !== 0) {
      throw new Error(`Unable to read tracked tooling source file ${path}: ${stderrText(blob)}`);
    }
    const bytes = Buffer.from(blob.stdout);
    if (declaredSize === "-" || Number(declaredSize) !== bytes.length) {
      throw new Error(`Git tooling source size is inconsistent for ${path}`);
    }
    records.set(path, {
      path,
      executable: mode === "100755",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  assertRequiredScope(paths);
  return buildToolingSourceIdentity(records, revision, true);
}

export function assertValidationOnlyDescendant(
  rootArgument: string,
  sourceRevision: string,
  descendantRevision: string,
  expectedRecordPath: string,
  expectedRecordBytes: Uint8Array,
): void {
  assertGitRevision(sourceRevision, "Tooling source revision");
  assertGitRevision(descendantRevision, "Qualified tag revision");
  const root = resolve(rootArgument);
  const recordPath = normalizedGitPath(expectedRecordPath);
  if (!isGeneratedValidationRecordPath(recordPath)) {
    throw new Error(
      "Expected validation record path must name a generated Bridge qualification record",
    );
  }
  const ancestor = Bun.spawnSync([
    resolveReleaseGitExecutable(),
    "-C",
    root,
    "merge-base",
    "--is-ancestor",
    sourceRevision,
    descendantRevision,
  ]);
  if (ancestor.exitCode !== 0) {
    throw new Error("Qualified tag revision is not a descendant of the tooling source");
  }
  const history = runGitText(root, [
    "rev-list",
    "--reverse",
    "--ancestry-path",
    "--parents",
    `${sourceRevision}..${descendantRevision}`,
  ]).split("\n").filter(Boolean);
  if (history.length === 0) {
    throw new Error("Qualified tag must include a committed validation record");
  }
  if (history.length !== 1) {
    throw new Error(
      "Qualified tag must be exactly one linear validation-record commit after the tooling source",
    );
  }

  const [commit, ...parents] = history[0]!.split(" ");
  if (
    commit !== descendantRevision ||
    parents.length !== 1 ||
    parents[0] !== sourceRevision
  ) {
    throw new Error("Qualified tag history must be a linear descendant of the tooling source");
  }

  const changed = gitPathList(root, [
    "diff",
    "--name-only",
    "-z",
    sourceRevision,
    descendantRevision,
    "--",
  ]);
  if (changed === null || changed.length !== 1 || changed[0] !== recordPath) {
    throw new Error(
      "Qualified tag commit must create only the exact verified validation record",
    );
  }

  if (gitTreeEntry(root, sourceRevision, recordPath) !== null) {
    throw new Error(
      "Qualified validation record path must not exist at the tooling source revision",
    );
  }
  const recordEntry = gitTreeEntry(root, descendantRevision, recordPath);
  if (recordEntry?.mode !== "100644" || recordEntry.type !== "blob") {
    throw new Error("Qualified validation record must be a newly added regular file");
  }
  const committedBytes = Bun.spawnSync([
    resolveReleaseGitExecutable(),
    "-C",
    root,
    "cat-file",
    "blob",
    recordEntry.object,
  ]);
  if (committedBytes.exitCode !== 0) {
    throw new Error(`Unable to read qualified validation record: ${stderrText(committedBytes)}`);
  }
  if (!Buffer.from(committedBytes.stdout).equals(Buffer.from(expectedRecordBytes))) {
    throw new Error("Qualified validation record bytes differ from the verified record");
  }
}

export function assertToolingSourceIdentity(
  value: unknown,
): asserts value is ToolingSourceIdentity {
  if (
    !isRecord(value) ||
    value.formatVersion !== TOOLING_SOURCE_IDENTITY_FORMAT_VERSION ||
    value.scope !== TOOLING_SOURCE_SCOPE ||
    (value.gitRevision !== null && !isGitRevision(value.gitRevision)) ||
    typeof value.worktreeClean !== "boolean" ||
    !isSha256(value.treeSha256) ||
    !Number.isSafeInteger(value.files) ||
    (value.files as number) < 1 ||
    !Number.isSafeInteger(value.fileBytes) ||
    (value.fileBytes as number) < 1 ||
    (value.worktreeClean === true && value.gitRevision === null)
  ) {
    throw new Error("Tooling source identity is malformed");
  }
}

export function toolingSourceTreeEqual(
  left: ToolingSourceIdentity,
  right: ToolingSourceIdentity,
): boolean {
  return (
    left.formatVersion === right.formatVersion &&
    left.scope === right.scope &&
    left.treeSha256 === right.treeSha256 &&
    left.files === right.files &&
    left.fileBytes === right.fileBytes
  );
}

export function isToolingSourcePath(path: string): boolean {
  const normalized = path.split(sep).join("/").replace(/^\.\//u, "");
  if (TOOLING_SOURCE_FILES.includes(normalized as (typeof TOOLING_SOURCE_FILES)[number])) {
    return true;
  }
  if (normalized === "docs/validation/README.md") return true;
  if (normalized.startsWith("docs/validation/")) return false;
  return TOOLING_SOURCE_DIRECTORIES.some(
    (directory) => normalized === directory || normalized.startsWith(`${directory}/`),
  );
}

export function assertGitRevision(value: string, label: string): void {
  if (!isGitRevision(value)) throw new Error(`${label} must be a full lowercase Git commit`);
}

export function isGeneratedValidationRecordPath(path: string): boolean {
  const match =
    /^docs\/validation\/blackglass-bridge-([0-9A-Za-z.-]+)-obsidian-([0-9A-Za-z.-]+)-qualification\.json$/u.exec(
      normalizedGitPath(path),
    );
  return Boolean(
    match?.[1] &&
      match[2] &&
      isSupportedSemver(match[1]) &&
      isSupportedStableSemver(match[2]),
  );
}

function buildToolingSourceIdentity(
  records: Map<string, ToolingFileRecord>,
  gitRevision: string | null,
  worktreeClean: boolean,
): ToolingSourceIdentity {
  const ordered = [...records.values()].sort((left, right) =>
    compareCodeUnitStrings(left.path, right.path),
  );
  if (ordered.length === 0) throw new Error("Tooling source scope is empty");
  const digest = createHash("sha256");
  for (const record of ordered) {
    digest.update(JSON.stringify(record));
    digest.update("\n");
  }
  return {
    formatVersion: TOOLING_SOURCE_IDENTITY_FORMAT_VERSION,
    scope: TOOLING_SOURCE_SCOPE,
    gitRevision,
    worktreeClean,
    treeSha256: digest.digest("hex"),
    files: ordered.length,
    fileBytes: ordered.reduce((total, record) => total + record.bytes, 0),
  };
}

async function addToolingFile(
  root: string,
  path: string,
  records: Map<string, ToolingFileRecord>,
): Promise<void> {
  const file = await lstat(path);
  const relativePath = normalizedRelative(root, path);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error(`Tooling source file must be a real file: ${relativePath}`);
  }
  if (!isToolingSourcePath(relativePath)) {
    throw new Error(`File is outside the tooling source scope: ${relativePath}`);
  }
  if (records.has(relativePath)) {
    throw new Error(`Duplicate normalized tooling source path: ${relativePath}`);
  }
  const bytes = await readFile(path);
  records.set(relativePath, {
    path: relativePath,
    executable: (file.mode & 0o111) !== 0,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function normalizedRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/").normalize("NFC");
  if (!value || value === ".." || value.startsWith("../") || value.startsWith("/")) {
    throw new Error(`Unsafe tooling source path: ${path}`);
  }
  return value;
}

function normalizedGitPath(path: string): string {
  const value = path.split("\\").join("/").normalize("NFC");
  if (
    !value ||
    value !== path ||
    value === ".." ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("\0")
  ) {
    throw new Error(`Unsafe tooling source Git path: ${JSON.stringify(path)}`);
  }
  return value;
}

function gitIdentity(root: string): { revision: string | null; clean: boolean } {
  const revisionResult = Bun.spawnSync([
    resolveReleaseGitExecutable(),
    "-C",
    root,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (revisionResult.exitCode !== 0) return { revision: null, clean: false };
  const revision = revisionResult.stdout.toString().trim();
  if (!isGitRevision(revision)) return { revision: null, clean: false };

  const changed = gitPathList(root, ["diff", "--name-only", "-z", "HEAD", "--"]);
  const untracked = gitPathList(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ]);
  if (changed === null || untracked === null) return { revision, clean: false };
  return {
    revision,
    clean: [...changed, ...untracked].every((path) => !isToolingSourcePath(path)),
  };
}

function gitTrackedPaths(root: string): string[] | null {
  const result = Bun.spawnSync([
    resolveReleaseGitExecutable(),
    "-C",
    root,
    "ls-files",
    "-z",
    "--",
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().split("\0").filter(Boolean);
}

function assertRequiredScope(paths: string[]): void {
  for (const file of TOOLING_SOURCE_FILES) {
    if (!paths.includes(file)) {
      throw new Error(`Required tooling source file is not tracked: ${file}`);
    }
  }
  for (const directory of TOOLING_SOURCE_DIRECTORIES) {
    if (!paths.some((path) => path.startsWith(`${directory}/`) && isToolingSourcePath(path))) {
      throw new Error(`Required tooling source directory is empty or untracked: ${directory}`);
    }
  }
}

function gitPathList(root: string, arguments_: string[]): string[] | null {
  const result = Bun.spawnSync([
    resolveReleaseGitExecutable(),
    "-C",
    root,
    ...arguments_,
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().split("\0").filter(Boolean);
}

function gitTreeEntry(
  root: string,
  revision: string,
  path: string,
): GitTreeEntry | null {
  const result = Bun.spawnSync([
    resolveReleaseGitExecutable(),
    "-C",
    root,
    "ls-tree",
    "-z",
    "--full-tree",
    revision,
    "--",
    path,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to inspect validation record history: ${stderrText(result)}`);
  }
  const entries = Buffer.from(result.stdout).toString("utf8").split("\0").filter(Boolean);
  if (entries.length === 0) return null;
  if (entries.length !== 1) {
    throw new Error("Git returned multiple entries for the validation record path");
  }
  const match = /^(\d{6}) ([a-z]+) ([a-f0-9]+)\t([\s\S]+)$/u.exec(entries[0]!);
  if (!match) throw new Error("Git returned a malformed validation record tree entry");
  const entry = {
    mode: match[1]!,
    type: match[2]!,
    object: match[3]!,
    path: normalizedGitPath(match[4]!),
  };
  if (entry.path !== path) {
    throw new Error("Git returned the wrong validation record tree entry");
  }
  return entry;
}

function runGitText(root: string, arguments_: string[]): string {
  const result = Bun.spawnSync([
    resolveReleaseGitExecutable(),
    "-C",
    root,
    ...arguments_,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Git command failed: ${stderrText(result)}`);
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

function stderrText(result: { stderr: Uint8Array }): string {
  return Buffer.from(result.stderr).toString("utf8").trim() || "unknown Git error";
}

function isGitRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
