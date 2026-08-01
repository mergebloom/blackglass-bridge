import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  e2eNetworkEvidencePath,
  e2eNetworkFinalizePath,
  type E2EClientRole,
} from "./e2e-network-evidence";
import { readPreparedE2ERun } from "./e2e-network";
import {
  assertNoSymlinkSegments,
  assertPathWithin,
  canonicalExistingPath,
  canonicalOutputPath,
} from "./path-safety";
import { parseBridgeReleaseManifest } from "./release-manifest";
import {
  loadCompatibilityBaseline,
} from "./release-compatibility";
import { macOSCodeInventoriesEqual } from "./macos-code-inventory";
import {
  buildReleaseValidationRecord,
  releaseValidationRecordFileName,
  type ReleaseQualification,
} from "./release-validation";

const [rootArgument, outputArgument, ...extraArguments] = Bun.argv.slice(2);
if (!rootArgument || !outputArgument || extraArguments.length !== 0) usage();

const run = await readPreparedE2ERun(rootArgument);
const validationRoot = await canonicalExistingPath(
  resolve(import.meta.dir, "../docs/validation"),
  "Validation records directory",
  "directory",
);
const output = await canonicalOutputPath(outputArgument, "Validation record");
assertPathWithin(output, validationRoot, "Validation record");
if (dirname(output) !== validationRoot) {
  throw new Error("Validation record must be directly inside docs/validation");
}
await assertNoSymlinkSegments(validationRoot, dirname(output), "Validation record parent");

const releaseManifestPath = await canonicalExistingPath(
  resolve(run.root, run.manifest.releaseManifestFileName),
  "Prepared release manifest",
  "file",
);
await assertNoSymlinkSegments(run.root, releaseManifestPath, "Prepared release manifest");
const releaseManifestBytes = await readFile(releaseManifestPath);
const releaseManifestSha256 = sha256(releaseManifestBytes);
if (releaseManifestSha256 !== run.manifest.releaseManifestSha256) {
  throw new Error("Prepared release manifest changed after the E2E run was created");
}
const manifest = parseBridgeReleaseManifest(releaseManifestBytes);
const repositoryRoot = resolve(import.meta.dir, "..");
const loadedBaseline = await loadCompatibilityBaseline(
  resolve(
    repositoryRoot,
    `compatibility/obsidian-${manifest.rendererVersion}.json`,
  ),
);
if (
  manifest.compatibilityBaseline.id !== loadedBaseline.baseline.id ||
  manifest.compatibilityBaseline.schemaVersion !== loadedBaseline.baseline.schemaVersion ||
  manifest.compatibilityBaseline.sha256 !== loadedBaseline.sha256 ||
  !macOSCodeInventoriesEqual(
    manifest.source.macOSCodeInventory,
    loadedBaseline.baseline.sourceMacOSCodeInventory,
  )
) {
  throw new Error(
    "Prepared release manifest does not bind the repository compatibility baseline inventory",
  );
}

const qualificationPath = await canonicalExistingPath(
  resolve(run.root, "qualification.json"),
  "E2E qualification",
  "file",
);
await assertNoSymlinkSegments(run.root, qualificationPath, "E2E qualification");
const qualificationBytes = await readFile(qualificationPath);
const qualification = JSON.parse(qualificationBytes.toString("utf8")) as ReleaseQualification;
if (qualification.artifacts?.releaseManifestSha256 !== releaseManifestSha256) {
  throw new Error("Qualification does not bind the prepared release manifest");
}

const evidenceFiles = {
  runManifestSha256: "run-manifest.json",
  syncReportSha256: "report.json",
  recoveryManifestSha256: "recovery-manifest.json",
  recoveryReportSha256: "recovery-report.json",
  sourceLossResetSha256: "source-loss-reset.json",
  recoveryLaunchSha256: "client-b-recovery-launch.json",
  recoveryUiStateSha256: "evidence/recovery/client-b-restored.json",
  recoveryScreenshotSha256: "evidence/recovery/client-b-restored.png",
  finderLaunchSmokeSha256: "finder-launch-smoke.json",
  clientReproducibilitySha256: run.manifest.reproducibilityEvidenceFileName,
} as const;
for (const [field, file] of Object.entries(evidenceFiles) as Array<
  [keyof typeof evidenceFiles, (typeof evidenceFiles)[keyof typeof evidenceFiles]]
>) {
  if (qualification.evidence?.[field] !== sha256(await readFile(resolve(run.root, file)))) {
    throw new Error(`Qualification evidence changed after generation: ${file}`);
  }
}
for (const role of ["client-a", "client-b", "client-b-recovery"] as E2EClientRole[]) {
  const evidencePath = e2eNetworkEvidencePath(run.root, role);
  const finalizePath = e2eNetworkFinalizePath(run.root, role);
  if (
    qualification.evidence?.networkEvidenceSha256?.[role] !==
    sha256(await readFile(evidencePath))
  ) {
    throw new Error(`Qualification network evidence changed after generation: ${evidencePath}`);
  }
  if (
    qualification.evidence?.networkFinalizeSha256?.[role] !==
    sha256(await readFile(finalizePath))
  ) {
    throw new Error(`Qualification network finalizer changed after generation: ${finalizePath}`);
  }
}

const expectedName = releaseValidationRecordFileName(
  manifest.bridgeVersion,
  manifest.rendererVersion,
);
if (basename(output) !== expectedName) {
  throw new Error(`Validation record must be named ${expectedName}`);
}
const record = buildReleaseValidationRecord({
  manifest,
  qualification,
  qualificationSha256: sha256(qualificationBytes),
});
await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, {
  flag: "wx",
  mode: 0o644,
});
console.log(JSON.stringify({ output, record }, null, 2));

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function usage(): never {
  console.error(
    "Usage: bun run tools/write-validation-record.ts <qualified-E2E-run> " +
      "<docs/validation/blackglass-bridge-VERSION-obsidian-VERSION-qualification.json>",
  );
  process.exit(2);
}
