import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyCompatibilityMatrix, type Matrix } from "./compatibility-matrix";
import { validateMatrixScenarioReport } from "./compatibility-matrix-entry";
import { E2E_SCENARIO_IDS, scenarioValidationFileName } from "./e2e-scenario";
import { assertReleaseValidationRecord } from "./release-validation";
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
  validateMatrixScenarioReport(value, E2E_SCENARIO_IDS[index]!, record),
);
for (const [index, report] of reports.entries()) {
  const expectedName = scenarioValidationFileName(
    E2E_SCENARIO_IDS[index]!,
    record.rendererVersion,
    record.blackglassVersion,
    record.toolingSource.gitRevision!,
    record.artifacts.server.sourceRevision,
  );
  if (report.path.split("/").at(-1) !== expectedName) {
    throw new Error(`Scenario report must be named ${expectedName}`);
  }
}
if (new Set(reportScenarios.map((report) => report.runManifestSha256)).size !== E2E_SCENARIO_IDS.length) {
  throw new Error("Every compatibility scenario must come from its own immutable prepared run");
}
if (reports[0]!.sha256 !== record.packagedClientE2E.qualificationSha256) {
  throw new Error("Release qualification differs from the validation record");
}
if (matrix.entries.some((entry) =>
  entry.rendererVersion === record.rendererVersion &&
  entry.bridge.revision === record.toolingSource.gitRevision &&
  entry.server.revision === record.artifacts.server.sourceRevision
)) {
  throw new Error(`Compatibility matrix already contains this exact renderer/Bridge/Server combination`);
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
  scenarios: E2E_SCENARIO_IDS.map((id, index) => {
    const report = reports[index]!;
    const reportPath = `docs/validation/${report.path.split("/").at(-1)}`;
    if (resolve(root, reportPath) !== report.path) {
      throw new Error("Scenario reports must be directly under docs/validation");
    }
    return { id, result: "passed" as const, report: { path: reportPath, sha256: report.sha256 } };
  }),
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

function usage(): never {
  console.error(
    "Usage: bun run tools/write-compatibility-matrix-entry.ts " +
      "<validation-record> <release-qualification> <tenancy-report> " +
      "<custom-e2ee-report> <managed-encryption-report>",
  );
  process.exit(2);
}
