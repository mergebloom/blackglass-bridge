import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBlackglassReleaseManifest,
  type BlackglassReleaseManifest,
} from "../tools/release-manifest";
import { canonicalOutputPath } from "../tools/path-safety";
import { APPROVED_MACOS_ENTITLEMENTS } from "../tools/macos-code-signing";
import { canonicalRecoveryCorpusIdentity } from "../tools/recovery-corpus";
import {
  RELEASE_VALIDATION_RECORD_SCHEMA_VERSION,
  assertReleaseValidationRecord,
  buildReleaseValidationRecord,
  releaseValidationRecordFileName,
  type ReleaseQualification,
} from "../tools/release-validation";
import { stableJson } from "../tools/stable-json";
import type { MacOSPackagingToolchain } from "../tools/packaging-toolchain";
import {
  serializeMacOSPackageReceipt,
  type MacOSPackageReceipt,
} from "../tools/macos-package-receipt";
import type { MacOSReproducibilityEvidence } from "../tools/verify-macos-reproducibility";

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
  formatVersion: 2 as const,
  scope: "release-critical-v1" as const,
  gitRevision: "f".repeat(40),
  worktreeClean: true,
  treeSha256: digest("0"),
  files: 42,
  fileBytes: 4_200,
};
const codeInventoryEntries = [
  { path: ".", kind: "bundle" as const, architectures: [] as string[] },
  {
    path: "Contents/MacOS/Obsidian",
    kind: "mach-o" as const,
    architectures: ["arm64", "x86_64"],
  },
];
const codeInventory = {
  formatVersion: 1 as const,
  sha256: createHash("sha256").update(stableJson(codeInventoryEntries)).digest("hex"),
  entries: codeInventoryEntries,
};
const rootMetadataIdentity = {
  formatVersion: 2 as const,
  mode: 493 as const,
  bsdFlags: 0 as const,
  ownerUidMatchesProcess: true as const,
  quarantineAbsent: true as const,
  entriesChecked: 1,
  entriesSha256: createHash("sha256")
    .update(stableJson([{ path: ".", type: "directory" }]))
    .digest("hex"),
  allEntriesOwnedByProcess: true as const,
  allEntriesBsdFlagsZero: true as const,
  allEntriesAclFree: true as const,
  unsupportedXattrsAbsent: true as const,
  xattrs: [],
  descendantXattrs: {
    allowedNames: ["com.apple.provenance"] as ["com.apple.provenance"],
    entries: 0,
    sha256: createHash("sha256").update(stableJson([])).digest("hex"),
  },
};
const rootMetadata = {
  ...rootMetadataIdentity,
  sha256: createHash("sha256").update(stableJson(rootMetadataIdentity)).digest("hex"),
};
const packagingToolchain: MacOSPackagingToolchain = {
  formatVersion: 3 as const,
  platform: "darwin" as const,
  architecture: "arm64" as const,
  bunVersion: "1.3.8" as const,
  operatingSystem: { productVersion: "26.5.2", buildVersion: "25F84" },
  developerTools: {
    xcodeVersion: "26.6",
    xcodeBuildVersion: "17F113",
    gitVersion: "2.50.1 (Apple Git-155)",
  },
  tools: [
    { name: "PlistBuddy", sha256: digest("e") },
    { name: "bun", sha256: digest("e") },
    { name: "codesign", sha256: digest("e") },
    { name: "ditto", sha256: digest("e") },
    { name: "git", sha256: digest("e") },
    { name: "lipo", sha256: digest("e") },
    { name: "ls", sha256: digest("e") },
    { name: "plutil", sha256: digest("e") },
    { name: "stat", sha256: digest("e") },
    { name: "sw_vers", sha256: digest("e") },
    { name: "xattr", sha256: digest("e") },
    { name: "xcodebuild", sha256: digest("e") },
    { name: "xcrun", sha256: digest("e") },
  ],
  runtimeDependencies: [
    {
      name: "playwright-core",
      version: "1.62.0",
      lockIntegrity: `sha512-${"A".repeat(86)}==`,
      entry: "index.mjs",
      entrySha256: digest("e"),
      tree: tree("e"),
    },
    {
      name: "typescript",
      version: "5.9.3",
      lockIntegrity: `sha512-${"B".repeat(86)}==`,
      entry: "lib/typescript.js",
      entrySha256: digest("f"),
      tree: tree("f"),
    },
  ],
};

