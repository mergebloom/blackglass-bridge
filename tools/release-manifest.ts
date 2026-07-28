import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalAdapterOptions,
  BRIDGE_CLI_COMMAND_NAME,
  BRIDGE_CLI_COMMAND_PATH,
  RENDERER_INCISION_COUNT,
  RENDERER_PATCH_FORMAT_VERSION,
  type AdapterOptions,
  type AdapterReport,
} from "../packages/client-adapter/src/patch";
import {
  WRAPPER_INCISION_COUNT,
  WRAPPER_PATCH_FORMAT_VERSION,
  type WrapperPatchReport,
} from "../packages/client-adapter/src/wrapper";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import {
  BRIDGE_CLI_SOCKET_NAME,
  CLI_BINARY_INCISION_COUNT,
  CLI_BINARY_PATCH_FORMAT_VERSION,
  type CliBinaryPatchReport,
} from "./cli-binary";
import { assertMacOSCodeSigningEvidence } from "./macos-code-signing";
import type { MacOSArtifact } from "./macos-artifact";
import {
  assertToolingSourceIdentity,
  type ToolingSourceIdentity,
} from "./tooling-source";
import {
  TREE_IDENTITY_FORMAT_VERSION,
  type TreeIdentity,
} from "./tree-identity";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";

export const BRIDGE_RELEASE_MANIFEST_SCHEMA_VERSION = 7;

export interface BridgeReleaseManifest {
  schemaVersion: typeof BRIDGE_RELEASE_MANIFEST_SCHEMA_VERSION;
  bridgeVersion: string;
  rendererVersion: string;
  compatibilityBaseline: {
    id: string;
    schemaVersion: number;
    sha256: string;
  };
  source: {
    officialDmgSha256: string;
    appTree: TreeIdentity;
    rendererAsarSha256: string;
    wrapperAsarSha256: string;
    cliExecutableSha256: string;
  };
  patcher: {
    renderer: {
      formatVersion: typeof RENDERER_PATCH_FORMAT_VERSION;
      incisions: typeof RENDERER_INCISION_COUNT;
    };
    wrapper: {
      formatVersion: typeof WRAPPER_PATCH_FORMAT_VERSION;
      incisions: typeof WRAPPER_INCISION_COUNT;
    };
    cli: {
      formatVersion: typeof CLI_BINARY_PATCH_FORMAT_VERSION;
      incisions: typeof CLI_BINARY_INCISION_COUNT;
    };
  };
  endpoints: AdapterOptions;
  toolingSource: ToolingSourceIdentity;
  renderer: AdapterReport;
  wrapper: WrapperPatchReport;
  cli: CliBinaryPatchReport;
  macOS: Omit<MacOSArtifact, "appPath">;
  reproduction: {
    officialDmgMatchedBaseline: true;
    sourceAppTreeMatchedBaseline: true;
    stagedCopyTreeMatchedSource: true;
    reviewedSourceRenderer: true;
    sourceWrapperMatchesBaseline: true;
    rendererByteIdentical: true;
    packagedRendererByteIdentical: true;
    packagedWrapperIntegrityVerified: true;
    packagedCliSocketVerified: true;
    reviewedCodeSigningPreserved: true;
  };
}

export async function readBridgeReleaseManifest(
  path: string,
): Promise<{ path: string; manifest: BridgeReleaseManifest }> {
  const resolvedPath = resolve(path);
  const value = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
  assertBridgeReleaseManifest(value);
  return { path: resolvedPath, manifest: value };
}

