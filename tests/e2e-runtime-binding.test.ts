import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertPreparedClientAdapterPath,
  assertClientLaunchIdentity,
  resolvePreparedClientLayout,
} from "../tools/e2e-client";
import { deriveE2ENetworkPlan } from "../tools/e2e-network";
import { readVerifiedE2ETls } from "../tools/e2e-tls";

const projectRoot = resolve(import.meta.dir, "..");

describe("E2E runtime binding", () => {
  test("rejects malformed launch chronology", () => {
    const identity = {
      schemaVersion: 4,
      runManifestSha256: "a".repeat(64),
      releaseManifestSha256: "b".repeat(64),
      startedAt: "2026-07-28T12:00:00.000Z",
      pid: 100,
      launchCommand: "/Applications/Blackglass Bridge.app/Contents/MacOS/Obsidian",
      debugPort: 9321,
      debugListenerPid: 100,
      debugListenerCommand: "/Applications/Blackglass Bridge.app/Contents/MacOS/Obsidian",
      debugTargetId: "renderer",
      debugTargetUrl: "file:///app/index.html",
      executablePath: "/Applications/Blackglass Bridge.app/Contents/MacOS/Obsidian",
      executableSha256: "c".repeat(64),
      appBundlePath: "/Applications/Blackglass Bridge.app",
      appArtifactSha256: "d".repeat(64),
      appArtifact: { schemaVersion: 2 },
      adapterPath: "/tmp/obsidian-1.12.7.asar",
      adapterSha256: "e".repeat(64),
      profilePath: "/tmp/client-a/user-data",
      blackglassHomePath: "/private/tmp/blackglass-client-ABC123/h",
      blackglassHomeEnvironment: "BLACKGLASS_HOME",
      blackglassHomeMode: 0o700,
      blackglassHomeCanonical: true,
      cliSocketPath: "/private/tmp/blackglass-client-ABC123/h/.blackglass-b.sock",
      nativeHomePath: "/Users/example",
      nativeHomeEnvironmentPreserved: true,
      vaultPath: "/tmp/client-a/vault",
      tlsMetadataPath: "/tmp/tls-metadata.json",
      tlsMetadataSha256: "f".repeat(64),
      tlsSpkiSha256Base64: `${"A".repeat(43)}=`,
    };
    expect(() => assertClientLaunchIdentity(identity)).not.toThrow();
    expect(() => assertClientLaunchIdentity({
      ...identity,
      blackglassHomePath: "",
    })).toThrow("blackglassHomePath is invalid");
    for (const mutate of [
      (value: any) => (value.blackglassHomeEnvironment = "HOME"),
      (value: any) => (value.blackglassHomeMode = 0o755),
      (value: any) => (value.blackglassHomeCanonical = false),
      (value: any) => (value.cliSocketPath = "/tmp/.obsidian-cli.sock"),
      (value: any) => (value.nativeHomePath = value.blackglassHomePath),
      (value: any) => (value.nativeHomeEnvironmentPreserved = false),
    ]) {
      const candidate = structuredClone(identity);
      mutate(candidate);
      expect(() => assertClientLaunchIdentity(candidate)).toThrow(
        "process or artifact binding",
      );
    }
    expect(() => assertClientLaunchIdentity({
      ...identity,
      startedAt: "not-a-date",
    })).toThrow("process or artifact binding");
  });

  test("binds client layout and generated TLS files to one prepared run", async () => {
    const e2eRoot = resolve(projectRoot, ".data/e2e");
    await mkdir(e2eRoot, { recursive: true });
    const runRoot = await mkdtemp(join(e2eRoot, "runtime-binding-"));
    try {
      const endpoints = {
        controlOrigin: "https://blackglass.example.com",
        dataHost: "blackglass-data.example.com",
      };
      await writeFile(
        join(runRoot, "run-manifest.json"),
        `${JSON.stringify({
          schemaVersion: 3,
          endpoints,
          network: deriveE2ENetworkPlan(endpoints),
          compatibilityAsarSha256: "a".repeat(64),
          releaseManifestSha256: "b".repeat(64),
          adapterFileName: "obsidian-1.12.7.asar",
          releaseManifestFileName: "bridge-release-manifest.json",
          reproducibilityEvidenceFileName: "client-reproducibility.json",
          reproducibilityEvidenceSha256: "c".repeat(64),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      for (const client of ["client-a", "client-b"]) {
        await mkdir(join(runRoot, client, "user-data"), { recursive: true });
        await mkdir(join(runRoot, client, "vault"), { recursive: true });
      }
      const layout = await resolvePreparedClientLayout(
        join(runRoot, "client-a/user-data"),
        join(runRoot, "client-a/vault"),
      );
      expect(layout.clientName).toBe("client-a");
      expect(layout.clientRoot).toBe(join(runRoot, "client-a"));
      const adapterPath = join(runRoot, "client-a/user-data/obsidian-1.12.7.asar");
      expect(
        assertPreparedClientAdapterPath(
          join(runRoot, "client-a/user-data"),
          adapterPath,
          "obsidian-1.12.7.asar",
        ),
      ).toBe(adapterPath);
      for (const wrongAdapter of [
        join(runRoot, "obsidian-1.12.7.asar"),
        join(runRoot, "client-b/user-data/obsidian-1.12.7.asar"),
        join(runRoot, "client-a/user-data/obsidian-1.12.8.asar"),
      ]) {
        expect(() =>
          assertPreparedClientAdapterPath(
            join(runRoot, "client-a/user-data"),
            wrongAdapter,
            "obsidian-1.12.7.asar",
          ),
        ).toThrow("exact adapter inside its client profile");
      }
      await expect(
        resolvePreparedClientLayout(
          join(runRoot, "client-a/user-data"),
          join(runRoot, "client-b/vault"),
        ),
      ).rejects.toThrow("same client");

      const result = Bun.spawnSync([
        "bun",
        "run",
        "tools/prepare-e2e-tls.ts",
        runRoot,
      ], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const tls = await readVerifiedE2ETls(runRoot);
      expect(tls.metadata.hosts).toEqual([
        "blackglass-data.example.com",
        "blackglass.example.com",
      ]);
      expect(tls.metadata.runManifestSha256).toBe(tls.run.manifestSha256);

      const malformed = { schemaVersion: 1, pid: 1, debugPort: 9222 };
      expect(() => assertClientLaunchIdentity(malformed)).toThrow();
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
