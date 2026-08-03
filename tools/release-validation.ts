import { createHash } from "node:crypto";
import {
  canonicalAdapterOptions,
  RENDERER_INCISION_COUNT,
  RENDERER_PATCH_FORMAT_VERSION,
  type AdapterOptions,
} from "../packages/client-adapter/src/patch";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import {
  BLACKGLASS_CLI_SOCKET_NAME,
} from "./cli-binary";
import {
  assertMacOSCodeInventory,
} from "./macos-code-inventory";
import { assertMacOSRootMetadata } from "./macos-root-metadata";
import type { MacOSArtifact } from "./macos-artifact";
import type { BlackglassReleaseManifest } from "./release-manifest";
import type { ServerArtifact } from "./server-artifact";
import { COMPATIBILITY_BASELINE_SCHEMA_VERSION } from "./release-compatibility";
import {
  assertMacOSPackagingToolchain,
  type MacOSPackagingToolchain,
} from "./packaging-toolchain";
import {
  assertCanonicalRecoveryCorpusIdentity,
  type RecoveryCorpusIdentity,
} from "./recovery-corpus";
import {
  assertToolingSourceIdentity,
  type ToolingSourceIdentity,
} from "./tooling-source";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";
import { stableJson } from "./stable-json";
import { scenarioValidationFileName } from "./e2e-scenario";
import {
  assertMacOSReproducibilityEvidenceBindsRelease,
  type MacOSReproducibilityEvidence,
} from "./verify-macos-reproducibility";

export const RELEASE_VALIDATION_RECORD_SCHEMA_VERSION = 14;

type PublicMacOSArtifact = Omit<MacOSArtifact, "appPath">;
type PublicServerArtifact = Omit<ServerArtifact, "binaryPath">;

export interface ReleaseQualification {
  schemaVersion: 11;
  scenarioId: "E2E-RELEASE-SYNC-RECOVERY";
  qualifiedAt: string;
  passed: true;
  platform: "macOS Apple Silicon";
  blackglassVersion: string;
  rendererVersion: string;
  validationFileName: string;
  endpoints: AdapterOptions;
  toolingSource: ToolingSourceIdentity;
  artifacts: {
    client: PublicMacOSArtifact;
    compatibilityAsarSha256: string;
    releaseManifestSha256: string;
    server: PublicServerArtifact;
  };
  workflow: {
    generatedBackgroundTransfers: 3;
    bidirectionalSync: true;
    propagatedDeletion: true;
    gracefulServerRestart: true;
    postRestartSync: true;
    sourceClientRemoved: true;
    coldRecovery: true;
    finderLaunchServicesSmoke: true;
    defaultProfileIsolation: true;
    starterNoVaultFlow: true;
    starterControlRouting: true;
    noLaunchCrashOrEarlyExit: true;
  };
  recovery: {
    expectedFiles: number;
    restoredFiles: number;
    corpus: RecoveryCorpusIdentity;
    missing: 0;
    unexpected: 0;
    changed: 0;
  };
  evidence: {
    runManifestSha256: string;
    syncReportSha256: string;
    recoveryManifestSha256: string;
    recoveryReportSha256: string;
    sourceLossResetSha256: string;
    recoveryLaunchSha256: string;
    recoveryUiStateSha256: string;
    recoveryScreenshotSha256: string;
    recoveryUiProofSha256: string;
    finderLaunchSmokeSha256: string;
    clientReproducibilitySha256: string;
    clientReproducibility: MacOSReproducibilityEvidence;
    networkEvidenceSha256: {
      "client-a": string;
      "client-b": string;
      "client-b-recovery": string;
    };
    networkFinalizeSha256: {
      "client-a": string;
      "client-b": string;
      "client-b-recovery": string;
    };
  };
}