export function assertBridgeReleaseManifest(
  value: unknown,
): asserts value is BridgeReleaseManifest {
  if (!isRecord(value) || value.schemaVersion !== BRIDGE_RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new Error("Unsupported Bridge release manifest schema");
  }
  if (
    typeof value.bridgeVersion !== "string" ||
    !isSupportedSemver(value.bridgeVersion) ||
    typeof value.rendererVersion !== "string" ||
    !isSupportedStableSemver(value.rendererVersion)
  ) {
    throw new Error("Bridge release manifest has invalid versions");
  }
  if (
    !isRecord(value.compatibilityBaseline) ||
    typeof value.compatibilityBaseline.id !== "string" ||
    value.compatibilityBaseline.schemaVersion !== 4 ||
    !isSha256(value.compatibilityBaseline.sha256)
  ) {
    throw new Error("Bridge release manifest has an invalid compatibility baseline");
  }
  if (
    !isRecord(value.source) ||
    !isSha256(value.source.officialDmgSha256) ||
    !isSha256(value.source.rendererAsarSha256) ||
    !isSha256(value.source.wrapperAsarSha256) ||
    !isSha256(value.source.cliExecutableSha256)
  ) {
    throw new Error("Bridge release manifest has invalid source provenance");
  }
  assertTreeIdentity(value.source.appTree);
  if (
    !isRecord(value.patcher) ||
    !isRecord(value.patcher.renderer) ||
    value.patcher.renderer.formatVersion !== RENDERER_PATCH_FORMAT_VERSION ||
    value.patcher.renderer.incisions !== RENDERER_INCISION_COUNT ||
    !isRecord(value.patcher.wrapper) ||
    value.patcher.wrapper.formatVersion !== WRAPPER_PATCH_FORMAT_VERSION ||
    value.patcher.wrapper.incisions !== WRAPPER_INCISION_COUNT ||
    !isRecord(value.patcher.cli) ||
    value.patcher.cli.formatVersion !== CLI_BINARY_PATCH_FORMAT_VERSION ||
    value.patcher.cli.incisions !== CLI_BINARY_INCISION_COUNT
  ) {
    throw new Error("Bridge release manifest has an unsupported patcher version");
  }
  if (!isRecord(value.endpoints)) {
    throw new Error("Bridge release manifest has no endpoints");
  }
  assertToolingSourceIdentity(value.toolingSource);
  const endpoints = canonicalAdapterOptions({
    controlOrigin: String(value.endpoints.controlOrigin ?? ""),
    dataHost: String(value.endpoints.dataHost ?? ""),
  });
  if (
    endpoints.controlOrigin !== value.endpoints.controlOrigin ||
    endpoints.dataHost !== value.endpoints.dataHost
  ) {
    throw new Error("Bridge release manifest endpoints are not canonical");
  }
  if (
    !isRecord(value.renderer) ||
    !isRecord(value.wrapper) ||
    !isRecord(value.cli) ||
    !isRecord(value.macOS)
  ) {
    throw new Error("Bridge release manifest is missing artifact identities");
  }
  assertMacOSCodeSigningEvidence(value.macOS.codeSigning);
  for (const hash of [
    value.renderer.upstreamSha256,
    value.renderer.patchedSha256,
    value.renderer.rendererBeforeSha256,
    value.renderer.rendererAfterSha256,
    value.renderer.starterBeforeSha256,
    value.renderer.starterAfterSha256,
    value.renderer.mainBeforeSha256,
    value.renderer.mainAfterSha256,
    value.wrapper.upstreamSha256,
    value.wrapper.patchedSha256,
    value.wrapper.upstreamHeaderSha256,
    value.wrapper.patchedHeaderSha256,
    value.wrapper.mainBeforeSha256,
    value.wrapper.mainAfterSha256,
    value.cli.upstreamSha256,
    value.cli.patchedSha256,
    value.macOS.infoPlistSha256,
    value.macOS.executableSha256,
    value.macOS.cliExecutableSha256,
    value.macOS.embeddedAsarSha256,
    value.macOS.embeddedWrapperAsarSha256,
    value.macOS.embeddedWrapperHeaderSha256,
    value.macOS.applicationTreeSha256,
  ]) {
    if (!isSha256(hash)) throw new Error("Bridge release manifest contains an invalid SHA-256");
  }
  assertTreeIdentity(value.macOS.applicationTreeIdentity, "packaged app tree");
  if (
    value.renderer.patchFormatVersion !== RENDERER_PATCH_FORMAT_VERSION ||
    value.renderer.incisionCount !== RENDERER_INCISION_COUNT ||
    value.renderer.controlOrigin !== endpoints.controlOrigin ||
    value.renderer.dataHost !== endpoints.dataHost ||
    value.renderer.cliSocketName !== BRIDGE_CLI_SOCKET_NAME ||
    value.renderer.cliCommandName !== BRIDGE_CLI_COMMAND_NAME ||
    value.renderer.cliCommandPath !== BRIDGE_CLI_COMMAND_PATH ||
    value.renderer.runtimeHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    value.wrapper.patchFormatVersion !== WRAPPER_PATCH_FORMAT_VERSION ||
    value.wrapper.incisionCount !== WRAPPER_INCISION_COUNT ||
    value.wrapper.profileHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    value.wrapper.dedicatedHomeValidated !== true ||
    value.wrapper.nativeHomeFallbackPreserved !== true ||
    value.cli.patchFormatVersion !== CLI_BINARY_PATCH_FORMAT_VERSION ||
    value.cli.incisionCount !== CLI_BINARY_INCISION_COUNT ||
    value.cli.socketName !== BRIDGE_CLI_SOCKET_NAME ||
    value.renderer.upstreamSha256 === value.renderer.patchedSha256 ||
    value.wrapper.upstreamSha256 === value.wrapper.patchedSha256 ||
    value.cli.upstreamSha256 === value.cli.patchedSha256 ||
    value.source.rendererAsarSha256 !== value.renderer.upstreamSha256 ||
    value.source.wrapperAsarSha256 !== value.wrapper.upstreamSha256 ||
    value.source.cliExecutableSha256 !== value.cli.upstreamSha256 ||
    value.macOS.embeddedAsarSha256 !== value.renderer.patchedSha256 ||
    value.macOS.rendererRuntimeHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    value.macOS.rendererCliRuntimeRootValidated !== true ||
    value.macOS.embeddedWrapperAsarSha256 !== value.wrapper.patchedSha256 ||
    value.macOS.embeddedWrapperHeaderSha256 !== value.wrapper.patchedHeaderSha256 ||
    // Explicit ad-hoc signing rewrites the Mach-O code signature after the
    // byte-for-byte socket patch. Preserve both phase identities while
    // rejecting an unchanged packaged CLI; inspectMacOSArtifact separately
    // proves the signed executable still has the exact patched socket inventory.
    value.macOS.cliExecutableSha256 === value.cli.upstreamSha256 ||
    value.macOS.schemaVersion !== 7 ||
    value.macOS.applicationTreeSha256 !== value.macOS.applicationTreeIdentity.sha256
  ) {
    throw new Error("Bridge release manifest artifact bindings are inconsistent");
  }
  if (
    value.macOS.bundleIdentifier !== "com.blackglass.bridge" ||
    value.macOS.bundleName !== "Obsidian" ||
    value.macOS.displayName !== "Blackglass Bridge" ||
    value.macOS.executableName !== "Obsidian" ||
    value.macOS.cliExecutableName !== "obsidian-cli" ||
    value.macOS.cliSocketName !== BRIDGE_CLI_SOCKET_NAME ||
    value.macOS.cliSocketOccurrences !== CLI_BINARY_INCISION_COUNT ||
    value.macOS.rendererRuntimeHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    value.macOS.rendererCliRuntimeRootValidated !== true ||
    !isSha256(value.macOS.cliExecutableSha256) ||
    value.macOS.version !== value.rendererVersion ||
    value.macOS.profileDirectory !== "Blackglass Bridge" ||
    value.macOS.profileMode !== 448 ||
    value.macOS.profilePathCanonicalAtSetup !== true ||
    value.macOS.explicitUserDataDirHonored !== true ||
    value.macOS.profileHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    value.macOS.dedicatedHomeValidated !== true ||
    value.macOS.nativeHomeFallbackPreserved !== true ||
    value.macOS.upstreamUpdatesDisabled !== true ||
    value.macOS.embeddedRendererOnly !== true ||
    value.wrapper.profileDirectory !== "Blackglass Bridge" ||
    value.wrapper.profileMode !== 448 ||
    value.wrapper.profilePathCanonicalAtSetup !== true ||
    value.wrapper.explicitUserDataDirHonored !== true ||
    value.wrapper.profileHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    value.wrapper.dedicatedHomeValidated !== true ||
    value.wrapper.nativeHomeFallbackPreserved !== true ||
    value.wrapper.upstreamUpdatesDisabled !== true ||
    value.wrapper.embeddedRendererOnly !== true ||
    !Array.isArray(value.macOS.registeredUrlSchemes) ||
    value.macOS.registeredUrlSchemes.length !== 0 ||
    value.macOS.upstreamICloudContainerRegistered !== false
  ) {
    throw new Error("Bridge release manifest contains an unsafe macOS identity");
  }
  if (
    !isRecord(value.reproduction) ||
    value.reproduction.officialDmgMatchedBaseline !== true ||
    value.reproduction.sourceAppTreeMatchedBaseline !== true ||
    value.reproduction.stagedCopyTreeMatchedSource !== true ||
    value.reproduction.reviewedSourceRenderer !== true ||
    value.reproduction.sourceWrapperMatchesBaseline !== true ||
    value.reproduction.rendererByteIdentical !== true ||
    value.reproduction.packagedRendererByteIdentical !== true ||
    value.reproduction.packagedWrapperIntegrityVerified !== true ||
    value.reproduction.packagedCliSocketVerified !== true ||
    value.reproduction.reviewedCodeSigningPreserved !== true
  ) {
    throw new Error("Bridge release manifest does not attest deterministic reproduction");
  }
}

function assertTreeIdentity(
  value: unknown,
  label = "source app tree",
): asserts value is TreeIdentity {
  if (
    !isRecord(value) ||
    value.formatVersion !== TREE_IDENTITY_FORMAT_VERSION ||
    !isSha256(value.sha256)
  ) {
    throw new Error(`Bridge release manifest has an invalid ${label} identity`);
  }
  for (const field of [
    "entries",
    "files",
    "directories",
    "symlinks",
    "fileBytes",
  ] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new Error(`Bridge release manifest ${label} has invalid ${field}`);
    }
  }
  if (
    (value.entries as number) !==
    (value.files as number) + (value.directories as number) + (value.symlinks as number)
  ) {
    throw new Error(`Bridge release manifest ${label} counts are inconsistent`);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
