import {
  e2eScenarioDefinition,
  parseE2EScenarioId,
  scenarioValidationFileName,
} from "./e2e-scenario";
import { scenarioNetworkRoles } from "./e2e-network-evidence";
import type {
  ReleaseQualification,
  ReleaseValidationRecord,
} from "./release-validation";

export function validateMatrixScenarioReport(
  value: unknown,
  expectedScenario: string,
  record: ReleaseValidationRecord,
): { observedAt: string[]; runManifestSha256: string } {
  if (!isRecord(value) || value.passed !== true || value.scenarioId !== expectedScenario ||
    value.rendererVersion !== record.rendererVersion) {
    throw new Error(`Scenario report does not bind ${expectedScenario} to the release artifacts`);
  }
  parseE2EScenarioId(value.scenarioId);
  if (expectedScenario === "E2E-RELEASE-SYNC-RECOVERY") {
    const qualification = value as unknown as ReleaseQualification;
    if (qualification.schemaVersion !== 10 ||
      qualification.blackglassVersion !== record.blackglassVersion ||
      qualification.validationFileName !== scenarioValidationFileName(
        expectedScenario,
        record.rendererVersion,
        record.blackglassVersion,
        record.toolingSource.gitRevision!,
        record.artifacts.server.sourceRevision,
      ) ||
      qualification.artifacts?.releaseManifestSha256 !== record.artifacts.releaseManifestSha256 ||
      qualification.artifacts?.server?.sourceRevision !== record.artifacts.server.sourceRevision ||
      qualification.artifacts?.server?.sha256 !== record.artifacts.server.sha256 ||
      !isRecord(qualification.evidence) ||
      !isSha256(qualification.evidence.runManifestSha256) ||
      !isIsoDate(qualification.qualifiedAt)) {
      throw new Error("Release qualification does not bind the validation record artifacts");
    }
    return {
      observedAt: [qualification.qualifiedAt],
      runManifestSha256: qualification.evidence.runManifestSha256,
    };
  }
  if (value.schemaVersion !== 1 ||
    value.bridgeVersion !== record.blackglassVersion ||
    value.bridgeRevision !== record.toolingSource.gitRevision ||
    value.serverRevision !== record.artifacts.server.sourceRevision ||
    value.serverBinarySha256 !== record.artifacts.server.sha256 ||
    !isSha256(value.runManifestSha256) ||
    value.releaseManifestSha256 !== record.artifacts.releaseManifestSha256 ||
    value.validationFileName !== scenarioValidationFileName(
      expectedScenario,
      record.rendererVersion,
      record.blackglassVersion,
      record.toolingSource.gitRevision!,
      record.artifacts.server.sourceRevision,
    ) ||
    !isRecord(value.networkEvidence) ||
    JSON.stringify(Object.keys(value.networkEvidence).sort()) !==
      JSON.stringify(scenarioNetworkRoles({ scenarioId: value.scenarioId }).sort()) ||
    Object.values(value.networkEvidence).some((item: unknown) =>
      !isRecord(item) || !isIsoDate(item.startedAt) || !isIsoDate(item.completedAt) ||
      Date.parse(item.completedAt) < Date.parse(item.startedAt) ||
      !isSha256(item.evidenceSha256) || !isSha256(item.finalizeSha256)
    ) ||
    !Array.isArray(value.checkpoints)) {
    throw new Error(`Scenario report is incomplete for ${expectedScenario}`);
  }
  const expectedCheckpoints = e2eScenarioDefinition(expectedScenario).checkpoints;
  if (JSON.stringify(value.checkpoints.map((checkpoint: unknown) =>
    isRecord(checkpoint) ? checkpoint.checkpoint : undefined
  )) !== JSON.stringify(expectedCheckpoints)) {
    throw new Error(`Scenario report has wrong checkpoint order for ${expectedScenario}`);
  }
  const observedAt = value.checkpoints.map((checkpoint: unknown) => {
    if (!isRecord(checkpoint) || !isIsoDate(checkpoint.observedAt) ||
      !isSha256(checkpoint.proofSha256) || !isSha256(checkpoint.launchIdentitySha256) ||
      !isSha256(checkpoint.uiStateSha256) ||
      !isSha256(checkpoint.screenshotSha256) || !isSha256(checkpoint.databaseSha256)) {
      throw new Error(`Scenario report has malformed checkpoint time for ${expectedScenario}`);
    }
    return checkpoint.observedAt;
  });
  return { observedAt, runManifestSha256: value.runManifestSha256 };
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
