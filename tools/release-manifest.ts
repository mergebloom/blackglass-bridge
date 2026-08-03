import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT,
  canonicalAdapterOptions,
  RENDERER_INCISION_COUNT,
  RENDERER_PATCH_FORMAT_VERSION,
  type AdapterOptions,
  type AdapterReport,
} from "../packages/client-adapter/src/patch";
import { assertMacOSCodeInventory, type MacOSCodeInventory } from "./macos-code-inventory";
import type { MacOSArtifact } from "./macos-artifact";
import { assertMacOSRootMetadata } from "./macos-root-metadata";
import { assertMacOSPackagingToolchain, type MacOSPackagingToolchain } from "./packaging-toolchain";
import { COMPATIBILITY_BASELINE_SCHEMA_VERSION } from "./release-compatibility";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";
import { assertToolingSourceIdentity, type ToolingSourceIdentity } from "./tooling-source";
import { TREE_IDENTITY_FORMAT_VERSION, type TreeIdentity } from "./tree-identity";
import { BRIDGE_PROFILE_DIRECTORY } from "./launcher-config";

export const BLACKGLASS_RELEASE_MANIFEST_SCHEMA_VERSION = 10;

export interface BlackglassReleaseManifest {
  schemaVersion: typeof BLACKGLASS_RELEASE_MANIFEST_SCHEMA_VERSION;
  blackglassVersion: string;
  rendererVersion: string;
  compatibilityBaseline: { id: string; schemaVersion: number; sha256: string };
  source: {
    officialDmgSha256: string;
    appTree: TreeIdentity;
    rendererAsarSha256: string;
    wrapperAsarSha256: string;
    cliExecutableSha256: string;
    macOSCodeInventory: MacOSCodeInventory;
    unchanged: true;
  };
  patcher: {
    renderer: { formatVersion: typeof RENDERER_PATCH_FORMAT_VERSION; incisions: typeof RENDERER_INCISION_COUNT };
  };
  endpoints: AdapterOptions;
  packagingToolchain: MacOSPackagingToolchain;
  toolingSource: ToolingSourceIdentity;
  renderer: AdapterReport;
  macOS: Omit<MacOSArtifact, "appPath">;
  launchPolicy: {
    profileDirectory: typeof BRIDGE_PROFILE_DIRECTORY;
    profileMode: 448;
    explicitUserDataDir: true;
    nativeHomePreserved: true;
    blackglassHomeEnvironment: "BLACKGLASS_HOME";
    updatesDisabledBeforeLaunch: true;
    exactOfficialAppVerifiedAtEveryLaunch: true;
    exclusiveOfficialInstance: true;
    officialChildSupervisionRequired: true;
  };
  distribution: {
    officialApplicationRedistributed: false;
    officialWrapperRedistributed: false;
    officialCliRedistributed: false;
    proprietaryAssetsRedistributed: false;
    adaptedRendererGeneratedLocally: true;
  };
  reproduction: {
    officialDmgMatchedBaseline: boolean;
    sourceAppTreeMatchedBaseline: true;
    sourceCodeInventoryMatchedBaseline: true;
    sourceWrapperMatchesBaseline: true;
    sourceCliMatchesBaseline: true;
    rendererByteIdentical: true;
    launcherContainsOnlyBridgeCodeAndLocalAdapter: true;
    officialAppUnmodified: true;
  };
}

export async function readBlackglassReleaseManifest(path: string): Promise<{ path: string; manifest: BlackglassReleaseManifest }> {
  const resolved = resolve(path);
  return { path: resolved, manifest: parseBlackglassReleaseManifest(await readFile(resolved)) };
}

export function parseBlackglassReleaseManifest(bytes: Uint8Array): BlackglassReleaseManifest {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  assertBlackglassReleaseManifest(value);
  return value;
}

