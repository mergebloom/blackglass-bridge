import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readClientLaunchIdentity,
  verifyLiveClientLaunchBinding,
} from "./e2e-client";
import {
  assertNetworkEvidence,
  e2eNetworkEvidencePath,
  e2eNetworkFinalizePath,
  type E2EClientRole,
  type E2ENetworkCaptureFinalize,
} from "./e2e-network-evidence";
import { readPreparedE2ERun } from "./e2e-network";
import { inspectMacOSArtifact, publicMacOSArtifact } from "./macos-artifact";
import {
  assertFinderLaunchSmokeEvidence,
  finderLaunchSmokeLayout,
} from "./macos-launch-smoke";
import { readVerifiedE2ETls } from "./e2e-tls";
import { pathExists } from "./path-safety";
import {
  assertCanonicalRecoveryCorpusIdentity,
  assertCanonicalRecoveryCorpusManifest,
} from "./recovery-corpus";
import { inspectServerArtifact, publicServerArtifact } from "./server-artifact";
import { readBridgeReleaseManifest } from "./release-manifest";
import {
  assertRecoveryReportResetBinding,
  assertSourceLossResetRecord,
} from "./source-loss-reset";
import {
  computeToolingSourceIdentity,
  toolingSourceTreeEqual,
} from "./tooling-source";

const [rootArgument, ...flags] = Bun.argv.slice(2);
if (!rootArgument || flags.length !== 0) {
  console.error("Usage: bun run tools/qualify-e2e.ts <run-directory>");
  process.exit(2);
}

const preparedRun = await readPreparedE2ERun(rootArgument);
const root = preparedRun.root;
const { manifest: releaseManifest } = await readBridgeReleaseManifest(
  resolve(root, preparedRun.manifest.releaseManifestFileName),
);
const currentToolingSource = await computeToolingSourceIdentity();
if (
  releaseManifest.toolingSource.worktreeClean !== true ||
  currentToolingSource.worktreeClean !== true ||
  releaseManifest.toolingSource.gitRevision !== currentToolingSource.gitRevision ||
  !toolingSourceTreeEqual(releaseManifest.toolingSource, currentToolingSource)
) {
  throw new Error(
    "E2E qualification tooling source differs from the clean packaged source",
  );
}

const [
  runManifest,
  syncReport,
  recoveryManifest,
  recoveryReport,
  recordedClient,
  recordedServer,
] = await Promise.all([
  readJson("run-manifest.json"),
  readJson("report.json"),
  readJson("recovery-manifest.json"),
  readJson("recovery-report.json"),
  readJson("client-artifact.json"),
  readJson("server-artifact.json"),
]);

if (
  runManifest.schemaVersion !== 2 ||
  syncReport.schemaVersion !== 2 ||
  syncReport.passed !== true ||
  recoveryManifest.schemaVersion !== 3 ||
  recoveryReport.schemaVersion !== 3 ||
  recoveryReport.ok !== true
) {
  throw new Error("E2E qualification inputs are incomplete or did not pass");
}
assertCanonicalRecoveryCorpusIdentity(recoveryManifest.corpus);
assertCanonicalRecoveryCorpusManifest(recoveryManifest.files);
assertCanonicalRecoveryCorpusIdentity(recoveryReport.corpus);
if (
  !Array.isArray(syncReport.observations) ||
  syncReport.observations.length !== 4 ||
  !Array.isArray(syncReport.uxEvidence) ||
  syncReport.uxEvidence.length !== 6 ||
  !Array.isArray(syncReport.networkEvidence) ||
  syncReport.networkEvidence.length !== 2 ||
  new Set(syncReport.networkEvidence.map((item: any) => item?.role)).size !== 2 ||
  syncReport.networkEvidence.some(
    (item: any) =>
      item?.requirements?.successfulDataHandshake !== true ||
      item?.requirements?.successfulLifecycleDataHandshake !== true ||
      !/^[a-f0-9]{64}$/u.test(String(item?.finalizeSha256 ?? "")) ||
      item?.requirements?.controlRoutes?.length !==
        item?.requirements?.successfulControlRoutes?.length,
  ) ||
  syncReport.server?.initialProcess?.gracefulShutdown !== true ||
  syncReport.server?.restartedProcess?.stoppedAt !== null
) {
  throw new Error("Sync report lacks transfer, deletion, UX, or restart evidence");
}
if (
  recoveryReport.clientAExists !== false ||
  recoveryReport.databaseRegressed !== false ||
  !Number.isSafeInteger(recoveryReport.expectedFiles) ||
  recoveryReport.expectedFiles !== recoveryManifest.files.length ||
  recoveryReport.expectedFiles < recoveryReport.corpus.files ||
  recoveryReport.restoredFiles !== recoveryReport.expectedFiles ||
  recoveryReport.missing?.length !== 0 ||
  recoveryReport.unexpected?.length !== 0 ||
  recoveryReport.changed?.length !== 0
) {
  throw new Error("Recovery report does not prove complete source-loss restoration");
}

