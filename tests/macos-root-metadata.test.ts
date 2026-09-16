import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  DETACHED_CODE_SIGNATURE_XATTRS,
  inspectMacOSRootMetadata,
} from "../tools/macos-root-metadata";

test("permits only detached signature caches in an explicitly reviewed subtree", async () => {
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
    const metadata = await inspectMacOSRootMetadata(app, {
      detachedSignatureCacheSubtrees: [official],
    });
    expect(metadata.unsupportedXattrsAbsent).toBe(true);
    const unsupported = Bun.spawnSync(["/usr/bin/xattr", "-w", "com.example.unreviewed", "fixture", resource]);
    expect(unsupported.exitCode, unsupported.stderr.toString()).toBe(0);
    await expect(inspectMacOSRootMetadata(app, {
      detachedSignatureCacheSubtrees: [official],
    })).rejects.toThrow("unsupported extended attribute");
    await expect(inspectMacOSRootMetadata(app, {
      detachedSignatureCacheSubtrees: [temporary],
    })).rejects.toThrow("escapes the app");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
