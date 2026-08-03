import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  assertReleaseValidationRecord,
  releaseValidationRecordFileName,
} from "./release-validation";
import {
  assertGitRevision,
  assertQualificationBundleDescendant,
  computeToolingSourceIdentity,
  computeToolingSourceIdentityAtRevision,
  toolingSourceTreeEqual,
} from "./tooling-source";

export interface QualifiedToolingVerification {
  validated: true;
  validationRecords: string[];
  sourceRevision: string;
  tagRevision: string;
  toolingTreeSha256: string;
  files: number;
  fileBytes: number;
}

export async function verifyQualifiedTooling(
  recordArguments: string[],
  tagRevision: string,
  rootArgument = resolve(import.meta.dir, ".."),
): Promise<QualifiedToolingVerification> {
  assertGitRevision(tagRevision, "Qualified tag revision");

  const root = resolve(rootArgument);
  if (recordArguments.length === 0) throw new Error("Qualification requires validation records");
  const expectedDirectory = resolve(root, "docs/validation");
  const records = [];
  for (const recordArgument of recordArguments) {
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

  records.push({ recordPath, recordBytes, record });
  }
  const sourceRevision = records[0]!.record.toolingSource.gitRevision;
  if (!sourceRevision) throw new Error("Validation record has no tooling source revision");
  if (records.some(({ record }) => record.toolingSource.gitRevision !== sourceRevision)) {
    throw new Error("Qualification records bind different tooling source revisions");
  }
  const current = await computeToolingSourceIdentity(root);
  if (current.worktreeClean !== true || current.gitRevision !== tagRevision) {
    throw new Error("Qualified tooling verification requires a clean exact tag checkout");
  }
  const source = computeToolingSourceIdentityAtRevision(root, sourceRevision);
  const tag = computeToolingSourceIdentityAtRevision(root, tagRevision);
  if (
    records.some(({ record }) => !toolingSourceTreeEqual(record.toolingSource, source)) ||
    records.some(({ record }) => !toolingSourceTreeEqual(record.toolingSource, tag)) ||
    records.some(({ record }) => !toolingSourceTreeEqual(record.toolingSource, current))
  ) {
    throw new Error("Qualified tag tooling tree differs from the packaged and tested source");
  }
  const bundle = new Map<string, Uint8Array>();
  for (const { recordPath, recordBytes } of records) {
    bundle.set(`docs/validation/${basename(recordPath)}`, recordBytes);
  }
  for (const path of ["compatibility/matrix.json", "compatibility/MATRIX.md"]) {
    bundle.set(path, await readFile(resolve(root, path)));
  }
  assertQualificationBundleDescendant(root, sourceRevision, tagRevision, bundle);

  return {
    validated: true,
    validationRecords: records.map(({ recordPath }) => recordPath),
    sourceRevision,
    tagRevision,
    toolingTreeSha256: current.treeSha256,
    files: current.files,
    fileBytes: current.fileBytes,
  };
}

if (import.meta.main) {
  const [tagRevision, ...recordArguments] = Bun.argv.slice(2);
  if (!tagRevision || recordArguments.length === 0) usage();
  const result = await verifyQualifiedTooling(recordArguments, tagRevision);
  console.log(JSON.stringify(result, null, 2));
}

function usage(): never {
  console.error(
    "Usage: bun run tools/verify-qualified-tooling.ts " +
      "<full-tag-commit> <docs/validation/*-qualification.json>...",
  );
  process.exit(2);
}
