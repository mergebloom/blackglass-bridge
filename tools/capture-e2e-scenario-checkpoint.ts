import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readPreparedE2ERun } from "./e2e-network";
import {
  acquireCheckpointPublicationLease,
  releaseCheckpointPublicationLease,
} from "./e2e-run-lock";
import {
  assertScenarioCheckpointEvidence,
  assertScenarioToolingSourceBound,
  buildScenarioCheckpointEvidence,
  scenarioCheckpointPaths,
} from "./e2e-scenario-evidence";
import {
  e2eScenarioCheckpointDefinition,
  e2eScenarioDefinition,
} from "./e2e-scenario";
import {
  fileExists,
  prepareCheckpointPublication,
  preserveFailedCheckpointCapture,
  publishCheckpoint,
} from "./checkpoint-publication";

const [rootArgument, checkpoint, portArgument, ...extra] = Bun.argv.slice(2);
const debugPort = Number(portArgument);
if (
  !rootArgument ||
  !checkpoint ||
  extra.length !== 0 ||
  !Number.isInteger(debugPort) ||
  debugPort < 1024 ||
  debugPort > 65_535
) {
  console.error(
    "Usage: bun run tools/capture-e2e-scenario-checkpoint.ts " +
      "<prepared-run> <checkpoint> <debug-port>",
  );
  process.exit(2);
}

const run = await readPreparedE2ERun(rootArgument);
await assertScenarioToolingSourceBound({ root: run.root, run: run.manifest });
const scenario = e2eScenarioDefinition(run.manifest.scenarioId);
e2eScenarioCheckpointDefinition(scenario.id, checkpoint);
const checkpointIndex = scenario.checkpoints.indexOf(checkpoint);
if (checkpointIndex > 0) {
  const previousCheckpoint = scenario.checkpoints[checkpointIndex - 1];
  if (!previousCheckpoint) throw new Error("Scenario checkpoint order is malformed");
  const previousProof = JSON.parse(
    await readFile(scenarioCheckpointPaths(run.root, previousCheckpoint).proof, "utf8"),
  );
  await assertScenarioCheckpointEvidence(previousProof, {
    root: run.root,
    run: run.manifest,
    runManifestSha256: run.manifestSha256,
    checkpoint: previousCheckpoint,
  });
}
const paths = scenarioCheckpointPaths(run.root, checkpoint);
const publicationLease = await acquireCheckpointPublicationLease(run.root, checkpoint);
try {
  await prepareCheckpointPublication(paths, run.root, checkpoint);
  const staging = await mkdtemp(join(dirname(paths.screenshot), ".checkpoint-capture-"));
  const stagedScreenshot = join(staging, "capture.png");
  const stagedState = join(staging, "capture.json");
  const stagedProof = join(staging, "capture.proof.json");
  let published = false;
  try {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      new URL("./e2e-ui.mjs", import.meta.url).pathname,
      String(debugPort),
      "snapshot",
      stagedScreenshot,
      stagedState,
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`UI checkpoint capture failed with exit code ${exitCode}`);

const state = JSON.parse(await readFile(stagedState, "utf8")) as Record<string, unknown>;
state.screenshotPath = paths.screenshot;
await writeFile(stagedState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

const evidence = await buildScenarioCheckpointEvidence({
  root: run.root,
  run: run.manifest,
  runManifestSha256: run.manifestSha256,
  checkpoint,
  capturePaths: { screenshot: stagedScreenshot, state: stagedState },
});
await writeFile(stagedProof, `${JSON.stringify(evidence, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
await Promise.all([chmod(stagedScreenshot, 0o600), chmod(stagedState, 0o600)]);
await publishCheckpoint(
  { screenshot: stagedScreenshot, state: stagedState, proof: stagedProof },
  paths,
);
published = true;
console.log(JSON.stringify({ scenarioId: scenario.id, checkpoint, proof: paths.proof }, null, 2));
  } catch (error) {
    if (!published) await preserveFailedCheckpointCapture(staging, run.root, checkpoint, error);
    throw error;
  } finally {
    if (published) await rm(staging, { recursive: true, force: false });
  }
} finally {
  await releaseCheckpointPublicationLease(publicationLease, checkpoint);
}
