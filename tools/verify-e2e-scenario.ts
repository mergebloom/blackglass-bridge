import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readPreparedE2ERun } from "./e2e-network";
import {
  assertScenarioCheckpointEvidence,
  assertScenarioToolingSourceBound,
  scenarioCheckpointPaths,
  sha256,
} from "./e2e-scenario-evidence";
import {
  e2eScenarioDefinition,
  scenarioValidationFileName,
} from "./e2e-scenario";
import { inspectServerArtifact } from "./server-artifact";

const [rootArgument, ...extra] = Bun.argv.slice(2);
if (!rootArgument || extra.length !== 0) {
  console.error("Usage: bun run tools/verify-e2e-scenario.ts <prepared-run>");
  process.exit(2);
}

const run = await readPreparedE2ERun(rootArgument);
await assertScenarioToolingSourceBound({ root: run.root, run: run.manifest });
const scenario = e2eScenarioDefinition(run.manifest.scenarioId);
if (scenario.id === "E2E-RELEASE-SYNC-RECOVERY") {
  throw new Error("Use e2e:verify for the release Sync/recovery scenario");
}
const checkpoints = [];
let previousObservedAt = 0;
for (const checkpoint of scenario.checkpoints) {
  const paths = scenarioCheckpointPaths(run.root, checkpoint);
  const proofBytes = await readFile(paths.proof);
  const proof = JSON.parse(proofBytes.toString("utf8")) as unknown;
  const verified = await assertScenarioCheckpointEvidence(proof, {
    root: run.root,
    run: run.manifest,
    runManifestSha256: run.manifestSha256,
    checkpoint,
  });
  const observedAt = Date.parse(verified.observedAt);
  if (observedAt <= previousObservedAt) {
    throw new Error(`Scenario checkpoints are not in required order: ${checkpoint}`);
  }
  previousObservedAt = observedAt;
  for (const path of [paths.screenshot, paths.state, paths.proof]) {
    if (((await stat(path)).mode & 0o777) !== 0o600) {
      throw new Error(`Unsafe scenario evidence permissions: ${path}`);
    }
  }
  checkpoints.push({
    checkpoint,
    client: verified.client,
    observedAt: verified.observedAt,
    proofSha256: sha256(proofBytes),
    uiStateSha256: verified.uiStateSha256,
    screenshotSha256: verified.screenshotSha256,
    databaseSha256: verified.database.sha256,
  });
}

const serverRecord = JSON.parse(
  await readFile(resolve(run.root, "server-artifact.json"), "utf8"),
) as { binaryPath: string };
const server = await inspectServerArtifact(serverRecord.binaryPath);
const report = {
  schemaVersion: 1,
  passed: true,
  scenarioId: scenario.id,
  rendererVersion: String(run.manifest.rendererVersion),
  serverRevision: server.sourceRevision,
  runManifestSha256: run.manifestSha256,
  releaseManifestSha256: run.manifest.releaseManifestSha256,
  validationFileName: scenarioValidationFileName(
    scenario.id,
    String(run.manifest.rendererVersion),
    server.sourceRevision,
  ),
  checkpoints,
};
const output = resolve(run.root, "scenario-report.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ output, report }, null, 2));
