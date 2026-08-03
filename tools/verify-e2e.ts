import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  type ClientLaunchIdentity,
  type LiveClientLaunchBinding,
  verifyLiveClientLaunchBinding,
} from "./e2e-client";
import {
  assertNetworkEvidence,
  e2eNetworkEvidencePath,
  e2eNetworkFinalizePath,
  type E2ENetworkCaptureFinalize,
  type E2ENetworkEvidence,
} from "./e2e-network-evidence";
import { readPreparedE2ERun } from "./e2e-network";
import { assertNoObservationPublicationResidue } from "./observation-publication";
import { E2E_UI_EVIDENCE_SCHEMA_VERSION } from "./e2e-ui-evidence";
import { preparedE2EScenarioId } from "./e2e-scenario";
import {
  inspectServerArtifact,
  publicServerArtifact,
  type ServerArtifact,
} from "./server-artifact";
import {
  inspectMacOSArtifact,
  publicMacOSArtifact,
  type MacOSArtifact,
} from "./macos-artifact";
import { parseBlackglassReleaseManifest } from "./release-manifest";
import { isSupportedStableSemver } from "./semver";
import { stableJson } from "./stable-json";
import { readPackagedBridgeConfig } from "./launcher-runtime";
import {
  assertMacOSReproducibilityEvidenceBinds,
  parseMacOSReproducibilityEvidence,
} from "./verify-macos-reproducibility";

const rootArgument = Bun.argv[2];
if (!rootArgument) {
  console.error("Usage: bun run tools/verify-e2e.ts <run-directory>");
  process.exit(2);
}

const preparedRun = await readPreparedE2ERun(rootArgument);
const root = preparedRun.root;
const runManifest = preparedRun.manifest as typeof preparedRun.manifest & {
  schemaVersion: number;
  blackglassVersion: string;
  rendererVersion: string;
  adapterFileName: string;
  compatibilityAsarSha256: string;
  releaseManifestFileName: string;
  releaseManifestSha256: string;
  endpoints: { controlOrigin: string; dataHost: string };
  explicitUserDataDirRequired: boolean;
};
if (
  runManifest.schemaVersion !== 5 ||
  !isRendererAdapterFileName(runManifest.adapterFileName) ||
  runManifest.releaseManifestFileName !== "blackglass-release-manifest.json" ||
  !/^[a-f0-9]{64}$/u.test(runManifest.releaseManifestSha256) ||
  runManifest.explicitUserDataDirRequired !== true
) {
  throw new Error("Unsupported or malformed E2E run manifest");
}

