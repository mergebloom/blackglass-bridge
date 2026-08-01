import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOOLING_SOURCE_DIRECTORIES,
  TOOLING_SOURCE_FILES,
  TOOLING_SOURCE_IDENTITY_FORMAT_VERSION,
  TOOLING_SOURCE_SCOPE,
  assertValidationOnlyDescendant,
  computeToolingSourceIdentity,
  computeToolingSourceIdentityAtRevision,
  toolingSourceTreeEqual,
} from "../tools/tooling-source";

describe("release-critical tooling source identity", () => {
  test("refuses a filesystem snapshot that is not Git-tracked", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-tooling-no-git-"));
    try {
      await expect(computeToolingSourceIdentity(root)).rejects.toThrow(
        "requires a Git worktree",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses tracked files and detects relevant worktree changes", async () => {
    const root = await createRepository();
    try {
      const clean = await computeToolingSourceIdentity(root);
      expect(clean.formatVersion).toBe(TOOLING_SOURCE_IDENTITY_FORMAT_VERSION);
      expect(clean.formatVersion).toBe(2);
      expect(clean.scope).toBe(TOOLING_SOURCE_SCOPE);
      expect(clean.scope).toBe("release-critical-v1");
      expect(clean.worktreeClean).toBe(true);
      expect(clean.gitRevision).toMatch(/^[a-f0-9]{40}$/u);

      await writeFile(join(root, "tools/ignored.tmp"), "ignored\n");
      const ignored = await computeToolingSourceIdentity(root);
      expect(ignored.worktreeClean).toBe(true);
      expect(toolingSourceTreeEqual(clean, ignored)).toBe(true);

      await writeFile(join(root, "tools/untracked.ts"), "untracked\n");
      const untracked = await computeToolingSourceIdentity(root);
      expect(untracked.worktreeClean).toBe(false);
      expect(toolingSourceTreeEqual(clean, untracked)).toBe(true);
      await unlink(join(root, "tools/untracked.ts"));

      await writeFile(join(root, "tools/source.txt"), "mutated\n");
      const mutated = await computeToolingSourceIdentity(root);
      expect(mutated.worktreeClean).toBe(false);
      expect(toolingSourceTreeEqual(clean, mutated)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows exactly one commit that creates the exact verified validation record", async () => {
    const root = await createRepository();
    try {
      const source = await computeToolingSourceIdentity(root);
      const sourceRevision = source.gitRevision!;
      expect(
        toolingSourceTreeEqual(
          source,
          computeToolingSourceIdentityAtRevision(root, sourceRevision),
        ),
      ).toBe(true);

      const record = await commitValidationRecord(root, "0.1.1", "first\n");
      const qualifiedRevision = git(root, "rev-parse", "HEAD");
      const qualified = computeToolingSourceIdentityAtRevision(root, qualifiedRevision);
      expect(toolingSourceTreeEqual(source, qualified)).toBe(true);
      expect(() =>
        assertValidationOnlyDescendant(
          root,
          sourceRevision,
          qualifiedRevision,
          record.path,
          record.bytes,
        ),
      ).not.toThrow();

      expect(() =>
        assertValidationOnlyDescendant(
          root,
          sourceRevision,
          qualifiedRevision,
          record.path,
          Buffer.from("different\n"),
        ),
      ).toThrow(/bytes differ from the verified record/u);

      await writeFile(join(root, "README.md"), "unauthorized tooling change\n");
      git(root, "add", "README.md");
      git(root, "commit", "-m", "change tooling after qualification");
      const changedRevision = git(root, "rev-parse", "HEAD");
      expect(
        toolingSourceTreeEqual(
          source,
          computeToolingSourceIdentityAtRevision(root, changedRevision),
        ),
      ).toBe(false);
      expect(() =>
        assertValidationOnlyDescendant(
          root,
          sourceRevision,
          changedRevision,
          record.path,
          record.bytes,
        ),
      ).toThrow(/exactly one linear validation-record commit/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an unrelated record added beside the current record", async () => {
    const root = await createRepository();
    try {
      const sourceRevision = git(root, "rev-parse", "HEAD");
      const currentPath = validationRecordPath("0.1.1");
      const currentBytes = Buffer.from("current\n");
      await writeFile(join(root, currentPath), currentBytes);
      await writeFile(join(root, validationRecordPath("0.1.2")), "unrelated\n");
      git(root, "add", "-A");
      git(root, "commit", "--quiet", "-m", "add unrelated validation record");

      expect(() =>
        assertValidationOnlyDescendant(
          root,
          sourceRevision,
          git(root, "rev-parse", "HEAD"),
          currentPath,
          currentBytes,
        ),
      ).toThrow(/only the exact verified validation record/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects modification of a historical record beside the current record", async () => {
    const root = await createRepository();
    try {
      const historical = await commitValidationRecord(root, "0.1.0", "historical\n");
      const sourceRevision = git(root, "rev-parse", "HEAD");
      const currentPath = validationRecordPath("0.1.1");
      const currentBytes = Buffer.from("current\n");
      await writeFile(join(root, historical.path), "modified historical\n");
      await writeFile(join(root, currentPath), currentBytes);
      git(root, "add", "-A");
      git(root, "commit", "--quiet", "-m", "modify historical record");

      expect(() =>
        assertValidationOnlyDescendant(
          root,
          sourceRevision,
          git(root, "rev-parse", "HEAD"),
          currentPath,
          currentBytes,
        ),
      ).toThrow(/only the exact verified validation record/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects deletion of a historical record beside the current record", async () => {
    const root = await createRepository();
    try {
      const historical = await commitValidationRecord(root, "0.1.0", "historical\n");
      const sourceRevision = git(root, "rev-parse", "HEAD");
      const currentPath = validationRecordPath("0.1.1");
      const currentBytes = Buffer.from("current\n");
      await unlink(join(root, historical.path));
      await writeFile(join(root, currentPath), currentBytes);
      git(root, "add", "-A");
      git(root, "commit", "--quiet", "-m", "delete historical record");

      expect(() =>
        assertValidationOnlyDescendant(
          root,
          sourceRevision,
          git(root, "rev-parse", "HEAD"),
          currentPath,
          currentBytes,
        ),
      ).toThrow(/only the exact verified validation record/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects overwriting a record path that existed at the source revision", async () => {
    const root = await createRepository();
    try {
      const existing = await commitValidationRecord(root, "0.1.1", "old\n");
      const sourceRevision = git(root, "rev-parse", "HEAD");
      const replacementBytes = Buffer.from("replacement\n");
      await writeFile(join(root, existing.path), replacementBytes);
      git(root, "add", existing.path);
      git(root, "commit", "--quiet", "-m", "replace validation record");

      expect(() =>
        assertValidationOnlyDescendant(
          root,
          sourceRevision,
          git(root, "rev-parse", "HEAD"),
          existing.path,
          replacementBytes,
        ),
      ).toThrow(/must not exist at the tooling source revision/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects more than one descendant commit", async () => {
    const root = await createRepository();
    try {
      const sourceRevision = git(root, "rev-parse", "HEAD");
      git(root, "commit", "--quiet", "--allow-empty", "-m", "empty intermediate");
      const record = await commitValidationRecord(root, "0.1.1", "current\n");

      expect(() =>
        assertValidationOnlyDescendant(
          root,
          sourceRevision,
          git(root, "rev-parse", "HEAD"),
          record.path,
          record.bytes,
        ),
      ).toThrow(/exactly one linear validation-record commit/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blackglass-tooling-source-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Blackglass Test");
  git(root, "config", "user.email", "blackglass@example.invalid");
  for (const file of TOOLING_SOURCE_FILES) {
    await mkdir(join(root, file, ".."), { recursive: true });
    const contents = file === ".gitignore" ? "tools/ignored.tmp\n" : `${file}\n`;
    await writeFile(join(root, file), contents);
  }
  for (const directory of TOOLING_SOURCE_DIRECTORIES) {
    await mkdir(join(root, directory), { recursive: true });
    const file = directory === "docs" ? "source.txt" : "source.txt";
    await writeFile(join(root, directory, file), `${directory}\n`);
  }
  await mkdir(join(root, "docs/validation"), { recursive: true });
  await writeFile(join(root, "docs/validation/README.md"), "generated evidence\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "qualified source");
  return root;
}

async function commitValidationRecord(
  root: string,
  bridgeVersion: string,
  contents: string,
): Promise<{ path: string; bytes: Buffer }> {
  const path = validationRecordPath(bridgeVersion);
  const bytes = Buffer.from(contents);
  await writeFile(join(root, path), bytes);
  git(root, "add", path);
  git(root, "commit", "--quiet", "-m", `record ${bridgeVersion}`);
  return { path, bytes };
}

function validationRecordPath(bridgeVersion: string): string {
  return (
    `docs/validation/blackglass-bridge-${bridgeVersion}-` +
    "obsidian-1.12.7-qualification.json"
  );
}

function git(root: string, ...arguments_: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...arguments_]);
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8"));
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}