export function assertBlackglassReleaseManifest(value: unknown): asserts value is BlackglassReleaseManifest {
  if (!isRecord(value) || value.schemaVersion !== BLACKGLASS_RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Unsupported Blackglass release manifest schema");
  }
  if (
    typeof value.blackglassVersion !== "string" || !isSupportedSemver(value.blackglassVersion) ||
    typeof value.rendererVersion !== "string" || !isSupportedStableSemver(value.rendererVersion)
  ) throw new Error("Blackglass release manifest has invalid versions");
  if (
    !isRecord(value.compatibilityBaseline) || typeof value.compatibilityBaseline.id !== "string" ||
    value.compatibilityBaseline.schemaVersion !== COMPATIBILITY_BASELINE_SCHEMA_VERSION ||
    !isSha256(value.compatibilityBaseline.sha256)
  ) throw new Error("Blackglass release manifest has an invalid compatibility baseline");
  if (
    !isRecord(value.source) || !isSha256(value.source.officialDmgSha256) ||
    !isSha256(value.source.rendererAsarSha256) || !isSha256(value.source.wrapperAsarSha256) ||
    !isSha256(value.source.cliExecutableSha256) || value.source.unchanged !== true
  ) throw new Error("Blackglass release manifest has invalid upstream provenance");
  assertTreeIdentity(value.source.appTree);
  assertMacOSCodeInventory(value.source.macOSCodeInventory);
  if (
    !isRecord(value.patcher) || !isRecord(value.patcher.renderer) ||
    value.patcher.renderer.formatVersion !== RENDERER_PATCH_FORMAT_VERSION ||
    value.patcher.renderer.incisions !== RENDERER_INCISION_COUNT
  ) throw new Error("Blackglass release manifest has an unsupported renderer patcher");
  if (!isRecord(value.endpoints)) throw new Error("Blackglass release manifest has no endpoints");
  const endpoints = canonicalAdapterOptions({
    controlOrigin: String(value.endpoints.controlOrigin ?? ""),
    dataHost: String(value.endpoints.dataHost ?? ""),
  });
  if (endpoints.controlOrigin !== value.endpoints.controlOrigin || endpoints.dataHost !== value.endpoints.dataHost) {
    throw new Error("Blackglass release endpoints are not canonical");
  }
  assertMacOSPackagingToolchain(value.packagingToolchain);
  assertToolingSourceIdentity(value.toolingSource);
  if (!isRecord(value.renderer) || !isRecord(value.macOS)) throw new Error("Blackglass release artifacts are missing");
  for (const hash of [
    value.renderer.upstreamSha256, value.renderer.patchedSha256,
    value.renderer.rendererBeforeSha256, value.renderer.rendererAfterSha256,
    value.renderer.starterBeforeSha256, value.renderer.starterAfterSha256,
    value.renderer.mainBeforeSha256, value.renderer.mainAfterSha256,
    value.macOS.infoPlistSha256, value.macOS.executableSha256, value.macOS.embeddedAsarSha256,
    value.macOS.launchConfigSha256, value.macOS.officialAppTreeSha256, value.macOS.officialExecutableSha256,
    value.macOS.officialCodeInventorySha256, value.macOS.applicationTreeSha256,
    value.macOS.codeInventory?.sha256, value.macOS.rootMetadata?.sha256,
  ]) if (!isSha256(hash)) throw new Error("Blackglass release manifest contains an invalid SHA-256");
  assertMacOSCodeInventory(value.macOS.codeInventory);
  assertMacOSRootMetadata(value.macOS.rootMetadata);
  assertTreeIdentity(value.macOS.applicationTreeIdentity);
  if (
    value.renderer.patchFormatVersion !== RENDERER_PATCH_FORMAT_VERSION ||
    value.renderer.incisionCount !== RENDERER_INCISION_COUNT ||
    value.renderer.controlOrigin !== endpoints.controlOrigin || value.renderer.dataHost !== endpoints.dataHost ||
    value.renderer.cliExecutableEnvironment !== BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT ||
    value.renderer.upstreamSha256 !== value.source.rendererAsarSha256 ||
    value.renderer.patchedSha256 !== value.macOS.embeddedAsarSha256 ||
    value.macOS.schemaVersion !== 9 || value.macOS.appBundleName !== "Blackglass Bridge.app" ||
    value.macOS.bundleIdentifier !== "com.blackglass.bridge" ||
    value.macOS.bundleName !== "Blackglass Bridge" || value.macOS.displayName !== "Blackglass Bridge" ||
    value.macOS.blackglassVersion !== value.blackglassVersion || value.macOS.rendererVersion !== value.rendererVersion ||
    value.macOS.executableName !== "blackglass-bridge" || value.macOS.officialExecutableName !== "Obsidian" ||
    value.macOS.officialAppTreeSha256 !== value.source.appTree.sha256 ||
    value.macOS.officialCodeInventorySha256 !== value.source.macOSCodeInventory.sha256 ||
    value.macOS.applicationTreeSha256 !== value.macOS.applicationTreeIdentity.sha256 ||
    value.macOS.profileDirectory !== BRIDGE_PROFILE_DIRECTORY || value.macOS.profileMode !== 0o700 ||
    value.macOS.explicitUserDataDir !== true || value.macOS.nativeHomePreserved !== true ||
    value.macOS.blackglassHomeEnvironment !== "BLACKGLASS_HOME" ||
    value.macOS.updateDisableSettingRequired !== true ||
    value.macOS.exactOfficialAppVerifiedAtEveryLaunch !== true ||
    value.macOS.officialAppUnmodified !== true || value.macOS.officialChildSupervisionRequired !== true ||
    !Array.isArray(value.macOS.registeredUrlSchemes) || value.macOS.registeredUrlSchemes.length !== 0 ||
    value.macOS.upstreamICloudContainerRegistered !== false
  ) throw new Error("Blackglass release manifest artifact bindings are inconsistent");
  if (
    !isRecord(value.macOS.codeSigning) || value.macOS.codeSigning.signature !== "ad-hoc" ||
    value.macOS.codeSigning.strictVerification !== true || value.macOS.codeSigning.allArchitecturesVerified !== true ||
    value.macOS.codeSigning.bundleIdentifier !== "com.blackglass.bridge" ||
    value.macOS.codeSigning.executableIdentifier !== "com.blackglass.bridge" ||
    !Array.isArray(value.macOS.codeSigning.executableArchitectures) ||
    value.macOS.codeSigning.executableArchitectures.length !== 1 ||
    value.macOS.codeSigning.executableArchitectures[0] !== "arm64"
  ) throw new Error("Blackglass release manifest launcher signing evidence is invalid");
  if (
    !isRecord(value.launchPolicy) || value.launchPolicy.profileDirectory !== BRIDGE_PROFILE_DIRECTORY ||
    value.launchPolicy.profileMode !== 0o700 || value.launchPolicy.explicitUserDataDir !== true ||
    value.launchPolicy.nativeHomePreserved !== true || value.launchPolicy.blackglassHomeEnvironment !== "BLACKGLASS_HOME" ||
    value.launchPolicy.updatesDisabledBeforeLaunch !== true || value.launchPolicy.exactOfficialAppVerifiedAtEveryLaunch !== true ||
    value.launchPolicy.exclusiveOfficialInstance !== true || value.launchPolicy.officialChildSupervisionRequired !== true
  ) throw new Error("Blackglass release manifest launch policy is unsafe");
  if (
    !isRecord(value.distribution) || value.distribution.officialApplicationRedistributed !== false ||
    value.distribution.officialWrapperRedistributed !== false || value.distribution.officialCliRedistributed !== false ||
    value.distribution.proprietaryAssetsRedistributed !== false || value.distribution.adaptedRendererGeneratedLocally !== true
  ) throw new Error("Blackglass release manifest distribution boundary is invalid");
  if (
    !isRecord(value.reproduction) || typeof value.reproduction.officialDmgMatchedBaseline !== "boolean" ||
    value.reproduction.sourceAppTreeMatchedBaseline !== true || value.reproduction.sourceCodeInventoryMatchedBaseline !== true ||
    value.reproduction.sourceWrapperMatchesBaseline !== true || value.reproduction.sourceCliMatchesBaseline !== true ||
    value.reproduction.rendererByteIdentical !== true || value.reproduction.launcherContainsOnlyBridgeCodeAndLocalAdapter !== true ||
    value.reproduction.officialAppUnmodified !== true
  ) throw new Error("Blackglass release manifest reproduction evidence is incomplete");
}

function assertTreeIdentity(value: unknown): asserts value is TreeIdentity {
  if (!isRecord(value) || value.formatVersion !== TREE_IDENTITY_FORMAT_VERSION || !isSha256(value.sha256)) {
    throw new Error("Invalid tree identity");
  }
  for (const key of ["entries", "files", "directories", "symlinks", "fileBytes"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) throw new Error("Invalid tree identity count");
  }
}
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