function isRendererAdapterFileName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefix = "obsidian-";
  const suffix = ".asar";
  return (
    value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    isSupportedStableSemver(value.slice(prefix.length, -suffix.length))
  );
}
const releaseManifestPath = resolve(root, runManifest.releaseManifestFileName);
const releaseManifestBytes = Buffer.from(await Bun.file(releaseManifestPath).arrayBuffer());
if (sha256(releaseManifestBytes) !== runManifest.releaseManifestSha256) {
  throw new Error("The bound Blackglass release manifest changed after E2E preparation");
}
const releaseManifest = parseBlackglassReleaseManifest(releaseManifestBytes);
if (
  releaseManifest.blackglassVersion !== runManifest.blackglassVersion ||
  releaseManifest.rendererVersion !== runManifest.rendererVersion ||
  releaseManifest.renderer.patchedSha256 !==
    runManifest.compatibilityAsarSha256 ||
  JSON.stringify(releaseManifest.endpoints) !==
    JSON.stringify(runManifest.endpoints) ||
  releaseManifest.launchPolicy.profileMode !== 0o700 ||
  releaseManifest.launchPolicy.explicitUserDataDir !== true ||
  releaseManifest.launchPolicy.blackglassHomeEnvironment !== "BLACKGLASS_HOME" ||
  releaseManifest.launchPolicy.nativeHomePreserved !== true ||
  releaseManifest.launchPolicy.exactOfficialAppVerifiedAtEveryLaunch !== true ||
  releaseManifest.launchPolicy.officialChildSupervisionRequired !== true
) {
  throw new Error("E2E run manifest is inconsistent with the Blackglass release manifest");
}
const recordedServer = JSON.parse(
  await readFile(resolve(root, "server-artifact.json"), "utf8"),
) as ServerArtifact;
const recordedClient = JSON.parse(
  await readFile(resolve(root, "client-artifact.json"), "utf8"),
) as MacOSArtifact;
const currentServer = await inspectServerArtifact(recordedServer.binaryPath);
if (
  JSON.stringify(publicServerArtifact(currentServer)) !==
  JSON.stringify(publicServerArtifact(recordedServer))
) {
  throw new Error("The server binary changed after this E2E run started");
}
const initialServer = await readServerIdentity(resolve(root, "server-initial.json"));
const restartedServer = await readServerIdentity(resolve(root, "server-restarted.json"));
const recordedServerPublic = publicServerArtifact(recordedServer);
for (const identity of [initialServer, restartedServer]) {
  if (
    JSON.stringify(publicServerArtifact(identity.artifact)) !==
      JSON.stringify(recordedServerPublic) ||
    identity.expectedSourceRevision !== recordedServer.sourceRevision ||
    identity.binaryPath !== recordedServer.binaryPath ||
    identity.databasePath !== resolve(root, "server.sqlite") ||
    identity.stagingPath !== resolve(root, "uploads") ||
    identity.controlOrigin !== runManifest.endpoints.controlOrigin ||
    identity.dataHost !== runManifest.endpoints.dataHost
  ) {
    throw new Error("Server process identity is inconsistent with the prepared E2E run");
  }
}
if (
  initialServer.pid === restartedServer.pid ||
  initialServer.gracefulShutdown !== true ||
  initialServer.exitCode !== 0 ||
  typeof initialServer.stoppedAt !== "string" ||
  restartedServer.stoppedAt !== null ||
  restartedServer.exitCode !== null ||
  restartedServer.gracefulShutdown !== null ||
  Date.parse(initialServer.readyAt) >= Date.parse(initialServer.stoppedAt) ||
  Date.parse(initialServer.stoppedAt) >= Date.parse(restartedServer.startedAt) ||
  Date.parse(restartedServer.startedAt) > Date.parse(restartedServer.readyAt)
) {
  throw new Error("E2E server restart identities do not prove a clean process replacement");
}
try {
  process.kill(restartedServer.pid, 0);
} catch {
  throw new Error("Restarted E2E server process is no longer running");
}
const liveReady = await fetch(
  `http://${runManifest.network.control.upstreamHost}:${runManifest.network.control.upstreamPort}/ready`,
);
if (!liveReady.ok) throw new Error("Restarted E2E server is not ready");
const currentClient = await inspectMacOSArtifact(recordedClient.appPath);
const launchConfig = await readPackagedBridgeConfig(recordedClient.appPath);
if (
  JSON.stringify(publicMacOSArtifact(currentClient)) !==
  JSON.stringify(publicMacOSArtifact(recordedClient))
) {
  throw new Error("The packaged macOS app changed after this E2E run was prepared");
}
if (
  JSON.stringify(publicMacOSArtifact(recordedClient)) !==
  JSON.stringify(releaseManifest.macOS)
) {
  throw new Error("The E2E client does not match the bound Blackglass release manifest");
}
const reproducibilityPath = resolve(
  root,
  runManifest.reproducibilityEvidenceFileName,
);
const reproducibilityBytes = await readFile(reproducibilityPath);
if (sha256(reproducibilityBytes) !== runManifest.reproducibilityEvidenceSha256) {
  throw new Error("The macOS reproducibility evidence changed after E2E preparation");
}
assertMacOSReproducibilityEvidenceBinds(
  parseMacOSReproducibilityEvidence(reproducibilityBytes),
  {
    manifest: releaseManifest,
    releaseManifestSha256: runManifest.releaseManifestSha256,
    artifact: publicMacOSArtifact(currentClient),
  },
);
const clientLaunchIdentities = new Map<string, ClientLaunchIdentity>();
const liveClientBindings = new Map<string, LiveClientLaunchBinding>();
for (const client of ["client-a", "client-b"] as const) {
  const identityPath = resolve(root, `${client}-launch.json`);
  const liveBinding = await verifyLiveClientLaunchBinding(identityPath);
  const identity = liveBinding.identity;
  const publicClient = publicMacOSArtifact(recordedClient);
  const expectedProfile = resolve(root, client, "user-data");
  const expectedVault = resolve(root, client, "vault");
  const expectedAdapter = resolve(expectedProfile, runManifest.adapterFileName);
  if (
    identity.runManifestSha256 !== preparedRun.manifestSha256 ||
    identity.releaseManifestSha256 !== runManifest.releaseManifestSha256 ||
    identity.launcherExecutablePath !==
      resolve(recordedClient.appPath, "Contents/MacOS", recordedClient.executableName) ||
    identity.launcherExecutableSha256 !== recordedClient.executableSha256 ||
    identity.officialAppPath !== launchConfig.officialAppPath ||
    identity.executablePath !==
      resolve(launchConfig.officialAppPath, "Contents/MacOS", launchConfig.officialExecutableName) ||
    identity.executableSha256 !== recordedClient.officialExecutableSha256 ||
    identity.appBundlePath !== recordedClient.appPath ||
    identity.appArtifactSha256 !== sha256(Buffer.from(stableJson(publicClient))) ||
    stableJson(identity.appArtifact) !== stableJson(publicClient) ||
    identity.adapterPath !== expectedAdapter ||
    identity.adapterSha256 !== runManifest.compatibilityAsarSha256 ||
    identity.profilePath !== expectedProfile ||
    identity.vaultPath !== expectedVault ||
    identity.tlsMetadataPath !== resolve(root, "tls-metadata.json") ||
    identity.tlsMetadataSha256 !== await fileSha256(identity.tlsMetadataPath) ||
    ((await stat(identityPath)).mode & 0o777) !== 0o600
  ) {
    throw new Error(`Client process identity is inconsistent with the E2E run: ${client}`);
  }
  clientLaunchIdentities.set(client, identity);
  liveClientBindings.set(client, liveBinding);
}
if (
  clientLaunchIdentities.get("client-a")!.pid ===
    clientLaunchIdentities.get("client-b")!.pid ||
  clientLaunchIdentities.get("client-a")!.launcherPid ===
    clientLaunchIdentities.get("client-b")!.launcherPid ||
  clientLaunchIdentities.get("client-a")!.debugPort ===
    clientLaunchIdentities.get("client-b")!.debugPort
) {
  throw new Error("E2E evidence did not use two distinct client processes and ports");
}