const runManifestSha256 = await fileSha256("run-manifest.json");
const syncReportSha256 = await fileSha256("report.json");
const recoveryManifestSha256 = await fileSha256("recovery-manifest.json");
const serverArtifactFileSha256 = await fileSha256("server-artifact.json");
if (
  recoveryManifest.runManifestSha256 !== runManifestSha256 ||
  recoveryManifest.syncReportSha256 !== syncReportSha256 ||
  recoveryManifest.serverArtifactSha256 !== serverArtifactFileSha256 ||
  recoveryReport.runManifestSha256 !== runManifestSha256 ||
  recoveryReport.syncReportSha256 !== syncReportSha256 ||
  recoveryReport.serverArtifactSha256 !== serverArtifactFileSha256
) {
  throw new Error("Recovery evidence is not bound to the exact Sync run");
}

const generatedAt = Date.parse(syncReport.generatedAt);
const capturedAt = Date.parse(recoveryManifest.capturedAt);
const verifiedAt = Number(recoveryReport.verifiedAt);
if (
  !Number.isFinite(generatedAt) ||
  !Number.isFinite(capturedAt) ||
  !Number.isFinite(verifiedAt) ||
  generatedAt >= capturedAt ||
  capturedAt >= verifiedAt
) {
  throw new Error("Sync and destructive recovery evidence is not chronologically ordered");
}

const [currentClient, currentServer] = await Promise.all([
  inspectMacOSArtifact(recordedClient.appPath),
  inspectServerArtifact(recordedServer.binaryPath),
]);
if (
  JSON.stringify(publicMacOSArtifact(currentClient)) !==
    JSON.stringify(publicMacOSArtifact(recordedClient)) ||
  JSON.stringify(publicServerArtifact(currentServer)) !==
    JSON.stringify(publicServerArtifact(recordedServer))
) {
  throw new Error("A qualified client or server artifact changed after the E2E run");
}
const finderSmokePath = finderLaunchSmokeLayout(root).evidencePath;
const verifiedTls = await readVerifiedE2ETls(root);
const finderSmokeBytes = await readFile(finderSmokePath);
const finderSmoke = JSON.parse(finderSmokeBytes.toString("utf8")) as unknown;
assertFinderLaunchSmokeEvidence(finderSmoke, {
  root,
  runManifestSha256: preparedRun.manifestSha256,
  releaseManifestSha256: preparedRun.manifest.releaseManifestSha256,
  appPath: recordedClient.appPath,
  artifact: publicMacOSArtifact(recordedClient),
  controlOrigin: preparedRun.manifest.endpoints.controlOrigin,
  tlsMetadataSha256: verifiedTls.metadataSha256,
  chromiumHostResolverRules: verifiedTls.metadata.chromiumHostResolverRules,
  tlsSpkiSha256Base64: verifiedTls.metadata.spkiSha256Base64,
  nativeHomePath: homedir(),
});
if (((await stat(finderSmokePath)).mode & 0o777) !== 0o600) {
  throw new Error("Unsafe Finder launch smoke evidence permissions");
}
if (
  syncReport.referenceClient?.releaseManifestSha256 !==
    runManifest.releaseManifestSha256 ||
  syncReport.referenceClient?.compatibilityAsarSha256 !==
    runManifest.compatibilityAsarSha256 ||
  syncReport.server?.artifact?.sha256 !== recordedServer.sha256 ||
  syncReport.referenceClient?.app?.applicationTreeSha256 !==
    publicMacOSArtifact(recordedClient).applicationTreeSha256
) {
  throw new Error("E2E reports are inconsistent with the exact prepared artifacts");
}

