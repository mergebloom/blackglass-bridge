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

  test("allows only linear validation-record commits after qualification", async () => {
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

      await commitValidationRecord(root, "0.1.1", "first\n");
      await commitValidationRecord(root, "0.1.2", "second\n");
      const qualifiedRevision = git(root, "rev-parse", "HEAD");
      const qualified = computeToolingSourceIdentityAtRevision(root, qualifiedRevision);
      expect(toolingSourceTreeEqual(source, qualified)).toBe(true);
      expect(() =>
        assertValidationOnlyDescendant(root, sourceRevision, qualifiedRevision),
      ).not.toThrow();

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
        assertValidationOnlyDescendant(root, sourceRevision, changedRevision),
      ).toThrow(/only generated Bridge validation records/u);
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
): Promise<void> {
  const relative =
    `docs/validation/blackglass-bridge-${bridgeVersion}-` +
    "obsidian-1.12.7-qualification.json";
  await writeFile(join(root, relative), contents);
  git(root, "add", relative);
  git(root, "commit", "--quiet", "-m", `record ${bridgeVersion}`);
}

function git(root: string, ...arguments_: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...arguments_]);
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8"));
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}