const networkEvidence: Array<{
  role: "client-a" | "client-b";
  path: string;
  sha256: string;
  startedAt: string;
  completedAt: string;
  eventCount: number;
  requirements: E2ENetworkEvidence["requirements"];
  finalizePath: string;
  finalizeSha256: string;
}> = [];
const networkFinalizers = new Map<
  "client-a" | "client-b",
  { record: E2ENetworkCaptureFinalize; sha256: string }
>();
for (const client of ["client-a", "client-b"] as const) {
  const path = e2eNetworkEvidencePath(root, client);
  const finalizePath = e2eNetworkFinalizePath(root, client);
  const finalizeBytes = await readFile(finalizePath);
  const finalize = JSON.parse(finalizeBytes.toString("utf8")) as E2ENetworkCaptureFinalize;
  const finalizeSha256 = sha256(finalizeBytes);
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  const binding = liveClientBindings.get(client)!;
  assertNetworkEvidence(value, {
    role: client,
    run: runManifest,
    runManifestSha256: preparedRun.manifestSha256,
    identityPath: binding.identityPath,
    identitySha256: binding.identitySha256,
    identity: binding.identity,
    finalizePath,
    finalizeSha256,
    finalize,
  });
  if (
    ((await stat(path)).mode & 0o777) !== 0o600 ||
    ((await stat(finalizePath)).mode & 0o777) !== 0o600
  ) {
    throw new Error(`Unsafe E2E network evidence permissions: ${path}`);
  }
  networkFinalizers.set(client, { record: finalize, sha256: finalizeSha256 });
  networkEvidence.push({
    role: client,
    path: path.slice(root.length + 1),
    sha256: sha256(bytes),
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    eventCount: value.events.length,
    requirements: value.requirements,
    finalizePath: finalizePath.slice(root.length + 1),
    finalizeSha256,
  });
}

