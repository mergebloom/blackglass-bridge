import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBridgeReleaseManifest,
  type BridgeReleaseManifest,
} from "../tools/release-manifest";
import { canonicalOutputPath } from "../tools/path-safety";
import {
  assertReleaseValidationRecord,
  buildReleaseValidationRecord,
  releaseValidationRecordFileName,
  type ReleaseQualification,
} from "../tools/release-validation";

const digest = (character: string): string => character.repeat(64);
const tree = (character: string) => ({
  formatVersion: 1 as const,
  sha256: digest(character),
  entries: 3,
  files: 1,
  directories: 1,
  symlinks: 1,
  fileBytes: 42,
});
const toolingSource = {
  formatVersion: 1 as const,
  scope: "release-critical-v1" as const,
  gitRevision: "f".repeat(40),
  worktreeClean: true,
  treeSha256: digest("0"),
  files: 42,
  fileBytes: 4_200,
};

const macOS = {
  schemaVersion: 3 as const,
  bundleIdentifier: "com.blackglass.bridge" as const,
  bundleName: "Obsidian" as const,
  displayName: "Blackglass Bridge" as const,
  version: "1.12.7",
  executableName: "Obsidian" as const,
  infoPlistSha256: digest("1"),
  executableSha256: digest("2"),
  embeddedAsarSha256: digest("3"),
  embeddedWrapperAsarSha256: digest("4"),
  embeddedWrapperHeaderSha256: digest("5"),
  codeDirectoryHash: "6".repeat(40),
  applicationTreeSha256: digest("7"),
  applicationTreeIdentity: tree("7"),
  helperBundleIdentifiers: [
    "md.obsidian.helper",
    "md.obsidian.helper.GPU",
    "md.obsidian.helper.Plugin",
    "md.obsidian.helper.Renderer",
  ],
  profileDirectory: "Blackglass Bridge" as const,
  profileMode: 448 as const,
  profilePathCanonicalAtSetup: true as const,
  explicitUserDataDirHonored: true as const,
  upstreamUpdatesDisabled: true as const,
  embeddedRendererOnly: true as const,
  registeredUrlSchemes: [] as [],
  upstreamICloudContainerRegistered: false as const,
};

function manifest(): BridgeReleaseManifest {
  return {
    schemaVersion: 4,
    bridgeVersion: "0.1.1",
    rendererVersion: "1.12.7",
    compatibilityBaseline: {
      id: "obsidian-macos-1.12.7",
      schemaVersion: 4,
      sha256: digest("8"),
    },
    source: {
      officialDmgSha256: digest("9"),
      appTree: tree("a"),
      rendererAsarSha256: digest("b"),
      wrapperAsarSha256: digest("c"),
    },
    patcher: {
      renderer: { formatVersion: 3, incisions: 3 },
      wrapper: { formatVersion: 2, incisions: 3 },
    },
    endpoints: {
      controlOrigin: "https://blackglass.example.com",
      dataHost: "blackglass-data.example.com",
    },
    toolingSource,
    renderer: {
      patchFormatVersion: 3,
      incisionCount: 3,
      controlOrigin: "https://blackglass.example.com",
      dataHost: "blackglass-data.example.com",
      upstreamSha256: digest("b"),
      patchedSha256: digest("3"),
      rendererBeforeSha256: digest("d"),
      rendererAfterSha256: digest("e"),
      starterBeforeSha256: digest("1"),
      starterAfterSha256: digest("2"),
    },
    wrapper: {
      patchFormatVersion: 2,
      incisionCount: 3,
      profileDirectory: "Blackglass Bridge",
      profileMode: 448,
      profilePathCanonicalAtSetup: true,
      explicitUserDataDirHonored: true,
      upstreamUpdatesDisabled: true,
      embeddedRendererOnly: true,
      upstreamSha256: digest("c"),
      patchedSha256: digest("4"),
      upstreamHeaderSha256: digest("d"),
      patchedHeaderSha256: digest("5"),
      mainBeforeSha256: digest("e"),
      mainAfterSha256: digest("f"),
    },
    macOS,
    reproduction: {
      officialDmgMatchedBaseline: true,
      sourceAppTreeMatchedBaseline: true,
      stagedCopyTreeMatchedSource: true,
      reviewedSourceRenderer: true,
      sourceWrapperMatchesBaseline: true,
      rendererByteIdentical: true,
      packagedRendererByteIdentical: true,
      packagedWrapperIntegrityVerified: true,
    },
  };
}

function qualification(): ReleaseQualification {
  return {
    schemaVersion: 4,
    qualifiedAt: "2026-07-28T12:00:00.000Z",
    passed: true,
    platform: "macOS Apple Silicon",
    bridgeVersion: "0.1.1",
    rendererVersion: "1.12.7",
    endpoints: {
      controlOrigin: "https://blackglass.example.com",
      dataHost: "blackglass-data.example.com",
    },
    toolingSource,
    artifacts: {
      client: macOS,
      compatibilityAsarSha256: digest("3"),
      releaseManifestSha256: digest("a"),
      server: {
        schemaVersion: 2,
        name: "blackglass-server",
        version: "0.2.2",
        sourceRevision: "c".repeat(40),
        binaryName: "blackglass-server",
        sha256: digest("b"),
        bytes: 1_000_000,
        architecture: "arm64",
      },
    },
    workflow: {
      generatedBackgroundTransfers: 3,
      bidirectionalSync: true,
      propagatedDeletion: true,
      gracefulServerRestart: true,
      postRestartSync: true,
      sourceClientRemoved: true,
      coldRecovery: true,
      finderLaunchServicesSmoke: true,
      defaultProfileIsolation: true,
      starterNoVaultFlow: true,
      starterControlRouting: true,
      noLaunchCrashOrEarlyExit: true,
    },
    recovery: {
      expectedFiles: 14,
      restoredFiles: 14,
      missing: 0,
      unexpected: 0,
      changed: 0,
    },
    evidence: {
      runManifestSha256: digest("1"),
      syncReportSha256: digest("2"),
      recoveryManifestSha256: digest("3"),
      recoveryReportSha256: digest("4"),
      sourceLossResetSha256: digest("5"),
      recoveryLaunchSha256: digest("6"),
      recoveryUiStateSha256: digest("7"),
      recoveryScreenshotSha256: digest("8"),
      finderLaunchSmokeSha256: digest("f"),
      networkEvidenceSha256: {
        "client-a": digest("9"),
        "client-b": digest("a"),
        "client-b-recovery": digest("b"),
      },
      networkFinalizeSha256: {
        "client-a": digest("c"),
        "client-b": digest("d"),
        "client-b-recovery": digest("e"),
      },
    },
  };
}