const macOS = {
  schemaVersion: 8 as const,
  appBundleName: "Blackglass.app" as const,
  bundleIdentifier: "com.blackglass.app" as const,
  bundleName: "Obsidian" as const,
  displayName: "Blackglass" as const,
  version: "1.12.7",
  executableName: "Obsidian" as const,
  infoPlistSha256: digest("1"),
  executableSha256: digest("2"),
  cliExecutableName: "obsidian-cli" as const,
  // macOS codesigning changes the whole-file identity after the raw CLI patch.
  cliExecutableSha256: digest("a"),
  cliSocketName: ".blackglass-c.sock" as const,
  cliSocketOccurrences: 2 as const,
  embeddedAsarSha256: digest("3"),
  rendererRuntimeHomeEnvironment: "BLACKGLASS_HOME" as const,
  rendererCliRuntimeRootValidated: true as const,
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
  codeSigning: {
    formatVersion: 2 as const,
    signature: "ad-hoc" as const,
    allReviewedTargetsHardenedRuntime: true as const,
    allInventoryTargetsStrictlyVerified: true as const,
    allArchitecturesStrictlyVerified: true as const,
    strictInventoryTargets: 2,
    strictMachOTargets: 1,
    inventorySigningSha256: digest("d"),
    approvedEntitlements: [...APPROVED_MACOS_ENTITLEMENTS],
    targets: [
      {
        role: "application" as const,
        identifier: "com.blackglass.app",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "cli" as const,
        identifier: "obsidian-cli",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "helper" as const,
        identifier: "md.obsidian.helper",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "helper" as const,
        identifier: "md.obsidian.helper.GPU",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "helper" as const,
        identifier: "md.obsidian.helper.Plugin",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "helper" as const,
        identifier: "md.obsidian.helper.Renderer",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "auxiliary" as const,
        identifier: "ShipIt",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "auxiliary" as const,
        identifier: "chrome_crashpad_handler",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "framework" as const,
        identifier: "com.github.Electron.framework",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "none" as const,
      },
      {
        role: "framework" as const,
        identifier: "org.mantle.Mantle",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "none" as const,
      },
      {
        role: "framework" as const,
        identifier: "com.electron.reactive",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "none" as const,
      },
      {
        role: "framework" as const,
        identifier: "com.github.Squirrel",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "none" as const,
      },
    ],
  },
  codeInventory,
  rootMetadata,
  profileDirectory: "Blackglass" as const,
  profileMode: 448 as const,
  profilePathCanonicalAtSetup: true as const,
  explicitUserDataDirHonored: true as const,
  profileHomeEnvironment: "BLACKGLASS_HOME" as const,
  dedicatedHomeValidated: true as const,
  nativeHomeFallbackPreserved: true as const,
  upstreamUpdatesDisabled: true as const,
  embeddedRendererOnly: true as const,
  registeredUrlSchemes: [] as [],
  upstreamICloudContainerRegistered: false as const,
};

function manifest(): BlackglassReleaseManifest {
  return {
    schemaVersion: 9,
    blackglassVersion: "0.1.1",
    rendererVersion: "1.12.7",
    compatibilityBaseline: {
      id: "obsidian-macos-1.12.7",
      schemaVersion: 5,
      sha256: digest("8"),
    },
    source: {
      officialDmgSha256: digest("9"),
      appTree: tree("a"),
      rendererAsarSha256: digest("b"),
      wrapperAsarSha256: digest("c"),
      cliExecutableSha256: digest("d"),
      macOSCodeInventory: codeInventory,
    },
    patcher: {
      renderer: { formatVersion: 7, incisions: 6 },
      wrapper: { formatVersion: 5, incisions: 3 },
      cli: { formatVersion: 2, incisions: 2 },
    },
    endpoints: {
      controlOrigin: "https://blackglass.example.com",
      dataHost: "blackglass-data.example.com",
    },
    packagingToolchain,
    toolingSource,
    renderer: {
      patchFormatVersion: 7,
      incisionCount: 6,
      controlOrigin: "https://blackglass.example.com",
      dataHost: "blackglass-data.example.com",
      cliSocketName: ".blackglass-c.sock",
      cliCommandName: "blackglass",
      cliCommandPath: "/usr/local/bin/blackglass",
      runtimeHomeEnvironment: "BLACKGLASS_HOME",
      upstreamSha256: digest("b"),
      patchedSha256: digest("3"),
      rendererBeforeSha256: digest("d"),
      rendererAfterSha256: digest("e"),
      starterBeforeSha256: digest("1"),
      starterAfterSha256: digest("2"),
      mainBeforeSha256: digest("4"),
      mainAfterSha256: digest("5"),
    },
    wrapper: {
      patchFormatVersion: 5,
      incisionCount: 3,
      profileDirectory: "Blackglass",
      applicationName: "Blackglass",
      profileMode: 448,
      profilePathCanonicalAtSetup: true,
      explicitUserDataDirHonored: true,
      profileHomeEnvironment: "BLACKGLASS_HOME",
      dedicatedHomeValidated: true,
      nativeHomeFallbackPreserved: true,
      upstreamUpdatesDisabled: true,
      embeddedRendererOnly: true,
      upstreamSha256: digest("c"),
      patchedSha256: digest("4"),
      upstreamHeaderSha256: digest("d"),
      patchedHeaderSha256: digest("5"),
      mainBeforeSha256: digest("e"),
      mainAfterSha256: digest("f"),
    },
    cli: {
      patchFormatVersion: 2,
      incisionCount: 2,
      socketName: ".blackglass-c.sock",
      upstreamSha256: digest("d"),
      patchedSha256: digest("e"),
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
      packagedCliSocketVerified: true,
      reviewedCodeSigningPreserved: true,
      sourceCodeInventoryMatchedBaseline: true,
      packagedCodeInventoryMatchedSource: true,
    },
  };
}

