import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertNonOverlappingPaths,
  canonicalExistingPath,
  canonicalOutputPath,
  pathExists,
} from "../tools/path-safety";
import { computeTreeIdentity } from "../tools/tree-identity";
import { removeProfileSingletonArtifacts } from "../tools/profile-singletons";

describe("filesystem safety", () => {
  test("computes a deterministic content, mode, and symlink tree identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-tree-"));
    await mkdir(join(root, "A"));
    await writeFile(join(root, "A/file.txt"), "first");
    await symlink("A/file.txt", join(root, "link"));

    const first = await computeTreeIdentity(root);
    const second = await computeTreeIdentity(root);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ files: 1, directories: 1, symlinks: 1 });

    await writeFile(join(root, "A/file.txt"), "second");
    expect((await computeTreeIdentity(root)).sha256).not.toBe(first.sha256);
  });

  test("rejects a tree symlink that escapes its root", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-tree-escape-"));
    await symlink("../outside", join(root, "escape"));
    await expect(computeTreeIdentity(root)).rejects.toThrow();
  });

  test("removes only Chromium profile singleton symlinks after shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-profile-singletons-"));
    try {
      await symlink("stale-cookie", join(root, "SingletonCookie"));
      await symlink("host-123", join(root, "SingletonLock"));
      await symlink("/tmp/stale-socket", join(root, "SingletonSocket"));
      await symlink("keep-me", join(root, "unrelated"));

      await removeProfileSingletonArtifacts(root);

      expect(await pathExists(join(root, "SingletonCookie"))).toBe(false);
      expect(await pathExists(join(root, "SingletonLock"))).toBe(false);
      expect(await pathExists(join(root, "SingletonSocket"))).toBe(false);
      expect(await pathExists(join(root, "unrelated"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to remove a non-symlink profile singleton artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-profile-singleton-file-"));
    try {
      await writeFile(join(root, "SingletonLock"), "unexpected");
      await expect(removeProfileSingletonArtifacts(root)).rejects.toThrow(
        "Refusing to remove a non-symlink profile singleton artifact",
      );
      expect(await pathExists(join(root, "SingletonLock"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("canonicalizes safe inputs and rejects overlapping outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-path-"));
    const source = join(root, "source");
    await mkdir(source);
    const canonicalSource = await canonicalExistingPath(source, "source", "directory");
    const output = await canonicalOutputPath(join(root, "output.app"), "output");
    expect(canonicalSource).toEndWith("/source");
    expect(output).toEndWith("/output.app");
    expect(() =>
      assertNonOverlappingPaths([
        { label: "source", path: canonicalSource },
        { label: "nested output", path: join(canonicalSource, "output.app") },
      ]),
    ).toThrow("must not overlap");
  });

  test("detects directories and special filesystem nodes, not only regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-path-exists-"));
    const specialPath = join(root, "runtime.pipe");
    try {
      expect(await pathExists(root)).toBe(true);
      expect(await pathExists(join(root, "missing"))).toBe(false);
      const created = Bun.spawnSync(["mkfifo", specialPath]);
      expect(created.exitCode).toBe(0);
      expect(await pathExists(specialPath)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