const proofPairs = [
  {
    direction: "client-a-to-client-b",
    source: resolve(root, "client-a/vault/E2E Sync Proof.md"),
    destination: resolve(root, "client-b/vault/E2E Sync Proof.md"),
  },
  {
    direction: "client-b-to-client-a",
    source: resolve(root, "client-b/vault/Reverse Sync Proof.md"),
    destination: resolve(root, "client-a/vault/Reverse Sync Proof.md"),
  },
] as const;

const proofs = [];
for (const pair of proofPairs) {
  const source = Buffer.from(await Bun.file(pair.source).arrayBuffer());
  const destination = Buffer.from(await Bun.file(pair.destination).arrayBuffer());
  const sourceSha256 = sha256(source);
  const destinationSha256 = sha256(destination);
  if (!source.equals(destination)) {
    throw new Error(`${pair.direction} did not converge byte-for-byte`);
  }
  proofs.push({
    direction: pair.direction,
    bytes: source.byteLength,
    sourceSha256,
    destinationSha256,
    identical: true,
  });
}

const observationSpecifications = [
  {
    file: "transfer-e2e-sync-proof.json",
    action: "transfer",
    sourceClient: "client-a",
    destinationClient: "client-b",
    relativePath: "E2E Sync Proof.md",
  },
  {
    file: "transfer-reverse-sync-proof.json",
    action: "transfer",
    sourceClient: "client-b",
    destinationClient: "client-a",
    relativePath: "Reverse Sync Proof.md",
  },
  {
    file: "transfer-deletion-sync-proof.json",
    action: "transfer",
    sourceClient: "client-a",
    destinationClient: "client-b",
    relativePath: "Deletion Sync Proof.md",
  },
  {
    file: "delete-deletion-sync-proof.json",
    action: "delete",
    sourceClient: "client-a",
    destinationClient: "client-b",
    relativePath: "Deletion Sync Proof.md",
  },
] as const;
const observations = [];
const observationHashes: Record<string, string> = {};
await assertNoObservationPublicationResidue(root);
for (const specification of observationSpecifications) {
  const path = resolve(root, "observations", specification.file);
  const observationBytes = await readFile(path);
  const observation = JSON.parse(observationBytes.toString("utf8")) as SyncObservation;
  validateObservation(observation, specification, path);
  if (((await stat(path)).mode & 0o777) !== 0o600) {
    throw new Error(`Unsafe E2E observation permissions: ${path}`);
  }
  observationHashes[specification.file] = sha256(observationBytes);
  observations.push(observation);
}
for (let index = 1; index < observations.length; index += 1) {
  const previous = observations[index - 1]!;
  const current = observations[index]!;
  if (
    Date.parse(current.observedAt) <= Date.parse(previous.observedAt) ||
    current.databaseBefore.revisions < previous.databaseAfter.revisions ||
    current.databaseBefore.maxUid < previous.databaseAfter.maxUid ||
    current.databaseBefore.vaultVersion < previous.databaseAfter.vaultVersion
  ) {
    throw new Error("Automated Sync observations are not an ordered, monotonic sequence");
  }
}
if (
  Date.parse(observations[0]!.observedAt) >= Date.parse(initialServer.stoppedAt) ||
  observations.slice(1).some(
    (observation) =>
      Date.parse(observation.observedAt) <= Date.parse(restartedServer.readyAt),
  )
) {
  throw new Error("Sync observations do not straddle the proven server restart");
}
const restartedServerSha256 = await fileSha256(resolve(root, "server-restarted.json"));
const latestObservationAt = Math.max(
  ...observations.map((observation) => Date.parse(observation.observedAt)),
);
for (const evidence of networkEvidence) {
  const finalizer = networkFinalizers.get(evidence.role)!.record;
  if (
    finalizer.phase !== "post-restart" ||
    finalizer.handshakeNotBefore !== restartedServer.readyAt ||
    (finalizer.context as any).serverRestartIdentitySha256 !== restartedServerSha256 ||
    stableJson((finalizer.context as any).observationsSha256) !==
      stableJson(observationHashes) ||
    Date.parse(evidence.completedAt) <= latestObservationAt
  ) {
    throw new Error("Network capture does not span the full post-restart Sync lifecycle");
  }
}
const observedTransfers = new Map(
  observations
    .filter((observation) => observation.action === "transfer")
    .map((observation) => [observation.relativePath, observation]),
);
for (const proof of proofs) {
  const relativePath =
    proof.direction === "client-a-to-client-b"
      ? "E2E Sync Proof.md"
      : "Reverse Sync Proof.md";
  if (observedTransfers.get(relativePath)?.sha256 !== proof.sourceSha256) {
    throw new Error(`${proof.direction} files do not match the automated Sync observation`);
  }
}
const deletionTransfer = observedTransfers.get("Deletion Sync Proof.md");
const deletion = observations.find((observation) => observation.action === "delete");
if (!deletionTransfer || !deletion || deletionTransfer.sha256 !== deletion.sha256) {
  throw new Error("Deletion observation does not match the synchronized transfer");
}
for (const client of ["client-a", "client-b"]) {
  if (await Bun.file(resolve(root, client, "vault/Deletion Sync Proof.md")).exists()) {
    throw new Error(`Deletion proof still exists in ${client}`);
  }
}
const latestObservedDatabase = observations.reduce(
  (latest, observation) =>
    observation.databaseAfter.maxUid > latest.maxUid
      ? observation.databaseAfter
      : latest,
  observations[0]!.databaseAfter,
);