export interface ReleaseValidationRecord {
  schemaVersion: typeof RELEASE_VALIDATION_RECORD_SCHEMA_VERSION;
  generatedBy: "tools/write-validation-record.ts";
  validatedAt: string;
  passed: true;
  blackglassVersion: string;
  rendererVersion: string;
  compatibilityBaseline: BlackglassReleaseManifest["compatibilityBaseline"];
  source: BlackglassReleaseManifest["source"];
  endpoints: AdapterOptions;
  toolingSource: ToolingSourceIdentity;
  packagingToolchain: MacOSPackagingToolchain;
  patcher: BlackglassReleaseManifest["patcher"];
  artifacts: {
    compatibilityAsarSha256: string;
    releaseManifestSha256: string;
    macOS: PublicMacOSArtifact;
    server: PublicServerArtifact;
  };
  packagedClientE2E: {
    passed: true;
    qualificationSha256: string;
    workflow: ReleaseQualification["workflow"];
    recovery: ReleaseQualification["recovery"];
    evidence: ReleaseQualification["evidence"];
  };
}

export function releaseValidationRecordFileName(
  blackglassVersion: string,
  rendererVersion: string,
): string {
  if (
    !isSupportedSemver(blackglassVersion) ||
    !isSupportedStableSemver(rendererVersion)
  ) {
    throw new Error("Cannot name a validation record for invalid release versions");
  }
  return `blackglass-${blackglassVersion}-obsidian-${rendererVersion}-qualification.json`;
}

export function buildReleaseValidationRecord(input: {
  manifest: BlackglassReleaseManifest;
  qualification: ReleaseQualification;
  qualificationSha256: string;
}): ReleaseValidationRecord {
  const { manifest, qualification, qualificationSha256 } = input;
  assertReleaseQualification(qualification, manifest);
  const record: ReleaseValidationRecord = {
    schemaVersion: RELEASE_VALIDATION_RECORD_SCHEMA_VERSION,
    generatedBy: "tools/write-validation-record.ts",
    validatedAt: qualification.qualifiedAt,
    passed: true,
    blackglassVersion: manifest.blackglassVersion,
    rendererVersion: manifest.rendererVersion,
    compatibilityBaseline: manifest.compatibilityBaseline,
    source: manifest.source,
    endpoints: manifest.endpoints,
    toolingSource: manifest.toolingSource,
    packagingToolchain: manifest.packagingToolchain,
    patcher: manifest.patcher,
    artifacts: {
      compatibilityAsarSha256: manifest.renderer.patchedSha256,
      releaseManifestSha256: qualification.artifacts.releaseManifestSha256,
      macOS: manifest.macOS,
      server: qualification.artifacts.server,
    },
    packagedClientE2E: {
      passed: true,
      qualificationSha256,
      workflow: qualification.workflow,
      recovery: qualification.recovery,
      evidence: qualification.evidence,
    },
  };
  assertReleaseValidationRecord(record);
  return record;
}

export function assertReleaseQualification(
  value: unknown,
  manifest: BlackglassReleaseManifest,
): asserts value is ReleaseQualification {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 11 ||
    value.scenarioId !== "E2E-RELEASE-SYNC-RECOVERY" ||
    value.passed !== true ||
    value.platform !== "macOS Apple Silicon" ||
    value.blackglassVersion !== manifest.blackglassVersion ||
    value.rendererVersion !== manifest.rendererVersion ||
    value.validationFileName !== scenarioValidationFileName(
      "E2E-RELEASE-SYNC-RECOVERY",
      manifest.rendererVersion,
      manifest.blackglassVersion,
      manifest.toolingSource.gitRevision!,
      (value.artifacts as Record<string, any> | undefined)?.server?.sourceRevision,
    ) ||
    manifest.reproduction.officialDmgMatchedBaseline !== true ||
    !isIsoDate(value.qualifiedAt) ||
    !same(value.endpoints, manifest.endpoints) ||
    !isRecord(value.artifacts) ||
    !same(value.artifacts.client, manifest.macOS) ||
    value.artifacts.compatibilityAsarSha256 !== manifest.renderer.patchedSha256 ||
    !isSha256(value.artifacts.releaseManifestSha256) ||
    !isPublicServerArtifact(value.artifacts.server)
  ) {
    throw new Error("Qualification does not bind the exact release artifacts");
  }
  assertToolingSourceIdentity(value.toolingSource);
  if (
    value.toolingSource.worktreeClean !== true ||
    !same(value.toolingSource, manifest.toolingSource)
  ) {
    throw new Error("Qualification does not bind the clean release tooling source");
  }
  if (!isPassedWorkflow(value.workflow)) {
    throw new Error("Qualification does not contain the required passed workflow");
  }
  if (!isPassedRecovery(value.recovery)) {
    throw new Error("Qualification does not contain complete cold recovery");
  }
  assertEvidence(value.evidence);
  assertMacOSReproducibilityEvidenceBindsRelease(
    value.evidence.clientReproducibility,
    {
      blackglassVersion: manifest.blackglassVersion,
      rendererVersion: manifest.rendererVersion,
      releaseManifestSha256: value.artifacts.releaseManifestSha256,
      artifact: value.artifacts.client,
      packagingToolchainSha256: sha256(stableJson(manifest.packagingToolchain)),
      toolingSourceSha256: sha256(stableJson(manifest.toolingSource)),
    },
  );
}

