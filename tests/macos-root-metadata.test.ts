import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  clearDetachedCodeSignatureAttributes,
  DETACHED_CODE_SIGNATURE_XATTRS,
  inspectMacOSRootMetadata,
} from "../tools/macos-root-metadata";

test("removes only detached signature caches from an embedded official app", async () => {
  if (process.platform !== "darwin") return;
  const temporary = await mkdtemp(join(tmpdir(), "blackglass-root-metadata-"));
  const app = join(temporary, "Blackglass.app");
  const official = join(app, "Contents/Frameworks/Obsidian.app");
  const resource = join(official, "Contents/Resources/locale.pak");
  try {
    await mkdir(join(official, "Contents/Resources"), { recursive: true });
    await writeFile(resource, "signed resource");
    for (const name of DETACHED_CODE_SIGNATURE_XATTRS) {
      const result = Bun.spawnSync(["/usr/bin/xattr", "-w", name, "fixture", resource]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    await expect(inspectMacOSRootMetadata(app)).rejects.toThrow("unsupported extended attribute");
    await clearDetachedCodeSignatureAttributes(official);
    const metadata = await inspectMacOSRootMetadata(app);
    expect(metadata.unsupportedXattrsAbsent).toBe(true);
    const remaining = Bun.spawnSync(["/usr/bin/xattr", resource]);
    expect(remaining.exitCode, remaining.stderr.toString()).toBe(0);
    expect(remaining.stdout.toString().trim().split("\n")).toEqual([
      "com.apple.provenance",
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
