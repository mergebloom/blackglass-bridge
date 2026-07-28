import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPackageStaging } from "../tools/package-staging";

describe("macOS package staging", () => {
  test("removes the exact staging tree after a post-copy failure", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "blackglass-package-test-"));
    const outputApp = join(outputDirectory, "Blackglass Bridge.app");
    const sentinel = join(outputDirectory, "keep.txt");
    await writeFile(sentinel, "keep\n");
    let stagingRoot = "";
    try {
      await expect(
        withPackageStaging(outputApp, async (root) => {
          stagingRoot = root;
          await writeFile(join(root, "copied-proprietary-byte"), "sensitive\n");
          throw new Error("injected post-copy failure");
        }),
      ).rejects.toThrow("injected post-copy failure");
      expect(stagingRoot).not.toBe("");
      expect(await readdir(outputDirectory)).toEqual(["keep.txt"]);
      expect(await readFile(sentinel, "utf8")).toBe("keep\n");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("also removes an otherwise empty successful staging directory", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "blackglass-package-test-"));
    try {
      const result = await withPackageStaging(
        join(outputDirectory, "Blackglass Bridge.app"),
        async (root) => {
          await writeFile(join(root, "temporary"), "temporary\n");
          return "published";
        },
      );
      expect(result).toBe("published");
      expect(await readdir(outputDirectory)).toEqual([]);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
