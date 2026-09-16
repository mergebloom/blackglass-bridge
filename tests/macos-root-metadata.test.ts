import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { inspectMacOSRootMetadata } from "../tools/macos-root-metadata";

test("delegates preserved signature xattrs only to an explicitly verified embedded subtree", async () => {
  if (process.platform !== "darwin") return;
  const temporary = await mkdtemp(join(tmpdir(), "blackglass-root-metadata-"));
  const app = join(temporary, "Blackglass.app");
  const official = join(app, "Contents/Resources/Obsidian.app");
  const resource = join(official, "Contents/Resources/locale.pak");
  try {
    await mkdir(join(official, "Contents/Resources"), { recursive: true });
    await writeFile(resource, "signed resource");
    const xattr = Bun.spawnSync(["/usr/bin/xattr", "-w", "com.apple.cs.CodeSignature", "fixture", resource]);
    expect(xattr.exitCode, xattr.stderr.toString()).toBe(0);
    await expect(inspectMacOSRootMetadata(app)).rejects.toThrow("unsupported extended attribute");
    const metadata = await inspectMacOSRootMetadata(app, {
      signatureValidatedSubtrees: [official],
    });
    expect(metadata.unsupportedXattrsAbsent).toBe(true);
    await expect(inspectMacOSRootMetadata(app, {
      signatureValidatedSubtrees: [temporary],
    })).rejects.toThrow("escapes the app");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
