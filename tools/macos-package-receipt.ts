import { createHash } from "node:crypto";
import type { MacOSArtifact } from "./macos-artifact";
import type { BridgeReleaseManifest } from "./release-manifest";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";
import { stableJson } from "./stable-json";

export const MACOS_PACKAGE_RECEIPT_SCHEMA_VERSION = 1;

type PublicMacOSArtifact = Omit<MacOSArtifact, "appPath">;

export interface MacOSPackageReceipt {
  schemaVersion: typeof MACOS_PACKAGE_RECEIPT_SCHEMA_VERSION;
  generatedBy: "tools/package-macos.ts";
  invocationId: string;
  startedAt: string;
  completedAt: string;
  bridgeVersion: string;
  rendererVersion: string;
  releaseManifestSha256: string;
  macOSArtifactSha256: string;
  applicationTreeSha256: string;
  codeInventorySha256: string;
  rootMetadataSha256: string;
  packagingToolchainSha256: string;
  toolingSourceSha256: string;
}

export interface MacOSPackageReleaseIdentity {
  bridgeVersion: string;
  rendererVersion: string;
  releaseManifestSha256: string;
  artifact: PublicMacOSArtifact;
  packagingToolchainSha256: string;
  toolingSourceSha256: string;
}

export function createMacOSPackageReceipt(input: {
  invocationId: string;
  startedAt: string;
  completedAt: string;
  manifest: BridgeReleaseManifest;
  releaseManifestSha256: string;
  artifact: PublicMacOSArtifact;
}): MacOSPackageReceipt {
  const receipt: MacOSPackageReceipt = {
    schemaVersion: MACOS_PACKAGE_RECEIPT_SCHEMA_VERSION,
    generatedBy: "tools/package-macos.ts",
    invocationId: input.invocationId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    bridgeVersion: input.manifest.bridgeVersion,
    rendererVersion: input.manifest.rendererVersion,
    releaseManifestSha256: input.releaseManifestSha256,
    macOSArtifactSha256: sha256(stableJson(input.artifact)),
    applicationTreeSha256: input.artifact.applicationTreeSha256,
    codeInventorySha256: input.artifact.codeInventory.sha256,
    rootMetadataSha256: input.artifact.rootMetadata.sha256,
    packagingToolchainSha256: sha256(
      stableJson(input.manifest.packagingToolchain),
    ),
    toolingSourceSha256: sha256(stableJson(input.manifest.toolingSource)),
  };
  assertMacOSPackageReceipt(receipt);
  return receipt;
}

export function assertMacOSPackageReceipt(
  value: unknown,
): asserts value is MacOSPackageReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== MACOS_PACKAGE_RECEIPT_SCHEMA_VERSION ||
    value.generatedBy !== "tools/package-macos.ts" ||
    typeof value.invocationId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      value.invocationId,
    ) ||
    typeof value.startedAt !== "string" ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
    typeof value.bridgeVersion !== "string" ||
    !isSupportedSemver(value.bridgeVersion) ||
    typeof value.rendererVersion !== "string" ||
    !isSupportedStableSemver(value.rendererVersion)
  ) {
    throw new Error("Invalid macOS package invocation receipt");
  }
  for (const field of [
    "releaseManifestSha256",
    "macOSArtifactSha256",
    "applicationTreeSha256",
    "codeInventorySha256",
    "rootMetadataSha256",
    "packagingToolchainSha256",
    "toolingSourceSha256",
  ] as const) {
    if (!isSha256(value[field])) {
      throw new Error(`Invalid macOS package receipt ${field}`);
    }
  }
}

export function assertMacOSPackageReceiptBinds(
  receipt: MacOSPackageReceipt,
  identity: MacOSPackageReleaseIdentity,
): void {
  assertMacOSPackageReceipt(receipt);
  if (
    receipt.bridgeVersion !== identity.bridgeVersion ||
    receipt.rendererVersion !== identity.rendererVersion ||
    receipt.releaseManifestSha256 !== identity.releaseManifestSha256 ||
    receipt.macOSArtifactSha256 !== sha256(stableJson(identity.artifact)) ||
    receipt.applicationTreeSha256 !== identity.artifact.applicationTreeSha256 ||
    receipt.codeInventorySha256 !== identity.artifact.codeInventory.sha256 ||
    receipt.rootMetadataSha256 !== identity.artifact.rootMetadata.sha256 ||
    receipt.packagingToolchainSha256 !== identity.packagingToolchainSha256 ||
    receipt.toolingSourceSha256 !== identity.toolingSourceSha256
  ) {
    throw new Error("macOS package receipt does not bind the selected release");
  }
}

export function parseMacOSPackageReceipt(bytes: Uint8Array): MacOSPackageReceipt {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  assertMacOSPackageReceipt(value);
  return value;
}

export function serializeMacOSPackageReceipt(
  receipt: MacOSPackageReceipt,
): Buffer {
  assertMacOSPackageReceipt(receipt);
  return Buffer.from(`${stableJson(receipt)}\n`, "utf8");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