describe("generated release validation records", () => {
  test("binds a passed qualification to exact release artifacts", () => {
    const record = buildReleaseValidationRecord({
      manifest: manifest(),
      qualification: qualification(),
      qualificationSha256: digest("f"),
    });
    expect(() => assertReleaseValidationRecord(record)).not.toThrow();
    expect(record.artifacts.server.version).toBe("0.2.2");
    expect(record.artifacts.server.sourceRevision).toBe("c".repeat(40));
    expect(record.packagedClientE2E.passed).toBe(true);
  });

  test("rejects wrong client and server identities", () => {
    const wrongClient = structuredClone(qualification()) as any;
    wrongClient.artifacts.client.embeddedAsarSha256 = digest("0");
    expect(() =>
      buildReleaseValidationRecord({
        manifest: manifest(),
        qualification: wrongClient,
        qualificationSha256: digest("f"),
      }),
    ).toThrow();

    const wrongServer = structuredClone(qualification()) as any;
    wrongServer.artifacts.server.binaryName = "other-server";
    expect(() =>
      buildReleaseValidationRecord({
        manifest: manifest(),
        qualification: wrongServer,
        qualificationSha256: digest("f"),
      }),
    ).toThrow();
  });

  test("rejects pending workflow, incomplete recovery, and mutated evidence", () => {
    for (const mutate of [
      (value: any) => (value.workflow.coldRecovery = false),
      (value: any) => (value.recovery.restoredFiles = 13),
      (value: any) => (value.evidence.syncReportSha256 = "changed"),
    ]) {
      const candidate = structuredClone(qualification()) as any;
      mutate(candidate);
      expect(() =>
        buildReleaseValidationRecord({
          manifest: manifest(),
          qualification: candidate,
          qualificationSha256: digest("f"),
        }),
      ).toThrow();
    }
  });

  test("rejects unsafe names and negative tree counts", () => {
    expect(() => releaseValidationRecordFileName("next", "1.12.7")).toThrow();
    expect(releaseValidationRecordFileName("0.1.1", "1.12.7")).toBe(
      "blackglass-bridge-0.1.1-obsidian-1.12.7-qualification.json",
    );

    const record = buildReleaseValidationRecord({
      manifest: manifest(),
      qualification: qualification(),
      qualificationSha256: digest("f"),
    }) as any;
    record.source.appTree = {
      ...record.source.appTree,
      entries: 0,
      files: -1,
      directories: 1,
      symlinks: 0,
    };
    expect(() => assertReleaseValidationRecord(record)).toThrow();
  });

  test("rejects noncanonical semantic versions in manifests and records", () => {
    const invalidBridgeVersions = [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-alpha..1",
      "1.2.3-alpha.",
      "1.2.3-.alpha",
      "1.2.3-alpha.01",
      "1.2.3+build",
    ];
    for (const version of invalidBridgeVersions) {
      const candidateManifest = structuredClone(manifest()) as any;
      candidateManifest.bridgeVersion = version;
      expect(() => assertBridgeReleaseManifest(candidateManifest), version).toThrow();

      const candidateRecord = buildReleaseValidationRecord({
        manifest: manifest(),
        qualification: qualification(),
        qualificationSha256: digest("f"),
      }) as any;
      candidateRecord.bridgeVersion = version;
      expect(() => assertReleaseValidationRecord(candidateRecord), version).toThrow();
    }

    for (const version of ["01.12.7", "1.12.07", "1.12.7-alpha"]) {
      const candidateManifest = structuredClone(manifest()) as any;
      candidateManifest.rendererVersion = version;
      expect(() => assertBridgeReleaseManifest(candidateManifest), version).toThrow();

      const candidateRecord = buildReleaseValidationRecord({
        manifest: manifest(),
        qualification: qualification(),
        qualificationSha256: digest("f"),
      }) as any;
      candidateRecord.rendererVersion = version;
      expect(() => assertReleaseValidationRecord(candidateRecord), version).toThrow();
    }
  });

  test("refuses overwrite and symlink output targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-validation-"));
    const output = join(
      root,
      releaseValidationRecordFileName("0.1.1", "1.12.7"),
    );
    expect(await canonicalOutputPath(output, "Validation record")).toEndWith(
      `/blackglass-bridge-0.1.1-obsidian-1.12.7-qualification.json`,
    );
    await writeFile(output, "existing");
    await expect(canonicalOutputPath(output, "Validation record")).rejects.toThrow(
      "already exists",
    );
    await unlink(output);
    await symlink(join(root, "missing-target"), output);
    await expect(canonicalOutputPath(output, "Validation record")).rejects.toThrow(
      "already exists",
    );
  });
});
