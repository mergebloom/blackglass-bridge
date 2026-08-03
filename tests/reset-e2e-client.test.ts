import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { deriveE2ENetworkPlan } from "../tools/e2e-network";
import {
  acquirePreparedClientLease,
  preparedClientLeasePath,
  releasePreparedClientLease,
  sourceLossResetLockPath,
} from "../tools/e2e-run-lock";
import { pathExists } from "../tools/path-safety";

const e2eRoot = resolve(import.meta.dir, "../.data/e2e");
const resetTool = resolve(import.meta.dir, "../tools/reset-e2e-client.ts");

describe("Phase 4 clean-client reset", () => {
  test("replaces only stopped client B while live A/C evidence leases remain", async () => {
    await mkdir(e2eRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(e2eRoot, "reset-client-test-"));
    const adapter = Buffer.from("reviewed-adapter");
    const adapterSha256 = sha256(adapter);
    const endpoints = {
      controlOrigin: "https://sync.example.test",
      dataHost: "sync-data.example.test",
    };
    const manifest = {
      schemaVersion: 5,
      scenarioId: "E2E-P4-CUSTOM-E2EE",
      endpoints,
      network: deriveE2ENetworkPlan(endpoints),
      compatibilityAsarSha256: adapterSha256,
      releaseManifestSha256: "a".repeat(64),
      adapterFileName: "adapter.bin",
      releaseManifestFileName: "release.json",
      reproducibilityEvidenceFileName: "reproducibility.json",
      reproducibilityEvidenceSha256: "b".repeat(64),
    } as const;
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSha256 = sha256(manifestBytes);
    let clientA: string | undefined;
    let clientC: string | undefined;
    try {
      await writeFile(join(root, "run-manifest.json"), manifestBytes, { mode: 0o600 });
      for (const client of ["client-a", "client-b", "client-c"] as const) {
        await mkdir(join(root, client, "user-data"), { recursive: true, mode: 0o700 });
        await mkdir(join(root, client, "vault"), { recursive: true, mode: 0o700 });
        await writeFile(join(root, client, "user-data", "adapter.bin"), adapter, { mode: 0o600 });
      }
      await writeFile(join(root, "client-a", "vault", "a.md"), "A stays\n");
      await writeFile(join(root, "client-c", "vault", "c.md"), "C stays\n");
      await writeFile(join(root, "client-b", "vault", "retired.md"), "remove me\n");
      await writeFile(
        join(root, "client-b-launch.json"),
        `${JSON.stringify(clientLaunchIdentity(root, manifestSha256, adapterSha256))}\n`,
        { mode: 0o600 },
      );

      clientA = await acquirePreparedClientLease(root, "client-a");
      clientC = await acquirePreparedClientLease(root, "client-c");
      const child = Bun.spawn([process.execPath, "run", resetTool, root, "client-b"], {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout).client).toBe("client-b");

      expect(await readFile(join(root, "client-a", "vault", "a.md"), "utf8")).toBe("A stays\n");
      expect(await readFile(join(root, "client-c", "vault", "c.md"), "utf8")).toBe("C stays\n");
      expect(await pathExists(preparedClientLeasePath(root, "client-a"))).toBe(true);
      expect(await pathExists(preparedClientLeasePath(root, "client-c"))).toBe(true);
      expect(await pathExists(join(root, "client-b", "vault", "retired.md"))).toBe(false);
      expect(await readFile(join(root, "client-b", "user-data", "adapter.bin"))).toEqual(adapter);
      expect(await pathExists(join(root, "client-b-clean-reset.json"))).toBe(true);
      expect(await pathExists(sourceLossResetLockPath(root))).toBe(false);
    } finally {
      if (clientA && await pathExists(clientA)) await releasePreparedClientLease(clientA);
      if (clientC && await pathExists(clientC)) await releasePreparedClientLease(clientC);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function clientLaunchIdentity(root: string, runManifestSha256: string, adapterSha256: string) {
  const blackglassHomePath = "/private/tmp/blackglass-client-ABC123/h";
  return {
    schemaVersion: 5,
    runManifestSha256,
    releaseManifestSha256: "a".repeat(64),
    startedAt: new Date().toISOString(),
    pid: 2_147_483_647,
    launchCommand: "test launch",
    launcherPid: 2_147_483_646,
    launcherCommand: "test launcher",
    launcherExecutablePath: "/test/launcher",
    launcherExecutableSha256: "c".repeat(64),
    officialChildOfLauncher: true,
    runtimeReceiptPath: join(root, "client-b-runtime.json"),
    runtimeReceiptSha256: "d".repeat(64),
    debugPort: 9322,
    debugListenerPid: 2_147_483_645,
    debugListenerCommand: "test listener",
    debugTargetId: "target",
    debugTargetUrl: "file:///test/index.html",
    executablePath: "/test/Obsidian",
    executableSha256: "e".repeat(64),
    officialAppPath: "/test/Obsidian.app",
    appBundlePath: "/test/Blackglass Bridge.app",
    appArtifactSha256: "f".repeat(64),
    appArtifact: {},
    adapterPath: join(root, "client-b", "user-data", "adapter.bin"),
    adapterSha256,
    profilePath: join(root, "client-b", "user-data"),
    blackglassHomePath,
    blackglassHomeEnvironment: "BLACKGLASS_HOME",
    blackglassHomeMode: 0o700,
    blackglassHomeCanonical: true,
    cliSocketPath: join(blackglassHomePath, ".blackglass-c.sock"),
    nativeHomePath: "/Users/test",
    nativeHomeEnvironmentPreserved: true,
    vaultPath: join(root, "client-b", "vault"),
    tlsMetadataPath: join(root, "tls-metadata.json"),
    tlsMetadataSha256: "1".repeat(64),
    tlsSpkiSha256Base64: `${"A".repeat(43)}=`,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