const rawNetworkEvidence: Record<E2EClientRole, string> = {
  "client-a": "",
  "client-b": "",
  "client-b-recovery": "",
};
const rawNetworkFinalizers: Record<E2EClientRole, string> = {
  "client-a": "",
  "client-b": "",
  "client-b-recovery": "",
};
const restartedServerSha256 = sha256(await readFile(resolve(root, "server-restarted.json")));
const observationNames = [
  "transfer-e2e-sync-proof.json",
  "transfer-reverse-sync-proof.json",
  "transfer-deletion-sync-proof.json",
  "delete-deletion-sync-proof.json",
] as const;
const observationHashes: Record<string, string> = {};
let latestObservationAt = 0;
for (const name of observationNames) {
  const bytes = await readFile(resolve(root, "observations", name));
  const value = JSON.parse(bytes.toString("utf8")) as any;
  const observedAt = Date.parse(String(value.observedAt));
  if (!Number.isFinite(observedAt)) throw new Error(`Malformed Sync observation: ${name}`);
  observationHashes[name] = sha256(bytes);
  latestObservationAt = Math.max(latestObservationAt, observedAt);
}
for (const role of ["client-a", "client-b"] as const) {
  const identityPath = resolve(root, `${role}-launch.json`);
  const identityBytes = await readFile(identityPath);
  const identity = await readClientLaunchIdentity(identityPath);
  if (Date.parse(identity.startedAt) <= Date.parse(finderSmoke.completedAt)) {
    throw new Error("Finder launch smoke must complete before packaged E2E clients launch");
  }
  const identitySha256 = sha256(identityBytes);
  const path = e2eNetworkEvidencePath(root, role);
  const finalizePath = e2eNetworkFinalizePath(root, role);
  const finalizeBytes = await readFile(finalizePath);
  const finalize = JSON.parse(finalizeBytes.toString("utf8")) as E2ENetworkCaptureFinalize;
  const finalizeSha256 = sha256(finalizeBytes);
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  assertNetworkEvidence(value, {
    role,
    run: preparedRun.manifest,
    runManifestSha256: preparedRun.manifestSha256,
    identityPath,
    identitySha256,
    identity,
    finalizePath,
    finalizeSha256,
    finalize,
  });
  const evidenceSha256 = sha256(bytes);
  const summary = syncReport.networkEvidence.find((item: any) => item?.role === role);
  const context = finalize.context as any;
  if (
    !summary ||
    summary.path !== `evidence/network-${role}.json` ||
    summary.sha256 !== evidenceSha256 ||
    summary.finalizeSha256 !== finalizeSha256 ||
    finalize.phase !== "post-restart" ||
    context.serverRestartIdentitySha256 !== restartedServerSha256 ||
    JSON.stringify(context.observationsSha256) !== JSON.stringify(observationHashes) ||
    Date.parse((value as any).completedAt) <= latestObservationAt ||
    ((await stat(path)).mode & 0o777) !== 0o600 ||
    ((await stat(identityPath)).mode & 0o777) !== 0o600 ||
    ((await stat(finalizePath)).mode & 0o777) !== 0o600
  ) {
    throw new Error(`Raw ${role} network evidence changed after Sync verification`);
  }
  rawNetworkEvidence[role] = evidenceSha256;
  rawNetworkFinalizers[role] = finalizeSha256;
}