const clientAsars = [
  resolve(root, "client-a/user-data", runManifest.adapterFileName),
  resolve(root, "client-b/user-data", runManifest.adapterFileName),
];
const clientAsarHashes = await Promise.all(
  clientAsars.map(async (path) => sha256(Buffer.from(await Bun.file(path).arrayBuffer()))),
);
if (new Set(clientAsarHashes).size !== 1) {
  throw new Error("Clients did not run the same compatibility ASAR");
}
if (clientAsarHashes[0] !== runManifest.compatibilityAsarSha256) {
  throw new Error("Client compatibility ASAR does not match the prepared run manifest");
}

const databasePath = resolve(root, "server.sqlite");
const database = new Database(databasePath, { readonly: true });
const hasExternalContent = Boolean(
  database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='revision_content'").get(),
);
const vault = database
  .query<{ id: string; name: string; host: string; size: number; version: number }, []>(
    "SELECT id, name, host, size, version FROM vaults LIMIT 1",
  )
  .get();
const revisionSummary = database
  .query<{ revisions: number; maxUid: number; encryptedBytes: number }, []>(
    `SELECT COUNT(*) AS revisions,
            COALESCE(MAX(r.uid), 0) AS maxUid,
            COALESCE(SUM(LENGTH(${hasExternalContent ? "COALESCE(rc.content, r.content)" : "r.content"})), 0) AS encryptedBytes
       FROM revisions r
       ${hasExternalContent ? "LEFT JOIN revision_content rc ON rc.uid = r.uid" : ""}`,
  )
  .get();
const ciphertextRows = database
  .query<{ content: Uint8Array }, []>(
    hasExternalContent
      ? "SELECT COALESCE(rc.content, r.content) AS content FROM revisions r LEFT JOIN revision_content rc ON rc.uid = r.uid WHERE COALESCE(rc.content, r.content) IS NOT NULL"
      : "SELECT content FROM revisions WHERE content IS NOT NULL",
  )
  .all();
database.close();
if (!vault || !revisionSummary || revisionSummary.revisions === 0) {
  throw new Error("Server database has no synchronized vault revisions");
}
if (vault.host !== runManifest.endpoints.dataHost) {
  throw new Error("Stored vault Sync host does not match the release data endpoint");
}
if (vault.version !== revisionSummary.maxUid) {
  throw new Error("Vault version is not the latest committed revision UID");
}
if (
  revisionSummary.revisions < latestObservedDatabase.revisions ||
  revisionSummary.maxUid < latestObservedDatabase.maxUid ||
  vault.version < latestObservedDatabase.vaultVersion
) {
  throw new Error("Server database regressed after an observed Sync operation");
}
for (const pair of proofPairs) {
  const plaintext = Buffer.from(await Bun.file(pair.source).arrayBuffer());
  if (ciphertextRows.some((row) => Buffer.from(row.content).includes(plaintext))) {
    throw new Error("Server payload unexpectedly contains a proof note in plaintext");
  }
}

