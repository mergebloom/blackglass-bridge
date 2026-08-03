import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { BlackglassReleaseManifest } from "../tools/release-manifest";
import { assertBlackglassReleaseManifest } from "../tools/release-manifest";
import type { MacOSArtifact } from "../tools/macos-artifact";
import type { MacOSPackagingToolchain } from "../tools/packaging-toolchain";
import { canonicalRecoveryCorpusIdentity } from "../tools/recovery-corpus";
import {
  RELEASE_VALIDATION_RECORD_SCHEMA_VERSION,
  assertReleaseValidationRecord,
  buildReleaseValidationRecord,
  releaseValidationRecordFileName,
  type ReleaseQualification,
} from "../tools/release-validation";
import { serializeMacOSPackageReceipt, type MacOSPackageReceipt } from "../tools/macos-package-receipt";
import { stableJson } from "../tools/stable-json";
import type { MacOSReproducibilityEvidence } from "../tools/verify-macos-reproducibility";

const digest = (character: string): string => character.repeat(64);
const tree = (character: string) => ({
  formatVersion: 1 as const,
  sha256: digest(character),
  entries: 2,
  files: 1,
  directories: 1,
  symlinks: 0,
  fileBytes: 42,
});
const launcherEntries = [
  { path: ".", kind: "bundle" as const, architectures: [] as string[] },
  { path: "Contents/MacOS/blackglass-bridge", kind: "mach-o" as const, architectures: ["arm64"] },
];
const launcherInventory = {
  formatVersion: 1 as const,
  sha256: sha256(stableJson(launcherEntries)),
  entries: launcherEntries,
};
const sourceEntries = [
  { path: ".", kind: "bundle" as const, architectures: [] as string[] },
  { path: "Contents/MacOS/Obsidian", kind: "mach-o" as const, architectures: ["arm64", "x86_64"] },
];
const sourceInventory = {
  formatVersion: 1 as const,
  sha256: sha256(stableJson(sourceEntries)),
  entries: sourceEntries,
};
const rootMetadataCore = {
  formatVersion: 2 as const,
  mode: 493 as const,
  bsdFlags: 0 as const,
  ownerUidMatchesProcess: true as const,
  quarantineAbsent: true as const,
  entriesChecked: 2,
  entriesSha256: digest("a"),
  allEntriesOwnedByProcess: true as const,
  allEntriesBsdFlagsZero: true as const,
  allEntriesAclFree: true as const,
  unsupportedXattrsAbsent: true as const,
  xattrs: [],
  descendantXattrs: { allowedNames: ["com.apple.provenance"] as ["com.apple.provenance"], entries: 0, sha256: digest("b") },
};
const rootMetadata = { ...rootMetadataCore, sha256: sha256(stableJson(rootMetadataCore)) };
const toolingSource = {
  formatVersion: 2 as const,
  scope: "release-critical-v1" as const,
  gitRevision: "f".repeat(40),
  worktreeClean: true,
  treeSha256: digest("0"),
  files: 42,
  fileBytes: 4200,
};
const packagingToolchain: MacOSPackagingToolchain = {
  formatVersion: 4,
  platform: "darwin",
  architecture: "arm64",
  bunVersion: "1.3.8",
  executionMode: "standalone",
  operatingSystem: { productVersion: "26.5.2", buildVersion: "25F84" },
  developerTools: { xcodeVersion: "26.6", xcodeBuildVersion: "17F113", gitVersion: "2.50.1 (Apple Git-155)" },
  tools: [
    "PlistBuddy", "blackglass-bridge", "codesign", "ditto", "git", "lipo", "ls", "plutil", "stat", "sw_vers", "xattr", "xcodebuild", "xcrun",
  ].sort().map((name) => ({ name: name as any, sha256: digest("e") })),
  runtimeDependencies: [],
};

