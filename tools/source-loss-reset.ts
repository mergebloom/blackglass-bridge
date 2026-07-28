import type { TreeIdentity } from "./tree-identity";
import { TREE_IDENTITY_FORMAT_VERSION } from "./tree-identity";

export const SOURCE_LOSS_RESET_SCHEMA_VERSION = 3 as const;

export interface SourceLossResetRecord {
  schemaVersion: typeof SOURCE_LOSS_RESET_SCHEMA_VERSION;
  resetAt: string;
  runManifestSha256: string;
  syncReportSha256: string;
  recoveryManifestSha256: string;
  removed: {
    clientA: TreeIdentity;
    clientB: TreeIdentity;
  };
  retiredRuntimeHomes: Record<
    "client-a" | "client-b",
    {
      identitySha256: string;
      blackglassHomePath: string;
      runtimeHomeRemoved: true;
    }
  >;
  freshClient: {
    name: "client-b";
    profilePath: string;
    vaultPath: string;
    adapterSha256: string;
    initialVaultFiles: 0;
  };
}

export interface SourceLossResetExpectation {
  runManifestSha256: string;
  syncReportSha256: string;
  recoveryManifestSha256: string;
  compatibilityAsarSha256: string;
  profilePath: string;
  vaultPath: string;
}

export interface RecoveryReportResetExpectation {
  recoveryManifestSha256: string;
  sourceLossResetSha256: string;
  resetAt: string;
}

export function assertSourceLossResetRecord(
  value: unknown,
  expected: SourceLossResetExpectation,
): asserts value is SourceLossResetRecord {
  if (!isRecord(value)) {
    throw new Error("Source-loss reset record is malformed");
  }
  if (
    value.schemaVersion !== SOURCE_LOSS_RESET_SCHEMA_VERSION ||
    typeof value.resetAt !== "string" ||
    !Number.isFinite(Date.parse(value.resetAt)) ||
    value.runManifestSha256 !== expected.runManifestSha256 ||
    value.syncReportSha256 !== expected.syncReportSha256 ||
    value.recoveryManifestSha256 !== expected.recoveryManifestSha256
  ) {
    throw new Error("Source-loss reset record is not bound to the exact recovery capture");
  }
  if (!isRecord(value.removed)) {
    throw new Error("Source-loss reset record does not identify the retired client trees");
  }
  assertTreeIdentity(value.removed.clientA, "client-a");
  assertTreeIdentity(value.removed.clientB, "client-b");

  if (!isRecord(value.retiredRuntimeHomes)) {
    throw new Error("Source-loss reset record does not identify retired runtime homes");
  }
  const roles = Object.keys(value.retiredRuntimeHomes).sort(compareStrings);
  if (JSON.stringify(roles) !== JSON.stringify(["client-a", "client-b"])) {
    throw new Error("Source-loss reset record has unexpected retired runtime homes");
  }
  for (const role of roles) {
    const retired = value.retiredRuntimeHomes[role];
    if (
      !isRecord(retired) ||
      !isSha256(retired.identitySha256) ||
      typeof retired.blackglassHomePath !== "string" ||
      !/^\/private\/tmp\/blackglass-client-[A-Za-z0-9]{6}\/h$/u.test(
        retired.blackglassHomePath,
      ) ||
      retired.runtimeHomeRemoved !== true
    ) {
      throw new Error(`Source-loss reset record has malformed ${role} runtime evidence`);
    }
  }

  const fresh = value.freshClient;
  if (
    !isRecord(fresh) ||
    fresh.name !== "client-b" ||
    fresh.profilePath !== expected.profilePath ||
    fresh.vaultPath !== expected.vaultPath ||
    fresh.adapterSha256 !== expected.compatibilityAsarSha256 ||
    fresh.initialVaultFiles !== 0
  ) {
    throw new Error("Source-loss reset record does not identify the exact fresh client");
  }
}

export function treeIdentitiesEqual(left: TreeIdentity, right: TreeIdentity): boolean {
  return (
    left.formatVersion === right.formatVersion &&
    left.sha256 === right.sha256 &&
    left.entries === right.entries &&
    left.files === right.files &&
    left.directories === right.directories &&
    left.symlinks === right.symlinks &&
    left.fileBytes === right.fileBytes
  );
}

export function assertRecoveryReportResetBinding(
  value: unknown,
  expected: RecoveryReportResetExpectation,
): void {
  if (
    !isRecord(value) ||
    value.recoveryManifestSha256 !== expected.recoveryManifestSha256 ||
    value.sourceLossResetSha256 !== expected.sourceLossResetSha256 ||
    value.sourceLossResetAt !== expected.resetAt
  ) {
    throw new Error("Recovery report is not bound to the destructive reset lifecycle");
  }
}

function assertTreeIdentity(value: unknown, label: string): asserts value is TreeIdentity {
  if (
    !isRecord(value) ||
    value.formatVersion !== TREE_IDENTITY_FORMAT_VERSION ||
    !isSha256(value.sha256) ||
    !isNonNegativeInteger(value.entries) ||
    !isNonNegativeInteger(value.files) ||
    !isNonNegativeInteger(value.directories) ||
    !isNonNegativeInteger(value.symlinks) ||
    !isNonNegativeInteger(value.fileBytes) ||
    value.entries !== value.files + value.directories + value.symlinks
  ) {
    throw new Error(`Source-loss reset record has malformed ${label} tree identity`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
