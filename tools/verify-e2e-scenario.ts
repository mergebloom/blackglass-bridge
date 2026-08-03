import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readClientLaunchIdentity } from "./e2e-client";
import {
  assertNetworkCaptureFinalize,
  assertNetworkEvidence,
  assertScenarioNetworkLaunchBinding,
  e2eNetworkEvidencePath,
  e2eNetworkFinalizePath,
  e2eNetworkLaunchIdentityFile,
  scenarioNetworkRoles,
  type E2EClientRole,
} from "./e2e-network-evidence";
import { readPreparedE2ERun } from "./e2e-network";
import { assertNoCheckpointPublicationLeases } from "./e2e-run-lock";
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
import { readBlackglassReleaseManifest } from "./release-manifest";

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
await assertNoCheckpointPublicationLeases(run.root);
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
    launchIdentitySha256: verified.launchIdentitySha256,
    uiStateSha256: verified.uiStateSha256,
    screenshotSha256: verified.screenshotSha256,
    databaseSha256: verified.database.sha256,
  });
}

const firstCheckpointObservedAt = checkpoints[0]?.observedAt;
const finalCheckpoint = scenario.checkpoints.at(-1);
if (!firstCheckpointObservedAt || !finalCheckpoint) {
  throw new Error("Scenario has no complete checkpoint interval");
}
const finalCheckpointProofSha256 = checkpoints.at(-1)?.proofSha256;
if (!finalCheckpointProofSha256) throw new Error("Scenario final checkpoint proof is missing");
const networkEvidence: Record<string, {
  startedAt: string;
  completedAt: string;
  evidenceSha256: string;
  finalizeSha256: string;
}> = {};
for (const role of scenarioNetworkRoles(run.manifest)) {
  const boundCheckpoint = role === "client-b-initial"
    ? scenario.checkpoints.at(-2)
    : finalCheckpoint;
  if (!boundCheckpoint) throw new Error(`Scenario network role has no checkpoint: ${role}`);
  const boundProofSha256 = checkpoints.find(
    (checkpoint) => checkpoint.checkpoint === boundCheckpoint,
  )?.proofSha256;
  if (!boundProofSha256) throw new Error(`Scenario network checkpoint is missing: ${role}`);
  const boundIndex = scenario.checkpoints.indexOf(boundCheckpoint);
  const evidencePath = e2eNetworkEvidencePath(run.root, role);
  const finalizePath = e2eNetworkFinalizePath(run.root, role);
  const [evidenceBytes, finalizeBytes, launch] = await Promise.all([
    readFile(evidencePath),
    readFile(finalizePath),
    readLaunch(resolve(run.root, e2eNetworkLaunchIdentityFile(role))),
  ]);
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as any;
  const finalize = JSON.parse(finalizeBytes.toString("utf8")) as any;
  assertNetworkCaptureFinalize(finalize, { role, runManifestSha256: run.manifestSha256 });
  if (
    finalize.phase !== "scenario-complete" ||
    (finalize.context as any).scenarioId !== scenario.id ||
    (finalize.context as any).finalCheckpoint !== boundCheckpoint ||
    (finalize.context as any).finalCheckpointProofSha256 !== boundProofSha256 ||
    Date.parse(finalize.requestedAt) < Date.parse(
      checkpoints.find((checkpoint) => checkpoint.checkpoint === boundCheckpoint)!.observedAt,
    )
  ) {
    throw new Error(`Scenario network finalizer is not bound to the final checkpoint: ${role}`);
  }
  assertScenarioNetworkLaunchBinding(
    role,
    launch.identitySha256,
    checkpoints,
    boundIndex,
  );
  const evidenceSha256 = sha256(evidenceBytes);
  const finalizeSha256 = sha256(finalizeBytes);
  assertNetworkEvidence(evidence, {
    role,
    run: run.manifest,
    runManifestSha256: run.manifestSha256,
    identityPath: launch.identityPath,
    identitySha256: launch.identitySha256,
    identity: launch.identity,
    finalizePath,
    finalizeSha256,
    finalize,
  });
  if (role !== "client-b-cold" &&
    Date.parse(evidence.startedAt) > Date.parse(firstCheckpointObservedAt)) {
    throw new Error(`Scenario network capture started after the first checkpoint: ${role}`);
  }
  for (const path of [evidencePath, finalizePath]) {
    if (((await stat(path)).mode & 0o777) !== 0o600) {
      throw new Error(`Unsafe scenario network evidence permissions: ${path}`);
    }
  }
  networkEvidence[role] = {
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt,
    evidenceSha256,
    finalizeSha256,
  };
}

const serverRecord = JSON.parse(
  await readFile(resolve(run.root, "server-artifact.json"), "utf8"),
) as { binaryPath: string };
const server = await inspectServerArtifact(serverRecord.binaryPath);
const { manifest: releaseManifest } = await readBlackglassReleaseManifest(
  resolve(run.root, run.manifest.releaseManifestFileName),
);
if (!releaseManifest.toolingSource.gitRevision) {
  throw new Error("Scenario release manifest is not bound to a Bridge revision");
}
const report = {
  schemaVersion: 1,
  passed: true,
  scenarioId: scenario.id,
  rendererVersion: String(run.manifest.rendererVersion),
  bridgeVersion: releaseManifest.blackglassVersion,
  bridgeRevision: releaseManifest.toolingSource.gitRevision,
  serverRevision: server.sourceRevision,
  serverBinarySha256: server.sha256,
  runManifestSha256: run.manifestSha256,
  releaseManifestSha256: run.manifest.releaseManifestSha256,
  validationFileName: scenarioValidationFileName(
    scenario.id,
    String(run.manifest.rendererVersion),
    releaseManifest.blackglassVersion,
    releaseManifest.toolingSource.gitRevision,
    server.sourceRevision,
  ),
  networkEvidence,
  checkpoints,
};
const output = resolve(run.root, "scenario-report.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ output, report }, null, 2));

async function readLaunch(path: string): Promise<{
  identityPath: string;
  identitySha256: string;
  identity: Awaited<ReturnType<typeof readClientLaunchIdentity>>;
}> {
  const bytes = await readFile(path);
  return {
    identityPath: path,
    identitySha256: sha256(bytes),
    identity: await readClientLaunchIdentity(path),
  };
}