const macOS: Omit<MacOSArtifact, "appPath"> = {
  schemaVersion: 9,
  appBundleName: "Blackglass Bridge.app",
  bundleIdentifier: "com.blackglass.bridge",
  bundleName: "Blackglass Bridge",
  displayName: "Blackglass Bridge",
  blackglassVersion: "0.3.0",
  rendererVersion: "1.12.7",
  version: "1.12.7",
  executableName: "blackglass-bridge",
  infoPlistSha256: digest("1"),
  executableSha256: digest("2"),
  cliExecutableName: "blackglass-cli",
  cliExecutableSha256: digest("2"),
  cliSocketName: ".blackglass-c.sock",
  embeddedAsarSha256: digest("3"),
  launchConfigSha256: digest("4"),
  officialAppTreeSha256: digest("a"),
  officialCodeInventorySha256: sourceInventory.sha256,
  officialExecutableName: "Obsidian",
  officialExecutableSha256: digest("5"),
  codeDirectoryHash: "6".repeat(40),
  applicationTreeSha256: digest("7"),
  applicationTreeIdentity: tree("7"),
  codeSigning: {
    signature: "ad-hoc",
    strictVerification: true,
    allArchitecturesVerified: true,
    bundleIdentifier: "com.blackglass.bridge",
    executableIdentifier: "com.blackglass.bridge",
    executableArchitectures: ["arm64"],
  },
  codeInventory: launcherInventory,
  rootMetadata,
  profileDirectory: "Blackglass Profile",
  profileMode: 448,
  canonicalProfileRequired: true,
  explicitUserDataDir: true,
  explicitUserDataDirRequired: true,
  nativeHomePreserved: true,
  nativeHomeFallbackPreserved: true,
  blackglassHomeEnvironment: "BLACKGLASS_HOME",
  profileHomeEnvironment: "BLACKGLASS_HOME",
  dedicatedRuntimeHomeRequired: true,
  updateDisableSettingRequired: true,
  exactOfficialAppVerifiedAtEveryLaunch: true,
  officialAppUnmodified: true,
  officialChildSupervisionRequired: true,
  registeredUrlSchemes: [],
  upstreamICloudContainerRegistered: false,
};