const uiCheckpoints = [
  {
    client: "client-a",
    path: "evidence/client-a/settings",
    requiredText: [`Version ${runManifest.rendererVersion}`, "Automatic updates", "Your account"],
    forbiddenText: ["quit unexpectedly"],
  },
  {
    client: "client-a",
    path: "evidence/client-a/created",
    requiredText: ["Your remote vaults", "E2E Vault", "Blackglass Server"],
    forbiddenText: ["Unable to connect"],
  },
  {
    client: "client-a",
    path: "evidence/client-a/unlocked",
    requiredText: ["Setup connection", "connected to", "E2E Vault", "Start syncing"],
    forbiddenText: ["Unable to retrieve your vault size", "Unable to connect"],
  },
  {
    client: "client-b",
    path: "evidence/client-b/vault-chooser",
    requiredText: ["Your remote vaults", "E2E Vault", "Blackglass Server"],
    forbiddenText: ["Unable to connect"],
  },
  {
    client: "client-b",
    path: "evidence/client-b/converged",
    requiredText: ["E2E Vault", "Fully synced", "E2E Sync Proof"],
    forbiddenText: ["Unable to", "Sync error"],
  },
  {
    client: "client-b",
    path: "evidence/client-b/deleted-files",
    requiredText: ["Deleted files", "Deletion Sync Proof"],
    forbiddenText: ["Unable to", "Sync error"],
  },
] as const;
const uxEvidence: Array<{
  path: string;
  client: "client-a" | "client-b";
  statePath: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  debugPort: number;
  observedAt: string;
  bodyTextSha256: string;
  accessibleTextSha256: string;
}> = [];
for (const checkpoint of uiCheckpoints) {
  const screenshot = resolve(root, `${checkpoint.path}.png`);
  const statePath = resolve(root, `${checkpoint.path}.json`);
  const screenshotStat = await stat(screenshot);
  if (
    screenshotStat.size < 1024 ||
    (screenshotStat.mode & 0o777) !== 0o600 ||
    ((await stat(statePath)).mode & 0o777) !== 0o600
  ) {
    throw new Error(`Missing or implausibly small screenshot: ${screenshot}`);
  }
  const bytes = Buffer.from(await readFile(screenshot));
  const signature = bytes.subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`UX evidence is not a PNG screenshot: ${screenshot}`);
  }
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR" || bytes.length < 24) {
    throw new Error(`UX evidence has no valid PNG IHDR: ${screenshot}`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 640 || height < 400 || width > 16_384 || height > 16_384) {
    throw new Error(
      `UX evidence has implausible dimensions ${width}x${height}: ${screenshot}`,
    );
  }
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    schemaVersion?: unknown;
    observedAt?: unknown;
    debugPort?: unknown;
    rendererPageCount?: unknown;
    visibleRendererPageCount?: unknown;
    url?: unknown;
    title?: unknown;
    bodyText?: unknown;
    accessibleText?: unknown;
    screenshotPath?: unknown;
    screenshotSha256?: unknown;
    launchIdentityPath?: unknown;
    launchIdentitySha256?: unknown;
    runManifestSha256?: unknown;
    releaseManifestSha256?: unknown;
    launchedPid?: unknown;
    debugListenerPid?: unknown;
    debugTargetId?: unknown;
    profilePath?: unknown;
    vaultPath?: unknown;
  };
  const binding = liveClientBindings.get(checkpoint.client)!;
  const identity = binding.identity;
  if (
    state.schemaVersion !== E2E_UI_EVIDENCE_SCHEMA_VERSION ||
    typeof state.observedAt !== "string" ||
    typeof state.debugPort !== "number" ||
    !Number.isInteger(state.debugPort) ||
    state.rendererPageCount !== 1 ||
    state.visibleRendererPageCount !== 1 ||
    typeof state.url !== "string" ||
    !state.url.includes("index.html") ||
    typeof state.title !== "string" ||
    state.title.length === 0 ||
    typeof state.bodyText !== "string" ||
    !Array.isArray(state.accessibleText) ||
    state.accessibleText.some((value) => typeof value !== "string") ||
    typeof state.screenshotPath !== "string" ||
    resolve(state.screenshotPath) !== screenshot ||
    state.screenshotSha256 !== sha256(bytes) ||
    state.launchIdentityPath !== binding.identityPath ||
    state.launchIdentitySha256 !== binding.identitySha256 ||
    state.runManifestSha256 !== preparedRun.manifestSha256 ||
    state.releaseManifestSha256 !== runManifest.releaseManifestSha256 ||
    state.launchedPid !== identity.pid ||
    state.debugPort !== identity.debugPort ||
    state.debugListenerPid !== identity.debugListenerPid ||
    state.debugTargetId !== identity.debugTargetId ||
    state.profilePath !== identity.profilePath ||
    state.vaultPath !== identity.vaultPath ||
    state.url !== identity.debugTargetUrl
  ) {
    throw new Error(`Malformed or mismatched UI checkpoint: ${statePath}`);
  }
  const uiText = [state.bodyText, ...state.accessibleText].join("\n");
  const observedAt = Date.parse(state.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > Date.now() + 5_000 ||
    Math.abs(screenshotStat.mtimeMs - observedAt) > 30_000
  ) {
    throw new Error(`UI checkpoint has an implausible observation time: ${statePath}`);
  }
  for (const requiredText of checkpoint.requiredText) {
    if (!uiText.includes(requiredText)) {
      throw new Error(`UI checkpoint ${statePath} is missing required text: ${requiredText}`);
    }
  }
  for (const forbiddenText of checkpoint.forbiddenText) {
    if (uiText.toLowerCase().includes(forbiddenText.toLowerCase())) {
      throw new Error(`UI checkpoint ${statePath} contains failure text: ${forbiddenText}`);
    }
  }
  uxEvidence.push({
    path: screenshot.slice(root.length + 1),
    client: checkpoint.client,
    statePath: statePath.slice(root.length + 1),
    bytes: screenshotStat.size,
    sha256: sha256(bytes),
    width,
    height,
    debugPort: state.debugPort,
    observedAt: state.observedAt,
    bodyTextSha256: sha256(Buffer.from(state.bodyText)),
    accessibleTextSha256: sha256(Buffer.from(state.accessibleText.join("\n"))),
  });
}
if (new Set(uxEvidence.map((item) => item.sha256)).size !== uxEvidence.length) {
  throw new Error("UX evidence checkpoints must be distinct screenshots");
}
const clientAPorts = new Set(
  uxEvidence.filter((item) => item.client === "client-a").map((item) => item.debugPort),
);
const clientBPorts = new Set(
  uxEvidence.filter((item) => item.client === "client-b").map((item) => item.debugPort),
);
if (
  clientAPorts.size !== 1 ||
  clientBPorts.size !== 1 ||
  [...clientAPorts][0] === [...clientBPorts][0] ||
  [...clientAPorts][0] !== clientLaunchIdentities.get("client-a")!.debugPort ||
  [...clientBPorts][0] !== clientLaunchIdentities.get("client-b")!.debugPort
) {
  throw new Error("UI evidence is not bound to two distinct, stable client debugging ports");
}
const databaseMode = (await stat(databasePath)).mode & 0o777;
const stagingMode = (await stat(resolve(root, "uploads"))).mode & 0o777;
if (process.platform !== "win32" && (databaseMode !== 0o600 || stagingMode !== 0o700)) {
  throw new Error(
    `Unsafe E2E state permissions: database=${databaseMode.toString(8)}, staging=${stagingMode.toString(8)}`,
  );
}

