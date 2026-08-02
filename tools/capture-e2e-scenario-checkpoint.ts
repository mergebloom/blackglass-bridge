import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readPreparedE2ERun } from "./e2e-network";
import {
  buildScenarioCheckpointEvidence,
  scenarioCheckpointPaths,
} from "./e2e-scenario-evidence";
import {
  e2eScenarioCheckpointDefinition,
  e2eScenarioDefinition,
} from "./e2e-scenario";

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
const scenario = e2eScenarioDefinition(run.manifest.scenarioId);
e2eScenarioCheckpointDefinition(scenario.id, checkpoint);
const checkpointIndex = scenario.checkpoints.indexOf(checkpoint);
if (checkpointIndex > 0) {
  const previousCheckpoint = scenario.checkpoints[checkpointIndex - 1];
  if (!previousCheckpoint) throw new Error("Scenario checkpoint order is malformed");
  await readFile(
    scenarioCheckpointPaths(run.root, previousCheckpoint).proof,
  );
}
const paths = scenarioCheckpointPaths(run.root, checkpoint);
await mkdir(dirname(paths.screenshot), { recursive: true, mode: 0o700 });

const child = Bun.spawn(
  [
    process.execPath,
    "run",
    new URL("./e2e-ui.mjs", import.meta.url).pathname,
    String(debugPort),
    "snapshot",
    paths.screenshot,
    paths.state,
  ],
  { cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" },
);
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`UI checkpoint capture failed with exit code ${exitCode}`);

const evidence = await buildScenarioCheckpointEvidence({
  root: run.root,
  run: run.manifest,
  runManifestSha256: run.manifestSha256,
  checkpoint,
});
await writeFile(paths.proof, `${JSON.stringify(evidence, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
await Promise.all([chmod(paths.screenshot, 0o600), chmod(paths.state, 0o600)]);
console.log(JSON.stringify({ scenarioId: scenario.id, checkpoint, proof: paths.proof }, null, 2));