function qualification(): ReleaseQualification {
  const receipt = (
    invocationId: string,
    startedAt: string,
    completedAt: string,
  ): MacOSPackageReceipt => ({
    schemaVersion: 2,
    generatedBy: "tools/package-macos.ts",
    invocationId,
    startedAt,
    completedAt,
    blackglassVersion: "0.1.1",
    rendererVersion: "1.12.7",
    releaseManifestSha256: digest("a"),
    macOSArtifactSha256: createHash("sha256")
      .update(stableJson(macOS))
      .digest("hex"),
    applicationTreeSha256: macOS.applicationTreeSha256,
    codeInventorySha256: macOS.codeInventory.sha256,
    rootMetadataSha256: macOS.rootMetadata.sha256,
    packagingToolchainSha256: createHash("sha256")
      .update(stableJson(packagingToolchain))
      .digest("hex"),
    toolingSourceSha256: createHash("sha256")
      .update(stableJson(toolingSource))
      .digest("hex"),
  });
  const firstReceipt = receipt(
    "11111111-1111-4111-8111-111111111111",
    "2026-07-28T11:00:00.000Z",
    "2026-07-28T11:01:00.000Z",
  );
  const secondReceipt = receipt(
    "22222222-2222-4222-8222-222222222222",
    "2026-07-28T11:02:00.000Z",
    "2026-07-28T11:03:00.000Z",
  );
  const clientReproducibility: MacOSReproducibilityEvidence = {
    schemaVersion: 4,
    generatedBy: "tools/verify-macos-reproducibility.ts",
    passed: true,
    separateOutputs: true,
    independentPackageInvocations: true,
    blackglassVersion: "0.1.1",
    rendererVersion: "1.12.7",
    releaseManifestSha256: digest("a"),
    macOSArtifactSha256: firstReceipt.macOSArtifactSha256,
    applicationTreeSha256: macOS.applicationTreeSha256,
    codeInventorySha256: macOS.codeInventory.sha256,
    rootMetadataSha256: macOS.rootMetadata.sha256,
    packagingToolchainSha256: firstReceipt.packagingToolchainSha256,
    toolingSourceSha256: firstReceipt.toolingSourceSha256,
    packageReceipts: [
      {
        sha256: createHash("sha256")
          .update(serializeMacOSPackageReceipt(firstReceipt))
          .digest("hex"),
        receipt: firstReceipt,
      },
      {
        sha256: createHash("sha256")
          .update(serializeMacOSPackageReceipt(secondReceipt))
          .digest("hex"),
        receipt: secondReceipt,
      },
    ],
  };
  return {
    schemaVersion: 9,
    qualifiedAt: "2026-07-28T12:00:00.000Z",
    passed: true,
    platform: "macOS Apple Silicon",
    blackglassVersion: "0.1.1",
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
      expectedFiles: 15,
      restoredFiles: 15,
      corpus: canonicalRecoveryCorpusIdentity(),
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
      clientReproducibilitySha256: digest("0"),
      clientReproducibility,
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
    expect(record.schemaVersion).toBe(RELEASE_VALIDATION_RECORD_SCHEMA_VERSION);
    expect(record.artifacts.server.version).toBe("0.2.2");
    expect(record.artifacts.server.sourceRevision).toBe("c".repeat(40));
    expect(record.packagingToolchain).toEqual(packagingToolchain);
    expect(record.packagedClientE2E.passed).toBe(true);
    expect(record.packagedClientE2E.recovery.corpus.multipart).toEqual({
      path: "Assets/multipart-proof.png",
      bytes: 2_163_625,
      sha256: "a5ceeffa7a9395783ee7e5b04f5155b5fcce2c4d90707b70a479b7ff51a2da84",
      pieceBytes: 2_097_152,
      minimumPieces: 2,
    });
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

    for (const mutate of [
      (value: any) => (value.renderer.runtimeHomeEnvironment = "HOME"),
      (value: any) => (value.wrapper.profileHomeEnvironment = "HOME"),
      (value: any) => (value.wrapper.dedicatedHomeValidated = false),
      (value: any) => (value.wrapper.nativeHomeFallbackPreserved = false),
      (value: any) => (value.macOS.rendererCliRuntimeRootValidated = false),
      (value: any) => (value.macOS.nativeHomeFallbackPreserved = false),
      (value: any) => value.macOS.codeSigning.approvedEntitlements.pop(),
      (value: any) =>
        (value.macOS.codeSigning.allReviewedTargetsHardenedRuntime = false),
      (value: any) => (value.macOS.codeSigning.strictInventoryTargets = 1),
      (value: any) => (value.macOS.codeSigning.strictMachOTargets = 2),
      (value: any) =>
        (value.macOS.codeSigning.targets[2].identifier = "changed.helper"),
      (value: any) =>
        (value.reproduction.reviewedCodeSigningPreserved = false),
      (value: any) =>
        (value.reproduction.packagedCodeInventoryMatchedSource = false),
      (value: any) => value.macOS.codeInventory.entries.pop(),
      (value: any) => (value.macOS.rootMetadata.mode = 0o777),
      (value: any) => (value.packagingToolchain.bunVersion = "1.3.9"),
      (value: any) =>
        (value.packagingToolchain.runtimeDependencies[0].tree.sha256 =
          "changed"),
      (value: any) => (value.macOS.appBundleName = "Renamed Blackglass.app"),
      (value: any) =>
        (value.macOS.cliExecutableSha256 = value.cli.upstreamSha256),
      (value: any) => (value.cli.patchedSha256 = value.cli.upstreamSha256),
    ]) {
      const candidate = structuredClone(manifest()) as any;
      mutate(candidate);
      expect(() => assertBlackglassReleaseManifest(candidate)).toThrow();
    }
  });

  test("keeps pre-sign and packaged CLI identities distinct", () => {
    const candidate = structuredClone(manifest());
    expect(candidate.cli.patchedSha256).not.toBe(
      candidate.macOS.cliExecutableSha256,
    );
    expect(() => assertBlackglassReleaseManifest(candidate)).not.toThrow();

    candidate.macOS.cliExecutableSha256 = candidate.cli.upstreamSha256;
    expect(() => assertBlackglassReleaseManifest(candidate)).toThrow(
      "artifact bindings",
    );
  });

  test("rejects pending workflow, incomplete recovery, and mutated evidence", () => {
    for (const mutate of [
      (value: any) => (value.workflow.coldRecovery = false),
      (value: any) => (value.recovery.restoredFiles = 13),
      (value: any) => {
        value.recovery.expectedFiles = 12;
        value.recovery.restoredFiles = 12;
      },
      (value: any) => (value.recovery.corpus.manifestSha256 = digest("0")),
      (value: any) => (value.recovery.corpus.types[".png"] = 0),
      (value: any) => (value.recovery.corpus.multipart.minimumPieces = 1),
      (value: any) => (value.evidence.syncReportSha256 = "changed"),
      (value: any) => (value.evidence.clientReproducibilitySha256 = "changed"),
      (value: any) =>
        (value.evidence.clientReproducibility.packageReceipts[1].receipt.invocationId =
          value.evidence.clientReproducibility.packageReceipts[0].receipt.invocationId),
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
      "blackglass-0.1.1-obsidian-1.12.7-qualification.json",
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
    const invalidBlackglassVersions = [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-alpha..1",
      "1.2.3-alpha.",
      "1.2.3-.alpha",
      "1.2.3-alpha.01",
      "1.2.3+build",
    ];
    for (const version of invalidBlackglassVersions) {
      const candidateManifest = structuredClone(manifest()) as any;
      candidateManifest.blackglassVersion = version;
      expect(() => assertBlackglassReleaseManifest(candidateManifest), version).toThrow();

      const candidateRecord = buildReleaseValidationRecord({
        manifest: manifest(),
        qualification: qualification(),
        qualificationSha256: digest("f"),
      }) as any;
      candidateRecord.blackglassVersion = version;
      expect(() => assertReleaseValidationRecord(candidateRecord), version).toThrow();
    }

    for (const version of ["01.12.7", "1.12.07", "1.12.7-alpha"]) {
      const candidateManifest = structuredClone(manifest()) as any;
      candidateManifest.rendererVersion = version;
      expect(() => assertBlackglassReleaseManifest(candidateManifest), version).toThrow();

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
      `/blackglass-0.1.1-obsidian-1.12.7-qualification.json`,
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
