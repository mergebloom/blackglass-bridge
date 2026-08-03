import { describe, expect, test } from "bun:test";
import { validateMatrixScenarioReport } from "../tools/compatibility-matrix-entry";
import type { ReleaseValidationRecord } from "../tools/release-validation";

const revision = "1".repeat(40);
const sha256 = "2".repeat(64);
const record = {
  rendererVersion: "1.13.4",
  blackglassVersion: "0.3.0",
  artifacts: {
    releaseManifestSha256: "3".repeat(64),
    server: { sourceRevision: revision, sha256 },
  },
} as ReleaseValidationRecord;

describe("compatibility matrix report binding", () => {
  test("reads the release server revision from its attested artifact", () => {
    const report = releaseReport();
    expect(validateMatrixScenarioReport(
      report,
      "E2E-RELEASE-SYNC-RECOVERY",
      record,
    )).toEqual({ observedAt: ["2026-08-03T12:00:00.000Z"] });
    report.artifacts.server.sourceRevision = "4".repeat(40);
    expect(() => validateMatrixScenarioReport(
      report,
      "E2E-RELEASE-SYNC-RECOVERY",
      record,
    )).toThrow("does not bind the validation record artifacts");
  });

  test("reads a phase report server revision from its top level", () => {
    const report = phaseReport();
    expect(validateMatrixScenarioReport(report, "E2E-P3-TENANCY", record))
      .toEqual({ observedAt: ["2026-08-03T12:01:00.000Z"] });
    report.serverRevision = "5".repeat(40);
    expect(() => validateMatrixScenarioReport(report, "E2E-P3-TENANCY", record))
      .toThrow("Scenario report is incomplete");
  });
});

function releaseReport() {
  return {
    schemaVersion: 9,
    scenarioId: "E2E-RELEASE-SYNC-RECOVERY",
    passed: true,
    qualifiedAt: "2026-08-03T12:00:00.000Z",
    rendererVersion: "1.13.4",
    blackglassVersion: "0.3.0",
    artifacts: {
      releaseManifestSha256: record.artifacts.releaseManifestSha256,
      server: { sourceRevision: revision, sha256 },
    },
  };
}

function phaseReport() {
  return {
    schemaVersion: 1,
    scenarioId: "E2E-P3-TENANCY",
    passed: true,
    rendererVersion: "1.13.4",
    serverRevision: revision,
    releaseManifestSha256: record.artifacts.releaseManifestSha256,
    checkpoints: [{ observedAt: "2026-08-03T12:01:00.000Z" }],
  };
}
