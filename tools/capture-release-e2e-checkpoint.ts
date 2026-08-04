import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  prepareCheckpointPublication,
  preserveFailedCheckpointCapture,
  publishCheckpoint,
} from "./checkpoint-publication";
import { verifyLiveClientLaunchBinding } from "./e2e-client";
import { readPreparedE2ERun } from "./e2e-network";
import {
  acquireCheckpointPublicationLease,
  releaseCheckpointPublicationLease,
} from "./e2e-run-lock";
import {
  E2E_UI_EVIDENCE_SCHEMA_VERSION,
  isBoundE2EUiSnapshotPage,
} from "./e2e-ui-evidence";
import { assertScenarioToolingSourceBound } from "./e2e-scenario-evidence";
import {
  RELEASE_UI_CHECKPOINT_PROOF_SCHEMA_VERSION,
  assertReleaseUiCheckpointContent,
  releaseUiCheckpoint,
  releaseUiCheckpoints,
  releaseUiCheckpointPaths,
  validateReleaseUiCheckpointChain,
} from "./release-e2e-ui";

const [rootArgument, checkpointArgument, portArgument, ...extra] = Bun.argv.slice(2);
const debugPort = Number(portArgument);
if (
  !rootArgument || !checkpointArgument || extra.length !== 0 ||
  !Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65_535
) {
  console.error(
    "Usage: bun run tools/capture-release-e2e-checkpoint.ts " +
      "<prepared-run> <evidence/client/checkpoint> <debug-port>",
  );
  process.exit(2);
}

const run = await readPreparedE2ERun(rootArgument);
if (run.manifest.scenarioId !== "E2E-RELEASE-SYNC-RECOVERY") {
  throw new Error("Release UI capture requires E2E-RELEASE-SYNC-RECOVERY");
}
await assertScenarioToolingSourceBound({ root: run.root, run: run.manifest });
const rendererVersion = String(run.manifest.rendererVersion ?? "");
const checkpoints = releaseUiCheckpoints(rendererVersion);
const checkpoint = releaseUiCheckpoint(checkpointArgument, rendererVersion);
const checkpointIndex = checkpoints.findIndex((item) => item.path === checkpoint.path);
const publicationLease = await acquireCheckpointPublicationLease(run.root, checkpoint.path);
try {
  const paths = releaseUiCheckpointPaths(run.root, checkpoint.path);
  let previousCheckpointProofSha256: string | null = null;
  if (checkpointIndex > 0) {
    const previous = checkpoints[checkpointIndex - 1]!;
    const validated = await validateReleaseUiCheckpointChain({
      root: run.root,
      rendererVersion,
      runManifestSha256: run.manifestSha256,
      releaseManifestSha256: run.manifest.releaseManifestSha256,
      throughPath: previous.path,
    });
    previousCheckpointProofSha256 = validated.get(previous.path)!;
  }
  await prepareCheckpointPublication(paths, run.root, checkpoint.path);
  const staging = await mkdtemp(join(dirname(paths.screenshot), ".checkpoint-capture-"));
  const staged = {
    screenshot: join(staging, "capture.png"),
    state: join(staging, "capture.json"),
    proof: join(staging, "capture.proof.json"),
  };
  let published = false;
  try {
  const child = Bun.spawn([
    process.execPath,
    "run",
    new URL("./e2e-ui.mjs", import.meta.url).pathname,
    String(debugPort),
    "snapshot",
    staged.screenshot,
    staged.state,
  ], { cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`UI checkpoint capture failed with exit code ${exitCode}`);

  const stateBytes = await readFile(staged.state);
  const state = JSON.parse(stateBytes.toString("utf8")) as Record<string, any>;
  const screenshotBytes = await readFile(staged.screenshot);
  const screenshotStat = await stat(staged.screenshot);
  const binding = await verifyLiveClientLaunchBinding(String(state.launchIdentityPath ?? ""));
  assertReleaseUiCheckpointContent(checkpoint, state, binding.identity.startedAt);
  const observedAt = Date.parse(String(state.observedAt ?? ""));
  if (
    state.schemaVersion !== E2E_UI_EVIDENCE_SCHEMA_VERSION ||
    state.runManifestSha256 !== run.manifestSha256 ||
    state.releaseManifestSha256 !== run.manifest.releaseManifestSha256 ||
    state.launchIdentityPath !== binding.identityPath ||
    state.launchIdentitySha256 !== binding.identitySha256 ||
    state.launchedPid !== binding.identity.pid ||
    state.debugPort !== debugPort ||
    state.debugListenerPid !== binding.identity.debugListenerPid ||
    state.debugTargetId !== binding.identity.debugTargetId ||
    state.profilePath !== binding.identity.profilePath ||
    state.vaultPath !== binding.identity.vaultPath ||
    state.rendererPageCount !== 1 ||
    state.visibleRendererPageCount !== 1 ||
    !isBoundE2EUiSnapshotPage(state, binding.identity.debugTargetUrl) ||
    state.screenshotPath !== staged.screenshot ||
    state.screenshotSha256 !== sha256(screenshotBytes) ||
    binding.identity.profilePath !== resolve(run.root, checkpoint.client, "user-data") ||
    binding.identity.vaultPath !== resolve(run.root, checkpoint.client, "vault") ||
    binding.identity.debugPort !== debugPort ||
    screenshotStat.size < 1024 ||
    !isPng(screenshotBytes) ||
    !Number.isFinite(observedAt) ||
    observedAt > Date.now() + 5_000 ||
    Math.abs(screenshotStat.mtimeMs - observedAt) > 30_000
  ) {
    throw new Error(`Release UI checkpoint is not bound to ${checkpoint.client}`);
  }
  state.screenshotPath = paths.screenshot;
  const finalStateBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  await writeFile(staged.state, finalStateBytes, { mode: 0o600 });
  const proof = {
    schemaVersion: RELEASE_UI_CHECKPOINT_PROOF_SCHEMA_VERSION,
    scenarioId: "E2E-RELEASE-SYNC-RECOVERY",
    checkpoint: checkpoint.path,
    client: checkpoint.client,
    observedAt: state.observedAt,
    previousCheckpointProofSha256,
    runManifestSha256: run.manifestSha256,
    releaseManifestSha256: run.manifest.releaseManifestSha256,
    launchIdentitySha256: binding.identitySha256,
    uiStateSha256: sha256(finalStateBytes),
    screenshotSha256: sha256(screenshotBytes),
  };
  await writeFile(staged.proof, `${JSON.stringify(proof, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await Promise.all([chmod(staged.screenshot, 0o600), chmod(staged.state, 0o600)]);
  await publishCheckpoint(staged, paths);
  published = true;
  console.log(JSON.stringify({ checkpoint: checkpoint.path, proof: paths.proof }, null, 2));
  } catch (error) {
    if (!published) {
      await preserveFailedCheckpointCapture(staging, run.root, checkpoint.path, error);
    }
    throw error;
  } finally {
    if (published) await rm(staging, { recursive: true, force: false });
  }
} finally {
  await releaseCheckpointPublicationLease(publicationLease, checkpoint.path);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPng(bytes: Buffer): boolean {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return false;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width >= 640 && height >= 400 && width <= 16_384 && height <= 16_384;
}