const report = {
  schemaVersion: 2,
  scenarioId: preparedE2EScenarioId(runManifest.scenarioId),
  generatedAt: new Date().toISOString(),
  passed: true,
  referenceClient: {
    blackglassVersion: releaseManifest.blackglassVersion,
    version: runManifest.rendererVersion,
    platform: "macOS Apple Silicon",
    compatibilityAsarSha256: clientAsarHashes[0],
    isolatedClients: 2,
    app: publicMacOSArtifact(recordedClient),
    compatibilityBaseline: releaseManifest.compatibilityBaseline,
    patcher: releaseManifest.patcher,
    endpoints: releaseManifest.endpoints,
    releaseManifestSha256: runManifest.releaseManifestSha256,
    explicitUserDataDirRequired: true,
  },
  clientLaunches: Object.fromEntries(
    [...liveClientBindings.entries()].map(([client, binding]) => [client, {
      identitySha256: binding.identitySha256,
      runtimeReceiptSha256: binding.identity.runtimeReceiptSha256,
      officialChildOfLauncher: true,
    }]),
  ),
  proofs,
  observations,
  server: {
    implementation: hasExternalContent ? "rust" : "bun-oracle",
    artifact: publicServerArtifact(recordedServer),
    vaultName: vault.name,
    dataHost: vault.host,
    revisions: revisionSummary.revisions,
    version: vault.version,
    encryptedBytes: revisionSummary.encryptedBytes,
    exactProofPlaintextFound: false,
    databaseMode: databaseMode.toString(8).padStart(4, "0"),
    stagingMode: stagingMode.toString(8).padStart(4, "0"),
    initialProcess: publicServerIdentity(initialServer),
    restartedProcess: publicServerIdentity(restartedServer),
  },
  networkEvidence,
  uxEvidence,
};
await writeFile(resolve(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(JSON.stringify(report, null, 2));

function sha256(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

type SyncObservation = {
  schemaVersion: number;
  action: "transfer" | "delete";
  observedAt: string;
  sourceClient: string;
  destinationClient: string;
  relativePath: string;
  sourceCreatedAt?: string;
  sourceDeletedAt?: string;
  bytes: number;
  sha256: string;
  databaseBefore: ObservationDatabase;
  databaseAfter: ObservationDatabase;
};

type ObservationDatabase = {
  revisions: number;
  maxUid: number;
  vaultVersion: number;
  vaultSize: number;
};

type ServerProcessIdentity = {
  schemaVersion: number;
  pid: number;
  startedAt: string;
  readyAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  gracefulShutdown: boolean | null;
  binaryPath: string;
  expectedSourceRevision: string;
  artifact: ServerArtifact;
  databasePath: string;
  stagingPath: string;
  controlOrigin: string;
  dataHost: string;
  ready: Record<string, unknown>;
};

async function readServerIdentity(path: string): Promise<ServerProcessIdentity> {
  const value = JSON.parse(await readFile(path, "utf8")) as ServerProcessIdentity;
  if (
    value.schemaVersion !== 2 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.readyAt)) ||
    (value.stoppedAt !== null && !Number.isFinite(Date.parse(value.stoppedAt))) ||
    !/^[a-f0-9]{40}$/u.test(value.expectedSourceRevision) ||
    value.artifact?.sourceRevision !== value.expectedSourceRevision ||
    typeof value.ready !== "object" ||
    value.ready === null ||
    value.ready.ok !== true ||
    ((await stat(path)).mode & 0o777) !== 0o600
  ) {
    throw new Error(`Malformed server process identity: ${path}`);
  }
  return value;
}

function publicServerIdentity(value: ServerProcessIdentity): Record<string, unknown> {
  return {
    pid: value.pid,
    startedAt: value.startedAt,
    readyAt: value.readyAt,
    stoppedAt: value.stoppedAt,
    exitCode: value.exitCode,
    gracefulShutdown: value.gracefulShutdown,
  };
}

function validateObservation(
  value: SyncObservation,
  expected: {
    action: "transfer" | "delete";
    sourceClient: string;
    destinationClient: string;
    relativePath: string;
  },
  path: string,
): void {
  const sourceMutationAt =
    value.action === "transfer" ? value.sourceCreatedAt : value.sourceDeletedAt;
  if (
    value.schemaVersion !== 1 ||
    value.action !== expected.action ||
    value.sourceClient !== expected.sourceClient ||
    value.destinationClient !== expected.destinationClient ||
    value.relativePath !== expected.relativePath ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof sourceMutationAt !== "string" ||
    !Number.isFinite(Date.parse(sourceMutationAt)) ||
    Date.parse(sourceMutationAt) > Date.parse(value.observedAt) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !validObservationDatabase(value.databaseBefore) ||
    !validObservationDatabase(value.databaseAfter) ||
    value.databaseAfter.revisions <= value.databaseBefore.revisions ||
    value.databaseAfter.maxUid <= value.databaseBefore.maxUid ||
    value.databaseAfter.vaultVersion <= value.databaseBefore.vaultVersion ||
    value.databaseAfter.maxUid !== value.databaseAfter.vaultVersion
  ) {
    throw new Error(`Malformed or non-advancing automated Sync observation: ${path}`);
  }
}

function validObservationDatabase(value: ObservationDatabase): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    [value.revisions, value.maxUid, value.vaultVersion, value.vaultSize].every(
      (item) => Number.isSafeInteger(item) && item >= 0,
    ) &&
    value.maxUid === value.vaultVersion
  );
}