export function assertReleaseValidationRecord(
  value: unknown,
): asserts value is ReleaseValidationRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== RELEASE_VALIDATION_RECORD_SCHEMA_VERSION ||
    value.generatedBy !== "tools/write-validation-record.ts" ||
    value.passed !== true ||
    !isIsoDate(value.validatedAt) ||
    !isSupportedSemver(value.blackglassVersion) ||
    !isSupportedStableSemver(value.rendererVersion) ||
    !isRecord(value.compatibilityBaseline) ||
    value.compatibilityBaseline.schemaVersion !== COMPATIBILITY_BASELINE_SCHEMA_VERSION ||
    typeof value.compatibilityBaseline.id !== "string" ||
    !isSha256(value.compatibilityBaseline.sha256) ||
    !isRecord(value.source) ||
    !isSha256(value.source.officialDmgSha256) ||
    !isTreeIdentity(value.source.appTree) ||
    !isSha256(value.source.rendererAsarSha256) ||
    !isSha256(value.source.wrapperAsarSha256) ||
    !isSha256(value.source.cliExecutableSha256) ||
    !isRecord(value.endpoints) ||
    typeof value.endpoints.controlOrigin !== "string" ||
    typeof value.endpoints.dataHost !== "string" ||
    !isRecord(value.toolingSource) ||
    !isRecord(value.packagingToolchain) ||
    !isRecord(value.patcher) ||
    !isRecord(value.artifacts) ||
    !isSha256(value.artifacts.compatibilityAsarSha256) ||
    !isSha256(value.artifacts.releaseManifestSha256) ||
    !isRecord(value.artifacts.macOS) ||
    !isPublicServerArtifact(value.artifacts.server) ||
    !isRecord(value.packagedClientE2E) ||
    value.packagedClientE2E.passed !== true ||
    !isSha256(value.packagedClientE2E.qualificationSha256)
  ) {
    throw new Error("Invalid release validation record");
  }
  assertToolingSourceIdentity(value.toolingSource);
  assertMacOSPackagingToolchain(value.packagingToolchain);
  assertMacOSCodeInventory(value.source.macOSCodeInventory);
  if (value.toolingSource.worktreeClean !== true) {
    throw new Error("Release validation record does not bind a clean tooling source");
  }
  let canonicalEndpoints: AdapterOptions;
  try {
    canonicalEndpoints = canonicalAdapterOptions({
      controlOrigin: value.endpoints.controlOrigin,
      dataHost: value.endpoints.dataHost,
    });
  } catch {
    throw new Error("Release validation record has invalid endpoints");
  }
  if (
    !same(canonicalEndpoints, value.endpoints) ||
    value.compatibilityBaseline.id !== `obsidian-macos-${value.rendererVersion}` ||
    !isRecord(value.patcher.renderer) ||
    value.patcher.renderer.formatVersion !== RENDERER_PATCH_FORMAT_VERSION ||
    value.patcher.renderer.incisions !== RENDERER_INCISION_COUNT
  ) {
    throw new Error("Release validation record has inconsistent compatibility metadata");
  }
  if (!isPassedWorkflow(value.packagedClientE2E.workflow)) {
    throw new Error("Release validation record lacks the required passed workflow");
  }
  if (!isPassedRecovery(value.packagedClientE2E.recovery)) {
    throw new Error("Release validation record lacks complete cold recovery");
  }
  assertEvidence(value.packagedClientE2E.evidence);
  const macOS = value.artifacts.macOS;
  assertMacOSCodeInventory(macOS.codeInventory);
  assertMacOSRootMetadata(macOS.rootMetadata);
  if (
    macOS.schemaVersion !== 9 ||
    macOS.appBundleName !== "Blackglass Bridge.app" ||
    macOS.bundleIdentifier !== "com.blackglass.bridge" ||
    macOS.bundleName !== "Blackglass Bridge" ||
    macOS.displayName !== "Blackglass Bridge" ||
    macOS.executableName !== "blackglass-bridge" ||
    macOS.cliExecutableName !== "blackglass-cli" ||
    macOS.cliSocketName !== BLACKGLASS_CLI_SOCKET_NAME ||
    macOS.version !== value.rendererVersion ||
    macOS.blackglassVersion !== value.blackglassVersion ||
    macOS.rendererVersion !== value.rendererVersion ||
    macOS.officialExecutableName !== "Obsidian" ||
    macOS.profileDirectory !== "Blackglass Profile" ||
    macOS.profileMode !== 448 ||
    macOS.canonicalProfileRequired !== true ||
    macOS.explicitUserDataDirRequired !== true ||
    macOS.profileHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    macOS.dedicatedRuntimeHomeRequired !== true ||
    macOS.nativeHomeFallbackPreserved !== true ||
    macOS.updateDisableSettingRequired !== true ||
    macOS.exactOfficialAppVerifiedAtEveryLaunch !== true ||
    macOS.officialAppUnmodified !== true ||
    macOS.officialChildSupervisionRequired !== true ||
    !Array.isArray(macOS.registeredUrlSchemes) ||
    macOS.registeredUrlSchemes.length !== 0 ||
    macOS.upstreamICloudContainerRegistered !== false ||
    !isSha256(macOS.infoPlistSha256) ||
    !isSha256(macOS.executableSha256) ||
    !isSha256(macOS.cliExecutableSha256) ||
    !isSha256(macOS.embeddedAsarSha256) ||
    !isSha256(macOS.launchConfigSha256) ||
    !isSha256(macOS.officialAppTreeSha256) ||
    !isSha256(macOS.officialCodeInventorySha256) ||
    !isSha256(macOS.officialExecutableSha256) ||
    typeof macOS.codeDirectoryHash !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(macOS.codeDirectoryHash) ||
    !isSha256(macOS.applicationTreeSha256) ||
    !isTreeIdentity(macOS.applicationTreeIdentity) ||
    macOS.applicationTreeSha256 !== macOS.applicationTreeIdentity.sha256 ||
    macOS.officialAppTreeSha256 !== value.source.appTree.sha256 ||
    macOS.officialCodeInventorySha256 !== value.source.macOSCodeInventory.sha256 ||
    macOS.embeddedAsarSha256 !== value.artifacts.compatibilityAsarSha256
  ) {
    throw new Error("Release validation record has an inconsistent macOS artifact");
  }
  assertMacOSReproducibilityEvidenceBindsRelease(
    value.packagedClientE2E.evidence.clientReproducibility,
    {
      blackglassVersion: value.blackglassVersion,
      rendererVersion: value.rendererVersion,
      releaseManifestSha256: value.artifacts.releaseManifestSha256,
      artifact: macOS as PublicMacOSArtifact,
      packagingToolchainSha256: sha256(stableJson(value.packagingToolchain)),
      toolingSourceSha256: sha256(stableJson(value.toolingSource)),
    },
  );
  if (
    value.source.rendererAsarSha256 === value.artifacts.compatibilityAsarSha256
  ) {
    throw new Error("Release validation record does not prove the renderer incision");
  }
}