const recoveryIdentityPath = resolve(root, "client-b-recovery-launch.json");
const recoveryIdentityBytes = await readFile(recoveryIdentityPath);
const recoveryBinding = await verifyLiveClientLaunchBinding(recoveryIdentityPath);
const recoveryIdentitySha256 = sha256(recoveryIdentityBytes);
const recoveryFinalizePath = e2eNetworkFinalizePath(root, "client-b-recovery");
const recoveryFinalizeBytes = await readFile(recoveryFinalizePath);
const recoveryFinalize = JSON.parse(
  recoveryFinalizeBytes.toString("utf8"),
) as E2ENetworkCaptureFinalize;
const recoveryFinalizeSha256 = sha256(recoveryFinalizeBytes);
const recoveryNetworkPath = e2eNetworkEvidencePath(root, "client-b-recovery");
const recoveryNetworkBytes = await readFile(recoveryNetworkPath);
const recoveryNetwork = JSON.parse(recoveryNetworkBytes.toString("utf8")) as unknown;
assertNetworkEvidence(recoveryNetwork, {
  role: "client-b-recovery",
  run: preparedRun.manifest,
  runManifestSha256: preparedRun.manifestSha256,
  identityPath: recoveryBinding.identityPath,
  identitySha256: recoveryBinding.identitySha256,
  identity: recoveryBinding.identity,
  finalizePath: recoveryFinalizePath,
  finalizeSha256: recoveryFinalizeSha256,
  finalize: recoveryFinalize,
});
const sourceLossResetBytes = await readFile(resolve(root, "source-loss-reset.json"));
const sourceLossReset = JSON.parse(sourceLossResetBytes.toString("utf8")) as any;
const sourceLossResetSha256 = sha256(sourceLossResetBytes);
assertSourceLossResetRecord(sourceLossReset, {
  runManifestSha256,
  syncReportSha256,
  recoveryManifestSha256,
  compatibilityAsarSha256: preparedRun.manifest.compatibilityAsarSha256,
  profilePath: resolve(root, "client-b/user-data"),
  vaultPath: resolve(root, "client-b/vault"),
});
assertRecoveryReportResetBinding(recoveryReport, {
  recoveryManifestSha256,
  sourceLossResetSha256,
  resetAt: sourceLossReset.resetAt,
});
if (
  await pathExists(resolve(root, ".source-loss-reset.lock")) ||
  await pathExists(resolve(root, ".source-loss-trash"))
) {
  throw new Error("Cold-recovery source-loss transition is still active");
}
for (const client of ["client-a", "client-b"] as const) {
  const retired = sourceLossReset.retiredRuntimeHomes?.[client];
  const identityBytes = await readFile(resolve(root, `${client}-launch.json`));
  if (
    retired?.identitySha256 !== sha256(identityBytes) ||
    typeof retired?.blackglassHomePath !== "string" ||
    !/^\/private\/tmp\/blackglass-client-[A-Za-z0-9]{6}\/h$/u.test(
      retired.blackglassHomePath,
    ) ||
    retired.runtimeHomeRemoved !== true ||
    await pathExists(retired.blackglassHomePath)
  ) {
    throw new Error(`Cold-recovery evidence did not retire ${client} BLACKGLASS_HOME`);
  }
}
const recoveryUiStateBytes = await readFile(
  resolve(root, "evidence/recovery/client-b-restored.json"),
);
const recoveryScreenshotBytes = await readFile(
  resolve(root, "evidence/recovery/client-b-restored.png"),
);
const recoveryReportBytes = await readFile(resolve(root, "recovery-report.json"));
const recoveryUiState = JSON.parse(recoveryUiStateBytes.toString("utf8")) as any;
const recoveryContext = recoveryFinalize.context as any;
if (
  Date.parse(recoveryBinding.identity.startedAt) <= Date.parse(sourceLossReset.resetAt) ||
  recoveryFinalize.phase !== "cold-recovery" ||
  recoveryFinalize.handshakeNotBefore !== recoveryBinding.identity.startedAt ||
  recoveryContext.sourceLossResetSha256 !== sourceLossResetSha256 ||
  recoveryContext.recoveryLaunchSha256 !== recoveryIdentitySha256 ||
  recoveryContext.recoveryReportSha256 !== sha256(recoveryReportBytes) ||
  recoveryContext.recoveryUiStateSha256 !== sha256(recoveryUiStateBytes) ||
  recoveryContext.recoveryScreenshotSha256 !== sha256(recoveryScreenshotBytes) ||
  recoveryReport.recoveryClient?.identitySha256 !== recoveryIdentitySha256 ||
  recoveryUiState.launchIdentitySha256 !== recoveryIdentitySha256 ||
  recoveryUiState.screenshotSha256 !== sha256(recoveryScreenshotBytes) ||
  Date.parse((recoveryNetwork as any).completedAt) < Number(recoveryReport.verifiedAt) ||
  Date.parse((recoveryNetwork as any).completedAt) < Date.parse(recoveryUiState.observedAt)
) {
  throw new Error("Cold-recovery network and UI evidence are not one bound lifecycle");
}
rawNetworkEvidence["client-b-recovery"] = sha256(recoveryNetworkBytes);
rawNetworkFinalizers["client-b-recovery"] = recoveryFinalizeSha256;

