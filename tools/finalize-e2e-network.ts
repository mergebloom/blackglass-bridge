import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { verifyLiveClientLaunchBinding } from "./e2e-client";
import {
  assertNetworkCaptureFinalize,
  e2eNetworkEvidencePath,
  e2eNetworkFinalizePath,
  type E2EClientRole,
  type E2ENetworkCaptureFinalize,
} from "./e2e-network-evidence";
import { readPreparedE2ERun } from "./e2e-network";
import { canonicalOutputPath } from "./path-safety";

const [rootArgument, roleArgument, ...extraArguments] = Bun.argv.slice(2);
if (
  !rootArgument ||
  !["client-a", "client-b", "client-b-recovery"].includes(roleArgument ?? "") ||
  extraArguments.length !== 0
) {
  usage();
}
const role = roleArgument as E2EClientRole;
const run = await readPreparedE2ERun(rootArgument);
const launch = await verifyLiveClientLaunchBinding(
  resolve(run.root, `${role}-launch.json`),
);
if (launch.identity.runManifestSha256 !== run.manifestSha256) {
  throw new Error("Network finalizer client belongs to a different E2E run");
}
if (await Bun.file(e2eNetworkEvidencePath(run.root, role)).exists()) {
  throw new Error("Network evidence was already finalized");
}
const requestedOutputPath = e2eNetworkFinalizePath(run.root, role);
await mkdir(dirname(requestedOutputPath), { recursive: true });
const outputPath = await canonicalOutputPath(
  requestedOutputPath,
  "Network capture finalizer",
);

let record: E2ENetworkCaptureFinalize;
if (role === "client-b-recovery") {
  const resetPath = resolve(run.root, "source-loss-reset.json");
  const reportPath = resolve(run.root, "recovery-report.json");
  const statePath = resolve(run.root, "evidence/recovery/client-b-restored.json");
  const screenshotPath = resolve(run.root, "evidence/recovery/client-b-restored.png");
  const [resetBytes, reportBytes, stateBytes, screenshotBytes, launchBytes] =
    await Promise.all([
      readFile(resetPath),
      readFile(reportPath),
      readFile(statePath),
      readFile(screenshotPath),
      readFile(launch.identityPath),
    ]);
  const reset = JSON.parse(resetBytes.toString("utf8")) as any;
  const report = JSON.parse(reportBytes.toString("utf8")) as any;
  const state = JSON.parse(stateBytes.toString("utf8")) as any;
  const screenshotSha256 = sha256(screenshotBytes);
  if (
    reset.schemaVersion !== 1 ||
    report.schemaVersion !== 2 ||
    report.ok !== true ||
    state.schemaVersion !== 1 ||
    state.launchIdentitySha256 !== launch.identitySha256 ||
    state.screenshotSha256 !== screenshotSha256 ||
    report.recoveryClient?.identitySha256 !== launch.identitySha256 ||
    !Number.isFinite(Date.parse(String(reset.resetAt))) ||
    !Number.isFinite(Number(report.verifiedAt)) ||
    !Number.isFinite(Date.parse(String(state.observedAt))) ||
    Date.parse(launch.identity.startedAt) <= Date.parse(reset.resetAt) ||
    Number(report.verifiedAt) < Date.parse(state.observedAt)
  ) {
    throw new Error("Cold-recovery evidence is incomplete or not bound to the live client");
  }
  record = {
    schemaVersion: 1,
    role,
    phase: "cold-recovery",
    requestedAt: new Date().toISOString(),
    handshakeNotBefore: launch.identity.startedAt,
    runManifestSha256: run.manifestSha256,
    context: {
      sourceLossResetSha256: sha256(resetBytes),
      recoveryLaunchSha256: sha256(launchBytes),
      recoveryReportSha256: sha256(reportBytes),
      recoveryUiStateSha256: sha256(stateBytes),
      recoveryScreenshotSha256: screenshotSha256,
    },
  };
} else {
  const restartPath = resolve(run.root, "server-restarted.json");
  const restartBytes = await readFile(restartPath);
  const restart = JSON.parse(restartBytes.toString("utf8")) as any;
  if (
    restart.schemaVersion !== 1 ||
    !Number.isFinite(Date.parse(String(restart.startedAt))) ||
    !Number.isFinite(Date.parse(String(restart.readyAt))) ||
    restart.stoppedAt !== null
  ) {
    throw new Error("Restarted server identity is incomplete");
  }
  const observationNames = [
    "transfer-e2e-sync-proof.json",
    "transfer-reverse-sync-proof.json",
    "transfer-deletion-sync-proof.json",
    "delete-deletion-sync-proof.json",
  ] as const;
  const observationsSha256: Record<string, string> = {};
  const observations: any[] = [];
  for (const name of observationNames) {
    const bytes = await readFile(resolve(run.root, "observations", name));
    const value = JSON.parse(bytes.toString("utf8")) as any;
    if (
      value.schemaVersion !== 1 ||
      !Number.isFinite(Date.parse(String(value.observedAt)))
    ) {
      throw new Error(`Malformed Sync observation: ${name}`);
    }
    observationsSha256[name] = sha256(bytes);
    observations.push(value);
  }
  if (
    observations.slice(1).some(
      (observation) => Date.parse(observation.observedAt) <= Date.parse(restart.readyAt),
    )
  ) {
    throw new Error("Post-restart Sync observations are incomplete");
  }
  record = {
    schemaVersion: 1,
    role,
    phase: "post-restart",
    requestedAt: new Date().toISOString(),
    handshakeNotBefore: restart.readyAt,
    runManifestSha256: run.manifestSha256,
    context: {
      serverRestartIdentitySha256: sha256(restartBytes),
      observationsSha256,
    },
  };
}

assertNetworkCaptureFinalize(record, {
  role,
  runManifestSha256: run.manifestSha256,
});
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
if (((await stat(outputPath)).mode & 0o777) !== 0o600) {
  throw new Error("Network finalizer permissions are not owner-only");
}
console.log(JSON.stringify({ outputPath, record }, null, 2));

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function usage(): never {
  console.error(
    "Usage: bun run tools/finalize-e2e-network.ts <run-directory> " +
      "<client-a|client-b|client-b-recovery>",
  );
  process.exit(2);
}
