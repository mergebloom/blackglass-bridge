import { resolve } from "node:path";
import { readCurrentReleaseValidationRecords } from "./current-release-record";
import { assertGitRevision } from "./tooling-source";
import { verifyQualifiedTooling } from "./verify-qualified-tooling";
import { verifyCompatibilityMatrix } from "./compatibility-matrix";
import { createHash } from "node:crypto";

const [tagRevision, ...extra] = Bun.argv.slice(2);
if (!tagRevision || extra.length !== 0) usage();
assertGitRevision(tagRevision, "Qualified tag revision");

const root = resolve(import.meta.dir, "..");
const current = await readCurrentReleaseValidationRecords(root, "required");
const matrix = await verifyCompatibilityMatrix(root);
if (matrix.entries.length !== current.length) {
  throw new Error("Compatibility matrix must contain exactly one row per current qualification record");
}
for (const item of current) {
  const record = item.record;
  const row = matrix.entries.find((entry) => entry.rendererVersion === record.rendererVersion);
  if (
    !row ||
    row.bridge.version !== record.blackglassVersion ||
    row.bridge.revision !== record.toolingSource.gitRevision ||
    row.server.version !== record.artifacts.server.version ||
    row.server.revision !== record.artifacts.server.sourceRevision ||
    row.upstreamArtifact.sha256 !== record.source.officialDmgSha256 ||
    row.validationReport.path !== `docs/validation/${item.name}` ||
    row.validationReport.sha256 !== createHash("sha256").update(item.bytes).digest("hex")
  ) {
    throw new Error(`Compatibility matrix does not exactly bind ${item.name}`);
  }
}
const verification = await verifyQualifiedTooling(current.map(({ path }) => path), tagRevision, root);

console.log(
  JSON.stringify(
    {
      releaseEligible: true,
      ...verification,
    },
    null,
    2,
  ),
);

function usage(): never {
  console.error(
    "Usage: bun run tools/verify-release-eligibility.ts <full-tag-commit>",
  );
  process.exit(2);
}