for (const file of [
  "run-manifest.json",
  "report.json",
  "recovery-manifest.json",
  "recovery-report.json",
  "client-artifact.json",
  "server-artifact.json",
  "server-restarted.json",
  "finder-launch-smoke.json",
  "observations/transfer-e2e-sync-proof.json",
  "observations/transfer-reverse-sync-proof.json",
  "observations/transfer-deletion-sync-proof.json",
  "observations/delete-deletion-sync-proof.json",
  "source-loss-reset.json",
  "client-b-recovery-launch.json",
  "evidence/recovery/client-b-restored.json",
  "evidence/recovery/client-b-restored.png",
  "evidence/network-client-b-recovery.json",
  "evidence/network-client-b-recovery.finalize.json",
]) {
  if (((await stat(resolve(root, file))).mode & 0o777) !== 0o600) {
    throw new Error(`Unsafe E2E evidence permissions: ${file}`);
  }
}

const qualification = {
  schemaVersion: 6,
  qualifiedAt: new Date().toISOString(),
  passed: true,
  platform: "macOS Apple Silicon",
  bridgeVersion: runManifest.bridgeVersion,
  rendererVersion: runManifest.rendererVersion,
  endpoints: runManifest.endpoints,
  toolingSource: releaseManifest.toolingSource,
  artifacts: {
    client: publicMacOSArtifact(recordedClient),
    compatibilityAsarSha256: runManifest.compatibilityAsarSha256,
    releaseManifestSha256: runManifest.releaseManifestSha256,
    server: publicServerArtifact(recordedServer),
  },
  workflow: {
    generatedBackgroundTransfers: 3,
    bidirectionalSync: true,
    propagatedDeletion: true,
    gracefulServerRestart: true,
    postRestartSync: true,
    sourceClientRemoved: true,
    coldRecovery: true,
    finderLaunchServicesSmoke: true,
    defaultProfileIsolation: true,
    starterNoVaultFlow: true,
    starterControlRouting: true,
    noLaunchCrashOrEarlyExit: true,
  },
  recovery: {
    expectedFiles: recoveryReport.expectedFiles,
    restoredFiles: recoveryReport.restoredFiles,
    corpus: recoveryReport.corpus,
    missing: 0,
    unexpected: 0,
    changed: 0,
  },
  evidence: {
    runManifestSha256,
    syncReportSha256,
    recoveryManifestSha256,
    recoveryReportSha256: await fileSha256("recovery-report.json"),
    sourceLossResetSha256,
    recoveryLaunchSha256: recoveryIdentitySha256,
    recoveryUiStateSha256: sha256(recoveryUiStateBytes),
    recoveryScreenshotSha256: sha256(recoveryScreenshotBytes),
    finderLaunchSmokeSha256: sha256(finderSmokeBytes),
    networkEvidenceSha256: rawNetworkEvidence,
    networkFinalizeSha256: rawNetworkFinalizers,
  },
};

const output = resolve(root, "qualification.json");
await writeFile(output, `${JSON.stringify(qualification, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify(qualification, null, 2));

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(resolve(root, file), "utf8"));
}

async function fileSha256(file: string): Promise<string> {
  return sha256(await readFile(resolve(root, file)));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
