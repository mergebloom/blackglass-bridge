import { describe, expect, test } from "bun:test";
import { validateMatrixScenarioReport } from "../tools/compatibility-matrix-entry";
import type { ReleaseValidationRecord } from "../tools/release-validation";
import { e2eScenarioDefinition } from "../tools/e2e-scenario";

const revision = "1".repeat(40);
const sha256 = "2".repeat(64);
const record = {
  rendererVersion: "1.13.4",
  blackglassVersion: "0.3.0",
  toolingSource: { gitRevision: "4".repeat(40) },
  artifacts: {
    releaseManifestSha256: "3".repeat(64),
    server: { sourceRevision: revision, sha256 },
  },
  packagedClientE2E: { evidence: { runManifestSha256: "5".repeat(64) } },
} as ReleaseValidationRecord;

describe("compatibility matrix report binding", () => {
  test("reads the release server revision from its attested artifact", () => {
    const report = releaseReport();
    expect(validateMatrixScenarioReport(
      report,
      "E2E-RELEASE-SYNC-RECOVERY",
      record,
    )).toEqual({
      observedAt: ["2026-08-03T12:00:00.000Z"],
      runManifestSha256: record.packagedClientE2E.evidence.runManifestSha256,
    });
    report.artifacts.server.sourceRevision = "4".repeat(40);
    expect(() => validateMatrixScenarioReport(
      report,
      "E2E-RELEASE-SYNC-RECOVERY",
      record,
    )).toThrow("does not bind the validation record artifacts");
  });

  test("reads a phase report server revision from its top level", () => {
    const report = phaseReport();
    expect(validateMatrixScenarioReport(report, "E2E-P3-TENANCY", record).observedAt)
      .toHaveLength(e2eScenarioDefinition("E2E-P3-TENANCY").checkpoints.length);
    report.serverRevision = "5".repeat(40);
    expect(() => validateMatrixScenarioReport(report, "E2E-P3-TENANCY", record))
      .toThrow("Scenario report is incomplete");
  });

  test("requires exact role-bound network evidence for named scenarios", () => {
    const report = phaseReport();
    delete (report as any).networkEvidence["client-c"];
    expect(() => validateMatrixScenarioReport(report, "E2E-P3-TENANCY", record))
      .toThrow("Scenario report is incomplete");
  });
});

function releaseReport() {
  return {
    schemaVersion: 10,
    scenarioId: "E2E-RELEASE-SYNC-RECOVERY",
    passed: true,
    qualifiedAt: "2026-08-03T12:00:00.000Z",
    rendererVersion: "1.13.4",
    blackglassVersion: "0.3.0",
    validationFileName: `blackglass-release-sync-recovery-obsidian-1.13.4-bridge-${record.blackglassVersion}-${record.toolingSource.gitRevision}-server-${revision}.json`,
    artifacts: {
      releaseManifestSha256: record.artifacts.releaseManifestSha256,
      server: { sourceRevision: revision, sha256 },
    },
    evidence: { runManifestSha256: record.packagedClientE2E.evidence.runManifestSha256 },
  };
}

function phaseReport() {
  return {
    schemaVersion: 1,
    scenarioId: "E2E-P3-TENANCY",
    passed: true,
    rendererVersion: "1.13.4",
    bridgeVersion: record.blackglassVersion,
    bridgeRevision: record.toolingSource.gitRevision,
    serverRevision: revision,
    serverBinarySha256: sha256,
    runManifestSha256: "a".repeat(64),
    releaseManifestSha256: record.artifacts.releaseManifestSha256,
    validationFileName: `phase-3-tenancy-obsidian-1.13.4-bridge-${record.blackglassVersion}-${record.toolingSource.gitRevision}-server-${revision}.json`,
    networkEvidence: Object.fromEntries(
      ["client-a", "client-b", "client-c"].map((role) => [role, {
        startedAt: "2026-08-03T12:00:00.000Z",
        completedAt: "2026-08-03T12:02:00.000Z",
        evidenceSha256: "a".repeat(64),
        finalizeSha256: "b".repeat(64),
      }]),
    ),
    checkpoints: e2eScenarioDefinition("E2E-P3-TENANCY").checkpoints.map((checkpoint, index) => ({
      checkpoint,
      observedAt: new Date(Date.parse("2026-08-03T12:01:00.000Z") + index * 1_000).toISOString(),
      proofSha256: "6".repeat(64),
      launchIdentitySha256: "5".repeat(64),
      uiStateSha256: "7".repeat(64),
      screenshotSha256: "8".repeat(64),
      databaseSha256: "9".repeat(64),
    })),
  };
}
