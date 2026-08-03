import { resolve } from "node:path";
import { readCurrentReleaseValidationRecords, type CurrentReleaseValidationRecord } from "./current-release-record";
import { assertGitRevision } from "./tooling-source";
import { verifyQualifiedTooling } from "./verify-qualified-tooling";
import { verifyCompatibilityMatrix, type Matrix } from "./compatibility-matrix";
import { createHash } from "node:crypto";

export function assertCurrentRecordsHaveExactMatrixRows(
  current: CurrentReleaseValidationRecord[],
  matrix: Matrix,
): void {
for (const item of current) {
  const record = item.record;
  const recordSha256 = createHash("sha256").update(item.bytes).digest("hex");
  const matches = matrix.entries.filter((row) =>
    row.rendererVersion === record.rendererVersion &&
    row.bridge.version === record.blackglassVersion &&
    row.bridge.revision === record.toolingSource.gitRevision &&
    row.server.version === record.artifacts.server.version &&
    row.server.revision === record.artifacts.server.sourceRevision &&
    row.upstreamArtifact.sha256 === record.source.officialDmgSha256 &&
    row.validationReport.path === `docs/validation/${item.name}` &&
    row.validationReport.sha256 === recordSha256
  );
  if (matches.length !== 1) {
    throw new Error(`Compatibility matrix does not exactly bind ${item.name}`);
  }
}
}

if (import.meta.main) {
  const [tagRevision, ...extra] = Bun.argv.slice(2);
  if (!tagRevision || extra.length !== 0) usage();
  assertGitRevision(tagRevision, "Qualified tag revision");

  const root = resolve(import.meta.dir, "..");
  const current = await readCurrentReleaseValidationRecords(root, "required");
  const matrix = await verifyCompatibilityMatrix(root);
  assertCurrentRecordsHaveExactMatrixRows(current, matrix);
  const verification = await verifyQualifiedTooling(current.map(({ path }) => path), tagRevision, root);

  console.log(JSON.stringify({ releaseEligible: true, ...verification }, null, 2));
}

function usage(): never {
  console.error(
    "Usage: bun run tools/verify-release-eligibility.ts <full-tag-commit>",
  );
  process.exit(2);
}
