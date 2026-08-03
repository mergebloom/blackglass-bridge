import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyCompatibilityMatrix, type Matrix } from "./compatibility-matrix";
import { E2E_SCENARIO_IDS, parseE2EScenarioId } from "./e2e-scenario";
import {
  assertReleaseValidationRecord,
  type ReleaseQualification,
  type ReleaseValidationRecord,
} from "./release-validation";
import { stableJson } from "./stable-json";

const [recordArgument, releaseArgument, tenancyArgument, customArgument, managedArgument, ...extra] =
  Bun.argv.slice(2);
if (!recordArgument || !releaseArgument || !tenancyArgument || !customArgument ||
  !managedArgument || extra.length !== 0) usage();

const root = resolve(import.meta.dir, "..");
const matrix = await verifyCompatibilityMatrix(root);
const recordFile = await readRealJson(resolve(recordArgument), "release validation record");
assertReleaseValidationRecord(recordFile.value);
const record = recordFile.value;
const reports = await Promise.all([
  readRealJson(resolve(releaseArgument), "release qualification"),
  readRealJson(resolve(tenancyArgument), "tenancy report"),
  readRealJson(resolve(customArgument), "custom-E2EE report"),
  readRealJson(resolve(managedArgument), "managed-encryption report"),
]);
const reportScenarios = reports.map(({ value }, index) =>
  assertScenarioReport(value, E2E_SCENARIO_IDS[index]!, record),
);
if (reports[0]!.sha256 !== record.packagedClientE2E.qualificationSha256) {
  throw new Error("Release qualification differs from the validation record");
}
if (matrix.entries.some((entry) => entry.rendererVersion === record.rendererVersion)) {
  throw new Error(`Compatibility matrix already contains renderer ${record.rendererVersion}`);
}
const recordPath = `docs/validation/${recordFile.path.split("/").at(-1)}`;
if (resolve(root, recordPath) !== recordFile.path) {
  throw new Error("Validation record must be directly under this repository's docs/validation");
}
const observed = reportScenarios.flatMap((report) => report.observedAt);
observed.push(record.validatedAt);
observed.sort();
const entry: Matrix["entries"][number] = {
  rendererVersion: record.rendererVersion,
  upstreamArtifact: { kind: "official-dmg", sha256: record.source.officialDmgSha256 },
  bridge: {
    version: record.blackglassVersion,
    revision: record.toolingSource.gitRevision!,
  },
  server: {
    version: record.artifacts.server.version,
    revision: record.artifacts.server.sourceRevision,
  },
  platform: { operatingSystem: "macOS", architecture: "arm64" },
  scenarios: E2E_SCENARIO_IDS.map((id, index) => ({
    id,
    result: "passed" as const,
    reportSha256: reports[index]!.sha256,
  })),
  qualificationResult: "supported",
  validationReport: { path: recordPath, sha256: recordFile.sha256 },
  qualifiedAt: observed.at(-1)!,
  knownLimitations: [
    "Desktop Sync only",
    "Apple Silicon macOS only",
    "Locally generated app is ad-hoc signed and not notarized",
  ],
};
matrix.entries.push(entry);
matrix.entries.sort((left, right) => left.rendererVersion.localeCompare(right.rendererVersion, "en"));
await writeFile(
  resolve(root, "compatibility/matrix.json"),
  `${JSON.stringify(JSON.parse(stableJson(matrix)), null, 2)}\n`,
  { mode: 0o644 },
);
await verifyCompatibilityMatrix(root, "--write");
console.log(JSON.stringify({ added: entry, entries: matrix.entries.length }, null, 2));

function assertScenarioReport(
  value: unknown,
  expectedScenario: string,
  record: ReleaseValidationRecord,
): { observedAt: string[] } {
  if (!isRecord(value) || value.passed !== true || value.scenarioId !== expectedScenario ||
    value.rendererVersion !== record.rendererVersion ||
    value.serverRevision !== record.artifacts.server.sourceRevision) {
    throw new Error(`Scenario report does not bind ${expectedScenario} to the release artifacts`);
  }
  parseE2EScenarioId(value.scenarioId);
  if (expectedScenario === "E2E-RELEASE-SYNC-RECOVERY") {
    const qualification = value as unknown as ReleaseQualification;
    if (qualification.blackglassVersion !== record.blackglassVersion ||
      qualification.artifacts?.releaseManifestSha256 !== record.artifacts.releaseManifestSha256 ||
      qualification.artifacts?.server?.sha256 !== record.artifacts.server.sha256) {
      throw new Error("Release qualification does not bind the validation record artifacts");
    }
    return { observedAt: [qualification.qualifiedAt] };
  }
  if (value.schemaVersion !== 1 ||
    value.releaseManifestSha256 !== record.artifacts.releaseManifestSha256 ||
    !Array.isArray(value.checkpoints) || value.checkpoints.length === 0) {
    throw new Error(`Scenario report is incomplete for ${expectedScenario}`);
  }
  const observedAt = value.checkpoints.map((checkpoint) => {
    if (!isRecord(checkpoint) || typeof checkpoint.observedAt !== "string" ||
      !Number.isFinite(Date.parse(checkpoint.observedAt))) {
      throw new Error(`Scenario report has malformed checkpoint time for ${expectedScenario}`);
    }
    return checkpoint.observedAt;
  });
  return { observedAt };
}

async function readRealJson(path: string, label: string): Promise<{
  path: string;
  sha256: string;
  value: unknown;
}> {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`${label} must be a real file`);
  const bytes = await readFile(path);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    value: JSON.parse(bytes.toString("utf8")) as unknown,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function usage(): never {
  console.error(
    "Usage: bun run tools/write-compatibility-matrix-entry.ts " +
      "<validation-record> <release-qualification> <tenancy-report> " +
      "<custom-e2ee-report> <managed-encryption-report>",
  );
  process.exit(2);
}
