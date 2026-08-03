import { parseE2EScenarioId } from "./e2e-scenario";
import type {
  ReleaseQualification,
  ReleaseValidationRecord,
} from "./release-validation";

export function validateMatrixScenarioReport(
  value: unknown,
  expectedScenario: string,
  record: ReleaseValidationRecord,
): { observedAt: string[] } {
  if (!isRecord(value) || value.passed !== true || value.scenarioId !== expectedScenario ||
    value.rendererVersion !== record.rendererVersion) {
    throw new Error(`Scenario report does not bind ${expectedScenario} to the release artifacts`);
  }
  parseE2EScenarioId(value.scenarioId);
  if (expectedScenario === "E2E-RELEASE-SYNC-RECOVERY") {
    const qualification = value as unknown as ReleaseQualification;
    if (qualification.schemaVersion !== 9 ||
      qualification.blackglassVersion !== record.blackglassVersion ||
      qualification.artifacts?.releaseManifestSha256 !== record.artifacts.releaseManifestSha256 ||
      qualification.artifacts?.server?.sourceRevision !== record.artifacts.server.sourceRevision ||
      qualification.artifacts?.server?.sha256 !== record.artifacts.server.sha256 ||
      !isIsoDate(qualification.qualifiedAt)) {
      throw new Error("Release qualification does not bind the validation record artifacts");
    }
    return { observedAt: [qualification.qualifiedAt] };
  }
  if (value.schemaVersion !== 1 ||
    value.serverRevision !== record.artifacts.server.sourceRevision ||
    value.releaseManifestSha256 !== record.artifacts.releaseManifestSha256 ||
    !Array.isArray(value.checkpoints) || value.checkpoints.length === 0) {
    throw new Error(`Scenario report is incomplete for ${expectedScenario}`);
  }
  const observedAt = value.checkpoints.map((checkpoint) => {
    if (!isRecord(checkpoint) || !isIsoDate(checkpoint.observedAt)) {
      throw new Error(`Scenario report has malformed checkpoint time for ${expectedScenario}`);
    }
    return checkpoint.observedAt;
  });
  return { observedAt };
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