function assertEvidence(
  value: unknown,
): asserts value is ReleaseQualification["evidence"] {
  if (
    !isRecord(value) ||
    !isSha256(value.runManifestSha256) ||
    !isSha256(value.syncReportSha256) ||
    !isSha256(value.recoveryManifestSha256) ||
    !isSha256(value.recoveryReportSha256) ||
    !isSha256(value.sourceLossResetSha256) ||
    !isSha256(value.recoveryLaunchSha256) ||
    !isSha256(value.recoveryUiStateSha256) ||
    !isSha256(value.recoveryScreenshotSha256) ||
    !isSha256(value.recoveryUiProofSha256) ||
    !isSha256(value.finderLaunchSmokeSha256) ||
    !isSha256(value.clientReproducibilitySha256) ||
    !isRecord(value.clientReproducibility) ||
    !isRecord(value.networkEvidenceSha256) ||
    !isSha256(value.networkEvidenceSha256["client-a"]) ||
    !isSha256(value.networkEvidenceSha256["client-b"]) ||
    !isSha256(value.networkEvidenceSha256["client-b-recovery"]) ||
    Object.keys(value.networkEvidenceSha256).sort().join(",") !==
      "client-a,client-b,client-b-recovery" ||
    !isRecord(value.networkFinalizeSha256) ||
    !isSha256(value.networkFinalizeSha256["client-a"]) ||
    !isSha256(value.networkFinalizeSha256["client-b"]) ||
    !isSha256(value.networkFinalizeSha256["client-b-recovery"]) ||
    Object.keys(value.networkFinalizeSha256).sort().join(",") !==
      "client-a,client-b,client-b-recovery"
  ) {
    throw new Error("Release validation evidence hashes are incomplete");
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPassedWorkflow(value: unknown): value is ReleaseQualification["workflow"] {
  return Boolean(
    isRecord(value) &&
      value.generatedBackgroundTransfers === 3 &&
      value.bidirectionalSync === true &&
      value.propagatedDeletion === true &&
      value.gracefulServerRestart === true &&
      value.postRestartSync === true &&
      value.sourceClientRemoved === true &&
      value.coldRecovery === true &&
      value.finderLaunchServicesSmoke === true &&
      value.defaultProfileIsolation === true &&
      value.starterNoVaultFlow === true &&
      value.starterControlRouting === true &&
      value.noLaunchCrashOrEarlyExit === true,
  );
}

function isPassedRecovery(value: unknown): value is ReleaseQualification["recovery"] {
  if (!isRecord(value)) return false;
  try {
    assertCanonicalRecoveryCorpusIdentity(value.corpus);
  } catch {
    return false;
  }
  return Boolean(
    Number.isSafeInteger(value.expectedFiles) &&
      (value.expectedFiles as number) >= value.corpus.files &&
      value.restoredFiles === value.expectedFiles &&
      value.missing === 0 &&
      value.unexpected === 0 &&
      value.changed === 0,
  );
}

function isPublicServerArtifact(value: unknown): value is PublicServerArtifact {
  return Boolean(
    isRecord(value) &&
      value.schemaVersion === 2 &&
      value.name === "blackglass-server" &&
      value.binaryName === "blackglass-server" &&
      isSupportedSemver(value.version) &&
      typeof value.sourceRevision === "string" &&
      /^[a-f0-9]{40}$/u.test(value.sourceRevision) &&
      isSha256(value.sha256) &&
      Number.isSafeInteger(value.bytes) &&
      (value.bytes as number) > 0 &&
      typeof value.architecture === "string" &&
      ["arm64", "x86_64", "universal"].includes(value.architecture as string) &&
      !("binaryPath" in value),
  );
}

function isTreeIdentity(value: unknown): boolean {
  return Boolean(
    isRecord(value) &&
      value.formatVersion === 1 &&
      isSha256(value.sha256) &&
      Number.isSafeInteger(value.entries) &&
      Number.isSafeInteger(value.files) &&
      Number.isSafeInteger(value.directories) &&
      Number.isSafeInteger(value.symlinks) &&
      Number.isSafeInteger(value.fileBytes) &&
      (value.entries as number) >= 0 &&
      (value.files as number) >= 0 &&
      (value.directories as number) >= 0 &&
      (value.symlinks as number) >= 0 &&
      (value.fileBytes as number) >= 0 &&
      (value.entries as number) ===
        (value.files as number) +
          (value.directories as number) +
          (value.symlinks as number),
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
