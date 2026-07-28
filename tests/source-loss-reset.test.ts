import { describe, expect, test } from "bun:test";
import {
  SOURCE_LOSS_RESET_SCHEMA_VERSION,
  assertRecoveryReportResetBinding,
  assertSourceLossResetRecord,
  treeIdentitiesEqual,
  type SourceLossResetExpectation,
} from "../tools/source-loss-reset";

const expected: SourceLossResetExpectation = {
  runManifestSha256: "1".repeat(64),
  syncReportSha256: "2".repeat(64),
  recoveryManifestSha256: "3".repeat(64),
  compatibilityAsarSha256: "4".repeat(64),
  profilePath: "/tmp/run/client-b/user-data",
  vaultPath: "/tmp/run/client-b/vault",
};

function record(): any {
  const tree = (digest: string) => ({
    formatVersion: 1,
    sha256: digest.repeat(64),
    entries: 3,
    files: 1,
    directories: 1,
    symlinks: 1,
    fileBytes: 42,
  });
  return {
    schemaVersion: SOURCE_LOSS_RESET_SCHEMA_VERSION,
    resetAt: "2026-07-28T12:00:00.000Z",
    runManifestSha256: expected.runManifestSha256,
    syncReportSha256: expected.syncReportSha256,
    recoveryManifestSha256: expected.recoveryManifestSha256,
    removed: {
      clientA: tree("a"),
      clientB: tree("b"),
    },
    retiredRuntimeHomes: {
      "client-a": {
        identitySha256: "5".repeat(64),
        blackglassHomePath: "/private/tmp/blackglass-client-Ab12Cd/h",
        runtimeHomeRemoved: true,
      },
      "client-b": {
        identitySha256: "6".repeat(64),
        blackglassHomePath: "/private/tmp/blackglass-client-Ef34Gh/h",
        runtimeHomeRemoved: true,
      },
    },
    freshClient: {
      name: "client-b",
      profilePath: expected.profilePath,
      vaultPath: expected.vaultPath,
      adapterSha256: expected.compatibilityAsarSha256,
      initialVaultFiles: 0,
    },
  };
}

describe("source-loss reset evidence contract", () => {
  test("accepts a current reset bound to the exact recovery capture", () => {
    expect(() => assertSourceLossResetRecord(record(), expected)).not.toThrow();
  });

  test("rejects legacy and independently mutated lifecycle evidence", () => {
    const mutations: Array<(value: any) => void> = [
      (value) => (value.schemaVersion = 2),
      (value) => (value.runManifestSha256 = "0".repeat(64)),
      (value) => (value.syncReportSha256 = "0".repeat(64)),
      (value) => (value.recoveryManifestSha256 = "0".repeat(64)),
      (value) => (value.freshClient.adapterSha256 = "0".repeat(64)),
      (value) => (value.freshClient.profilePath = "/tmp/other"),
      (value) => (value.removed.clientA.entries = 4),
      (value) => delete value.retiredRuntimeHomes["client-a"],
      (value) => (value.retiredRuntimeHomes["client-b"].runtimeHomeRemoved = false),
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(record());
      mutate(candidate);
      expect(() => assertSourceLossResetRecord(candidate, expected)).toThrow();
    }
  });

  test("binds the recovery report to both exact lifecycle artifacts", () => {
    const binding = {
      recoveryManifestSha256: expected.recoveryManifestSha256,
      sourceLossResetSha256: "7".repeat(64),
      resetAt: "2026-07-28T12:00:00.000Z",
    };
    const report = {
      recoveryManifestSha256: binding.recoveryManifestSha256,
      sourceLossResetSha256: binding.sourceLossResetSha256,
      sourceLossResetAt: binding.resetAt,
    };
    expect(() => assertRecoveryReportResetBinding(report, binding)).not.toThrow();
    for (const key of Object.keys(report) as Array<keyof typeof report>) {
      const candidate = { ...report, [key]: "changed" };
      expect(() => assertRecoveryReportResetBinding(candidate, binding)).toThrow();
    }
  });

  test("detects a retired tree mutation before destructive cleanup", () => {
    const reset = record();
    const changed = structuredClone(reset.removed.clientA);
    changed.fileBytes += 1;
    expect(treeIdentitiesEqual(reset.removed.clientA, reset.removed.clientA)).toBe(true);
    expect(treeIdentitiesEqual(changed, reset.removed.clientA)).toBe(false);
  });
});
