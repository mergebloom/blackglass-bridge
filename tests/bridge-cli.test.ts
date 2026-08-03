import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("builds a self-contained Apple Silicon command with source attestation", async () => {
  const root = resolve(import.meta.dir, "..");
  const output = await mkdtemp(join(tmpdir(), "blackglass-bridge-cli-"));
  const executable = join(output, "blackglass-bridge");
  try {
    const build = Bun.spawnSync([
      "bun", "build", "--compile", "--target=bun-darwin-arm64",
      "tools/bridge-cli.ts", "--outfile", executable,
      "--define", '__BLACKGLASS_BRIDGE_VERSION__="9.8.7"',
      "--define", `__BLACKGLASS_BRIDGE_REVISION__="${"a".repeat(40)}"`,
      "--define", '__BLACKGLASS_TOOLING_SOURCE_JSON__="{}"',
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const version = Bun.spawnSync([executable, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(version.exitCode, version.stderr.toString()).toBe(0);
    expect(version.stdout.toString().trim()).toBe(
      `blackglass-bridge 9.8.7 (${"a".repeat(40)})`,
    );
    const identity = Bun.spawnSync(["file", executable]);
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.toString()).toContain("Mach-O 64-bit executable arm64");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 30_000);
