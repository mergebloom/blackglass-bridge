import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  assertReleaseValidationRecord,
  releaseValidationRecordFileName,
} from "./release-validation";
import {
  assertGitRevision,
  assertValidationOnlyDescendant,
  computeToolingSourceIdentity,
  computeToolingSourceIdentityAtRevision,
  toolingSourceTreeEqual,
} from "./tooling-source";

export interface QualifiedToolingVerification {
  validated: true;
  validationRecord: string;
  sourceRevision: string;
  tagRevision: string;
  toolingTreeSha256: string;
  files: number;
  fileBytes: number;
}

export async function verifyQualifiedTooling(
  recordArgument: string,
  tagRevision: string,
  rootArgument = resolve(import.meta.dir, ".."),
): Promise<QualifiedToolingVerification> {
  assertGitRevision(tagRevision, "Qualified tag revision");

  const root = resolve(rootArgument);
  const expectedDirectory = resolve(root, "docs/validation");
  const recordPath = resolve(root, recordArgument);
  if (dirname(recordPath) !== expectedDirectory) {
    throw new Error("Validation record must be directly under docs/validation");
  }
  if ((await realpath(dirname(recordPath))) !== (await realpath(expectedDirectory))) {
    throw new Error("Validation record directory does not resolve canonically");
  }
  const recordStat = await lstat(recordPath);
  if (recordStat.isSymbolicLink() || !recordStat.isFile()) {
    throw new Error("Validation record must be a real file");
  }
  const recordBytes = await readFile(recordPath);
  const record = JSON.parse(recordBytes.toString("utf8")) as unknown;
  assertReleaseValidationRecord(record);
  const expectedName = releaseValidationRecordFileName(
    record.blackglassVersion,
    record.rendererVersion,
  );
  if (basename(recordPath) !== expectedName) {
    throw new Error(`Validation record must be named ${expectedName}`);
  }

  const sourceRevision = record.toolingSource.gitRevision;
  if (!sourceRevision) throw new Error("Validation record has no tooling source revision");
  const current = await computeToolingSourceIdentity(root);
  if (current.worktreeClean !== true || current.gitRevision !== tagRevision) {
    throw new Error("Qualified tooling verification requires a clean exact tag checkout");
  }
  const source = computeToolingSourceIdentityAtRevision(root, sourceRevision);
  const tag = computeToolingSourceIdentityAtRevision(root, tagRevision);
  if (
    !toolingSourceTreeEqual(record.toolingSource, source) ||
    !toolingSourceTreeEqual(record.toolingSource, tag) ||
    !toolingSourceTreeEqual(record.toolingSource, current)
  ) {
    throw new Error("Qualified tag tooling tree differs from the packaged and tested source");
  }
  assertValidationOnlyDescendant(
    root,
    sourceRevision,
    tagRevision,
    `docs/validation/${expectedName}`,
    recordBytes,
  );

  return {
    validated: true,
    validationRecord: recordPath,
    sourceRevision,
    tagRevision,
    toolingTreeSha256: current.treeSha256,
    files: current.files,
    fileBytes: current.fileBytes,
  };
}

if (import.meta.main) {
  const [recordArgument, tagRevision, ...extra] = Bun.argv.slice(2);
  if (!recordArgument || !tagRevision || extra.length !== 0) usage();
  const result = await verifyQualifiedTooling(recordArgument, tagRevision);
  console.log(JSON.stringify(result, null, 2));
}

function usage(): never {
  console.error(
    "Usage: bun run tools/verify-qualified-tooling.ts " +
      "<docs/validation/*-qualification.json> <full-tag-commit>",
  );
  process.exit(2);
}
