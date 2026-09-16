import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

test("materializes bundled release assets from a compiled standalone executable", async () => {
  const projectRoot = resolve(import.meta.dir, "..");
  const temporary = await mkdtemp(join(tmpdir(), "blackglass-embedded-asset-"));
  const entry = join(temporary, "entry.ts");
  const executable = join(temporary, "asset-reader");
  const output = join(temporary, "blackglass-prism.icns");
  const helper = join(projectRoot, "tools/embedded-asset.ts");
  const asset = join(projectRoot, "assets/blackglass-prism.icns");
  try {
    await writeFile(entry, [
      `import icon from ${JSON.stringify(asset)} with { type: "file" };`,
      `import { embeddedAssetBytes } from ${JSON.stringify(helper)};`,
      "await Bun.write(Bun.argv[2]!, await embeddedAssetBytes(icon));",
      "",
    ].join("\n"));
    const build = Bun.spawnSync([
      "bun", "build", "--compile", "--target=bun-darwin-arm64", entry, "--outfile", executable,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const materialize = Bun.spawnSync([executable, output], { stdout: "pipe", stderr: "pipe" });
    expect(materialize.exitCode, materialize.stderr.toString()).toBe(0);
    expect(sha256(await readFile(output))).toBe(sha256(await readFile(asset)));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
