import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageFreshClientLayout } from "../tools/fresh-client-layout";

describe("clean-client lifecycle layout", () => {
  test("creates only a fresh profile, exact adapter, and empty vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-fresh-client-"));
    try {
      const adapter = Buffer.from("exact prepared adapter");
      const finalVaultPath = join(root, "client-b", "vault");
      await stageFreshClientLayout({
        stagingRoot: root,
        finalVaultPath,
        adapterFileName: "obsidian-1.13.4.asar",
        adapter,
        timestamp: 1234,
      });
      expect(await readdir(join(root, "vault"))).toEqual([]);
      expect(await readFile(join(root, "user-data", "obsidian-1.13.4.asar"))).toEqual(adapter);
      const settings = JSON.parse(await readFile(join(root, "user-data", "obsidian.json"), "utf8"));
      expect(settings.updateDisabled).toBe(true);
      expect(Object.values(settings.vaults)).toEqual([
        { path: finalVaultPath, ts: 1234, open: true },
      ]);
      expect((await stat(join(root, "vault"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "user-data", "obsidian.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