function manifest(): BlackglassReleaseManifest {
  return {
    schemaVersion: 10,
    blackglassVersion: "0.3.0",
    rendererVersion: "1.12.7",
    compatibilityBaseline: { id: "obsidian-macos-1.12.7", schemaVersion: 6, sha256: digest("8") },
    source: {
      officialDmgSha256: digest("9"),
      appTree: tree("a"),
      rendererAsarSha256: digest("b"),
      wrapperAsarSha256: digest("c"),
      cliExecutableSha256: digest("d"),
      macOSCodeInventory: sourceInventory,
      unchanged: true,
    },
    patcher: { renderer: { formatVersion: 10, incisions: 6 } },
    endpoints: { controlOrigin: "https://blackglass.example.com", dataHost: "blackglass-data.example.com" },
    packagingToolchain,
    toolingSource,
    renderer: {
      patchFormatVersion: 10,
      incisionCount: 6,
      controlOrigin: "https://blackglass.example.com",
      dataHost: "blackglass-data.example.com",
      cliSocketName: ".blackglass-c.sock",
      cliCommandName: "blackglass",
      cliCommandPath: "/usr/local/bin/blackglass",
      cliExecutableEnvironment: "BGCLI",
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
    macOS,
    launchPolicy: {
      profileDirectory: "Blackglass Profile", profileMode: 448, explicitUserDataDir: true,
      nativeHomePreserved: true, blackglassHomeEnvironment: "BLACKGLASS_HOME",
      updatesDisabledBeforeLaunch: true, exactOfficialAppVerifiedAtEveryLaunch: true,
      exclusiveOfficialInstance: true, officialChildSupervisionRequired: true,
    },
    distribution: {
      officialApplicationRedistributed: false, officialWrapperRedistributed: false,
      officialCliRedistributed: false, proprietaryAssetsRedistributed: false,
      adaptedRendererGeneratedLocally: true,
    },
    reproduction: {
      officialDmgMatchedBaseline: true, sourceAppTreeMatchedBaseline: true,
      sourceCodeInventoryMatchedBaseline: true, sourceWrapperMatchesBaseline: true,
      sourceCliMatchesBaseline: true, rendererByteIdentical: true,
      launcherContainsOnlyBridgeCodeAndLocalAdapter: true, officialAppUnmodified: true,
    },
  };
}

function qualification(): ReleaseQualification {
  const receipt = (id: string): MacOSPackageReceipt => ({
    schemaVersion: 2,
    generatedBy: "tools/package-macos.ts",
    invocationId: id,
    startedAt: "2026-07-28T11:00:00.000Z",
    completedAt: "2026-07-28T11:01:00.000Z",
    blackglassVersion: "0.3.0",
    rendererVersion: "1.12.7",
    releaseManifestSha256: digest("a"),
    macOSArtifactSha256: sha256(stableJson(macOS)),
    applicationTreeSha256: macOS.applicationTreeSha256,
    codeInventorySha256: macOS.codeInventory.sha256,
    rootMetadataSha256: macOS.rootMetadata.sha256,
    packagingToolchainSha256: sha256(stableJson(packagingToolchain)),
    toolingSourceSha256: sha256(stableJson(toolingSource)),
  });
  const receipts = [receipt("11111111-1111-4111-8111-111111111111"), receipt("22222222-2222-4222-8222-222222222222")] as const;
  const reproducibility: MacOSReproducibilityEvidence = {
    schemaVersion: 4,
    generatedBy: "tools/verify-macos-reproducibility.ts",
    passed: true,
    separateOutputs: true,
    independentPackageInvocations: true,
    blackglassVersion: "0.3.0",
    rendererVersion: "1.12.7",
    releaseManifestSha256: digest("a"),
    macOSArtifactSha256: sha256(stableJson(macOS)),
    applicationTreeSha256: macOS.applicationTreeSha256,
    codeInventorySha256: macOS.codeInventory.sha256,
    rootMetadataSha256: macOS.rootMetadata.sha256,
    packagingToolchainSha256: sha256(stableJson(packagingToolchain)),
    toolingSourceSha256: sha256(stableJson(toolingSource)),
    packageReceipts: receipts.map((receipt) => ({ sha256: sha256(serializeMacOSPackageReceipt(receipt)), receipt })) as any,
  };
  return {
    schemaVersion: 10,
    scenarioId: "E2E-RELEASE-SYNC-RECOVERY",
    qualifiedAt: "2026-07-28T12:00:00.000Z",
    passed: true,
    platform: "macOS Apple Silicon",
    blackglassVersion: "0.3.0",
    rendererVersion: "1.12.7",
    validationFileName: `blackglass-release-sync-recovery-obsidian-1.12.7-bridge-0.3.0-${toolingSource.gitRevision}-server-${"c".repeat(40)}.json`,
    endpoints: manifest().endpoints,
    toolingSource,
    artifacts: {
      client: macOS,
      compatibilityAsarSha256: digest("3"),
      releaseManifestSha256: digest("a"),
      server: { schemaVersion: 2, name: "blackglass-server", version: "0.5.0", sourceRevision: "c".repeat(40), binaryName: "blackglass-server", sha256: digest("b"), bytes: 1_000_000, architecture: "arm64" },
    },
    workflow: {
      generatedBackgroundTransfers: 3, bidirectionalSync: true, propagatedDeletion: true,
      gracefulServerRestart: true, postRestartSync: true, sourceClientRemoved: true,
      coldRecovery: true, finderLaunchServicesSmoke: true, defaultProfileIsolation: true,
      starterNoVaultFlow: true, starterControlRouting: true, noLaunchCrashOrEarlyExit: true,
    },
    recovery: { expectedFiles: 15, restoredFiles: 15, corpus: canonicalRecoveryCorpusIdentity(), missing: 0, unexpected: 0, changed: 0 },
    evidence: {
      runManifestSha256: digest("1"), syncReportSha256: digest("2"), recoveryManifestSha256: digest("3"),
      recoveryReportSha256: digest("4"), sourceLossResetSha256: digest("5"), recoveryLaunchSha256: digest("6"),
      recoveryUiStateSha256: digest("7"), recoveryScreenshotSha256: digest("8"), finderLaunchSmokeSha256: digest("f"),
      clientReproducibilitySha256: digest("0"), clientReproducibility: reproducibility,
      networkEvidenceSha256: { "client-a": digest("9"), "client-b": digest("a"), "client-b-recovery": digest("b") },
      networkFinalizeSha256: { "client-a": digest("c"), "client-b": digest("d"), "client-b-recovery": digest("e") },
    },
  };
}

test("validates launcher-bound manifests and qualification records", () => {
  expect(() => assertBlackglassReleaseManifest(manifest())).not.toThrow();
  const record = buildReleaseValidationRecord({ manifest: manifest(), qualification: qualification(), qualificationSha256: digest("f") });
  expect(record.schemaVersion).toBe(RELEASE_VALIDATION_RECORD_SCHEMA_VERSION);
  expect(() => assertReleaseValidationRecord(record)).not.toThrow();
});

test("fails closed on distribution, runtime, and source binding changes", () => {
  for (const mutate of [
    (value: any) => value.distribution.officialApplicationRedistributed = true,
    (value: any) => value.launchPolicy.exactOfficialAppVerifiedAtEveryLaunch = false,
    (value: any) => value.macOS.officialChildSupervisionRequired = false,
    (value: any) => value.macOS.officialAppTreeSha256 = digest("0"),
    (value: any) => value.renderer.cliExecutableEnvironment = "PATH",
    (value: any) => value.source.unchanged = false,
  ]) {
    const candidate = structuredClone(manifest()) as any;
    mutate(candidate);
    expect(() => assertBlackglassReleaseManifest(candidate)).toThrow();
  }
});

test("rejects incomplete E2E evidence and unsafe version names", () => {
  const pending = structuredClone(qualification()) as any;
  pending.workflow.coldRecovery = false;
  expect(() => buildReleaseValidationRecord({ manifest: manifest(), qualification: pending, qualificationSha256: digest("f") })).toThrow();
  expect(() => releaseValidationRecordFileName("next", "1.12.7")).toThrow();
  expect(releaseValidationRecordFileName("0.3.0", "1.12.7")).toBe("blackglass-0.3.0-obsidian-1.12.7-qualification.json");
});

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
