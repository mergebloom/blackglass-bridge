import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertNonOverlappingPaths,
  canonicalExistingPath,
  canonicalOutputPath,
} from "../tools/path-safety";
import { computeTreeIdentity } from "../tools/tree-identity";

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
});
