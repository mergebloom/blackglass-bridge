import { resolve } from "node:path";
import { readCurrentReleaseValidationRecord } from "./current-release-record";
import { assertGitRevision } from "./tooling-source";
import { verifyQualifiedTooling } from "./verify-qualified-tooling";

const [tagRevision, ...extra] = Bun.argv.slice(2);
if (!tagRevision || extra.length !== 0) usage();
assertGitRevision(tagRevision, "Qualified tag revision");

const root = resolve(import.meta.dir, "..");
const current = await readCurrentReleaseValidationRecord(root, "required");
if (!current) throw new Error("Release eligibility requires a qualification record");
const verification = await verifyQualifiedTooling(current.path, tagRevision, root);

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
