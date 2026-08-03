import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readClientLaunchIdentity } from "./e2e-client";
import { readPreparedE2ERun } from "./e2e-network";
import { assertBridgeLaunchConfig } from "./launcher-config";
import {
  acquireSourceLossResetLock,
  assertNoPreparedClientLeases,
  releaseSourceLossResetLock,
  sourceLossResetLockPath,
} from "./e2e-run-lock";
import {
  canonicalExistingPath,
  canonicalOutputPath,
  pathExists,
  pathsEqual,
} from "./path-safety";
import {
  assertCanonicalRecoveryCorpusIdentity,
  assertCanonicalRecoveryCorpusManifest,
} from "./recovery-corpus";
import {
  SOURCE_LOSS_RESET_SCHEMA_VERSION,
  assertSourceLossResetRecord,
  treeIdentitiesEqual,
  type SourceLossResetRecord,
} from "./source-loss-reset";
import { computeTreeIdentity } from "./tree-identity";

const [rootArgument, ...flags] = Bun.argv.slice(2);
if (!rootArgument || flags.length !== 0) {
  console.error("Usage: bun run tools/reset-e2e-for-recovery.ts <run-directory>");
  process.exit(2);
}

const run = await readPreparedE2ERun(rootArgument);
const root = run.root;
const existingResetPath = join(root, "source-loss-reset.json");
const existingTrashPath = join(root, ".source-loss-trash");
if (await pathExists(existingResetPath)) {
  await finalizePublishedReset(run, existingResetPath, existingTrashPath);
  process.exit(0);
}
if (await pathExists(existingTrashPath)) {
  throw new Error(
    "An interrupted unpublished source-loss transition retained recoverable client evidence",
  );
}
const reportPath = await canonicalExistingPath(join(root, "report.json"), "Sync report", "file");
const recoveryManifestPath = await canonicalExistingPath(
  join(root, "recovery-manifest.json"),
  "Recovery manifest",
  "file",
);
const reportSha256 = await fileSha256(reportPath);
const resetOutput = await canonicalOutputPath(
  join(root, "source-loss-reset.json"),
  "Source-loss reset record",
);
const resetLockPath = sourceLossResetLockPath(root);
const sourceLossTrash = await canonicalOutputPath(
  join(root, ".source-loss-trash"),
  "Source-loss transition directory",
);
const recoveryManifest = JSON.parse(await readFile(recoveryManifestPath, "utf8")) as {
  schemaVersion?: unknown;
  runManifestSha256?: unknown;
  syncReportSha256?: unknown;
  corpus?: unknown;
  files?: unknown;
};
if (
  recoveryManifest.schemaVersion !== 3 ||
  recoveryManifest.runManifestSha256 !== run.manifestSha256 ||
  recoveryManifest.syncReportSha256 !== reportSha256
) {
  throw new Error("Recovery capture is not bound to the completed Sync report");
}
assertCanonicalRecoveryCorpusIdentity(recoveryManifest.corpus);
assertCanonicalRecoveryCorpusManifest(recoveryManifest.files);
const recoveryManifestSha256 = await fileSha256(recoveryManifestPath);

const clientArtifactPath = await canonicalExistingPath(
  join(root, "client-artifact.json"),
  "Client artifact identity",
  "file",
);
const clientArtifact = JSON.parse(await readFile(clientArtifactPath, "utf8")) as {
  appPath?: unknown;
  embeddedAsarSha256?: unknown;
};
if (
  typeof clientArtifact.appPath !== "string" ||
  typeof clientArtifact.embeddedAsarSha256 !== "string"
) {
  throw new Error("Malformed client artifact identity");
}
const appPath = await canonicalExistingPath(
  clientArtifact.appPath,
  "Packaged client app",
  "directory",
);
if (!pathsEqual(appPath, clientArtifact.appPath)) {
  throw new Error("Client artifact app path is not canonical");
}
const launchConfig = JSON.parse(await readFile(
  join(appPath, "Contents/Resources/bridge-launch.json"),
  "utf8",
)) as unknown;
assertBridgeLaunchConfig(launchConfig);
const embeddedAsar = await canonicalExistingPath(
  join(appPath, "Contents/Resources", launchConfig.adapterFileName),
  "Packaged embedded renderer",
  "file",
);
const adapterBytes = await readFile(embeddedAsar);
if (
  launchConfig.adapterSha256 !== clientArtifact.embeddedAsarSha256 ||
  sha256(adapterBytes) !== clientArtifact.embeddedAsarSha256 ||
  sha256(adapterBytes) !== run.manifest.compatibilityAsarSha256
) {
  throw new Error("Packaged renderer no longer matches the prepared recovery run");
}

const clients = ["client-a", "client-b"] as const;
const launchIdentityPaths = clients.map((client) =>
  join(root, `${client}-launch.json`)
);
const launchIdentities = await Promise.all(
  launchIdentityPaths.map(readClientLaunchIdentity),
);
const launchIdentityBytes = await Promise.all(launchIdentityPaths.map((path) => readFile(path)));
const clientProfiles = clients.map((client) => join(root, client, "user-data"));
const retiredRuntimeHomes: Record<
  (typeof clients)[number],
  { identitySha256: string; blackglassHomePath: string; runtimeHomeRemoved: true }
> = {} as Record<
  (typeof clients)[number],
  { identitySha256: string; blackglassHomePath: string; runtimeHomeRemoved: true }
>;
for (const [index, identity] of launchIdentities.entries()) {
  const client = clients[index]!;
  if (!pathsEqual(identity.profilePath, clientProfiles[index]!)) {
    throw new Error(`${client} launch identity has the wrong disposable profile`);
  }
  if (processExists(identity.pid) || await devtoolsResponds(identity.debugPort)) {
    throw new Error(`Stop ${client} before beginning source-loss recovery`);
  }
  if (await pathExists(identity.blackglassHomePath)) {
    throw new Error(`${client} retained its external BLACKGLASS_HOME after shutdown`);
  }
  retiredRuntimeHomes[client] = {
    identitySha256: sha256(launchIdentityBytes[index]!),
    blackglassHomePath: identity.blackglassHomePath,
    runtimeHomeRemoved: true,
  };
}
assertNoActiveDisposableClients(appPath, clientProfiles);

const clientRoots = await Promise.all(
  clients.map((client) =>
    canonicalExistingPath(join(root, client), `${client} disposable directory`, "directory"),
  ),
);
const [clientATree, clientBTree] = await Promise.all(
  clientRoots.map((clientRoot) => computeTreeIdentity(clientRoot)),
);

const freshClient = await canonicalOutputPath(
  join(root, "client-b.next"),
  "Fresh recovery client staging directory",
);
const resetTemporary = `${resetOutput}.next`;
if (await pathExists(resetTemporary)) {
  throw new Error("Source-loss reset staging record already exists");
}
let resetPublished = false;
await acquireSourceLossResetLock(root, run.manifestSha256);
try {
await assertNoPreparedClientLeases(root, clients);
assertNoActiveDisposableClients(appPath, clientProfiles);
const freshProfile = join(freshClient, "user-data");
const freshVault = join(freshClient, "vault");
await mkdir(freshProfile, { recursive: true, mode: 0o700 });
await mkdir(freshVault, { recursive: true, mode: 0o700 });
await writeFile(join(freshProfile, run.manifest.adapterFileName), adapterBytes, {
  flag: "wx",
  mode: 0o600,
});
const vaultId = createHash("sha256").update(join(root, "client-b", "vault")).digest("hex").slice(0, 16);
await writeFile(join(freshProfile, `${vaultId}.json`), "{}", {
  flag: "wx",
  mode: 0o600,
});
await writeFile(
  join(freshProfile, "obsidian.json"),
  `${JSON.stringify({
    updateDisabled: true,
    vaults: {
      [vaultId]: {
        path: join(root, "client-b", "vault"),
        ts: Date.now(),
        open: true,
      },
    },
  }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);

const resetRecord = {
  schemaVersion: SOURCE_LOSS_RESET_SCHEMA_VERSION,
  resetAt: new Date().toISOString(),
  runManifestSha256: run.manifestSha256,
  syncReportSha256: reportSha256,
  recoveryManifestSha256,
  removed: {
    clientA: clientATree,
    clientB: clientBTree,
  },
  retiredRuntimeHomes,
  freshClient: {
    name: "client-b",
    profilePath: join(root, "client-b", "user-data"),
    vaultPath: join(root, "client-b", "vault"),
    adapterSha256: sha256(adapterBytes),
    initialVaultFiles: 0,
  },
};
assertSourceLossResetRecord(resetRecord, {
  runManifestSha256: run.manifestSha256,
  syncReportSha256: reportSha256,
  recoveryManifestSha256,
  compatibilityAsarSha256: run.manifest.compatibilityAsarSha256,
  profilePath: join(root, "client-b", "user-data"),
  vaultPath: join(root, "client-b", "vault"),
});
await writeFile(resetTemporary, `${JSON.stringify(resetRecord, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});

// These targets were resolved from one validated prepared run, both clients are
// stopped, and all source evidence was captured above. No user-selected path or
// installed application is removed here.
  await assertNoPreparedClientLeases(root, clients);
  assertNoActiveDisposableClients(appPath, clientProfiles);
  await mkdir(sourceLossTrash, { recursive: false, mode: 0o700 });
  const transitionMarker = join(sourceLossTrash, "transition.json");
  await writeFile(
    transitionMarker,
    `${JSON.stringify({ schemaVersion: 1, runManifestSha256: run.manifestSha256 })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const retiredClientA = join(sourceLossTrash, "client-a");
  const retiredClientB = join(sourceLossTrash, "client-b");
  let clientAMoved = false;
  let clientBMoved = false;
  let freshClientInstalled = false;
  try {
    await rename(clientRoots[0]!, retiredClientA);
    clientAMoved = true;
    await rename(clientRoots[1]!, retiredClientB);
    clientBMoved = true;
    await rename(freshClient, join(root, "client-b"));
    freshClientInstalled = true;
    await assertRetiredClientTreesMatch(sourceLossTrash, resetRecord.removed);
    await rename(resetTemporary, resetOutput);
    resetPublished = true;
    await rm(sourceLossTrash, { recursive: true, force: false });
  } catch (error) {
    if (resetPublished) throw error;
    const rollbackErrors: Error[] = [];
    for (const rollback of [
      async () => {
        if (freshClientInstalled) await rename(join(root, "client-b"), freshClient);
      },
      async () => {
        if (clientBMoved) await rename(retiredClientB, clientRoots[1]!);
      },
      async () => {
        if (clientAMoved) await rename(retiredClientA, clientRoots[0]!);
      },
      async () => {
        if (await pathExists(transitionMarker)) await unlink(transitionMarker);
      },
      async () => {
        if (await pathExists(sourceLossTrash)) await rmdir(sourceLossTrash);
      },
    ]) {
      try {
        await rollback();
      } catch (rollbackError) {
        rollbackErrors.push(asError(rollbackError));
      }
    }
    if (rollbackErrors.length !== 0) {
      throw new AggregateError(
        [asError(error), ...rollbackErrors],
        "Source-loss transition failed and rollback was incomplete",
      );
    }
    throw error;
  }
  console.log(JSON.stringify(resetRecord, null, 2));
} catch (error) {
  if (!resetPublished) {
    const cleanupErrors: Error[] = [];
    for (const cleanup of [
      async () => {
        if (await pathExists(freshClient)) {
          await rm(freshClient, { recursive: true, force: false });
        }
      },
      async () => {
        if (await pathExists(resetTemporary)) await unlink(resetTemporary);
      },
    ]) {
      try {
        await cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(asError(cleanupError));
      }
    }
    if (cleanupErrors.length !== 0) {
      throw new AggregateError(
        [asError(error), ...cleanupErrors],
        "Source-loss reset failed and staging cleanup was incomplete",
      );
    }
  }
  throw error;
} finally {
  await releaseSourceLossResetLock(resetLockPath, run.manifestSha256);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function finalizePublishedReset(
  run: Awaited<ReturnType<typeof readPreparedE2ERun>>,
  resetPath: string,
  trashPath: string,
): Promise<void> {
  const runRoot = run.root;
  const reportPath = await canonicalExistingPath(
    join(runRoot, "report.json"),
    "Sync report",
    "file",
  );
  const recoveryManifestPath = await canonicalExistingPath(
    join(runRoot, "recovery-manifest.json"),
    "Recovery manifest",
    "file",
  );
  const [reportSha256, recoveryManifestBytes] = await Promise.all([
    fileSha256(reportPath),
    readFile(recoveryManifestPath),
  ]);
  const recoveryManifest = JSON.parse(recoveryManifestBytes.toString("utf8")) as any;
  if (
    recoveryManifest.schemaVersion !== 3 ||
    recoveryManifest.runManifestSha256 !== run.manifestSha256 ||
    recoveryManifest.syncReportSha256 !== reportSha256
  ) {
    throw new Error("Existing recovery capture is not bound to this prepared run");
  }
  assertCanonicalRecoveryCorpusIdentity(recoveryManifest.corpus);
  assertCanonicalRecoveryCorpusManifest(recoveryManifest.files);
  const recoveryManifestSha256 = sha256(recoveryManifestBytes);

  const resetBytes = await readFile(resetPath);
  const reset = JSON.parse(resetBytes.toString("utf8")) as any;
  assertSourceLossResetRecord(reset, {
    runManifestSha256: run.manifestSha256,
    syncReportSha256: reportSha256,
    recoveryManifestSha256,
    compatibilityAsarSha256: run.manifest.compatibilityAsarSha256,
    profilePath: join(runRoot, "client-b", "user-data"),
    vaultPath: join(runRoot, "client-b", "vault"),
  });
  if (!await pathExists(trashPath)) {
    throw new Error("Source-loss reset is already complete");
  }
  const canonicalTrash = await canonicalExistingPath(
    trashPath,
    "Published source-loss transition directory",
    "directory",
  );
  if (!pathsEqual(canonicalTrash, trashPath)) {
    throw new Error("Published source-loss transition directory is not canonical");
  }
  const markerPath = await canonicalExistingPath(
    join(canonicalTrash, "transition.json"),
    "Published source-loss transition marker",
    "file",
  );
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as any;
  if (
    marker.schemaVersion !== 1 ||
    marker.runManifestSha256 !== run.manifestSha256
  ) {
    throw new Error("Published source-loss transition marker is inconsistent");
  }
  if (await pathExists(join(runRoot, "client-a"))) {
    throw new Error("Published source-loss reset unexpectedly retained client-a");
  }
  const freshProfile = await canonicalExistingPath(
    reset.freshClient.profilePath,
    "Published fresh recovery profile",
    "directory",
  );
  const freshVault = await canonicalExistingPath(
    reset.freshClient.vaultPath,
    "Published fresh recovery vault",
    "directory",
  );
  if (
    !pathsEqual(freshProfile, join(runRoot, "client-b", "user-data")) ||
    !pathsEqual(freshVault, join(runRoot, "client-b", "vault")) ||
    await fileSha256(join(freshProfile, run.manifest.adapterFileName)) !==
      run.manifest.compatibilityAsarSha256
  ) {
    throw new Error("Published source-loss reset has no intact fresh recovery client");
  }

  await assertRetiredClientTreesMatch(canonicalTrash, reset.removed);

  const lockPath = await acquireSourceLossResetLock(runRoot, run.manifestSha256);
  try {
    await assertNoPreparedClientLeases(runRoot, ["client-a", "client-b"]);
    await rm(canonicalTrash, { recursive: true, force: false });
  } finally {
    await releaseSourceLossResetLock(lockPath, run.manifestSha256);
  }
  console.log(JSON.stringify({ finalized: true, reset }, null, 2));
}

async function assertRetiredClientTreesMatch(
  trashRoot: string,
  expected: SourceLossResetRecord["removed"],
): Promise<void> {
  const retiredClientA = await canonicalExistingPath(
    join(trashRoot, "client-a"),
    "Retired client-a tree",
    "directory",
  );
  const retiredClientB = await canonicalExistingPath(
    join(trashRoot, "client-b"),
    "Retired client-b tree",
    "directory",
  );
  const [retiredClientAIdentity, retiredClientBIdentity] = await Promise.all([
    computeTreeIdentity(retiredClientA),
    computeTreeIdentity(retiredClientB),
  ]);
  if (
    !treeIdentitiesEqual(retiredClientAIdentity, expected.clientA) ||
    !treeIdentitiesEqual(retiredClientBIdentity, expected.clientB)
  ) {
    throw new Error("Source-loss transition trees changed before cleanup");
  }
}

function assertNoActiveDisposableClients(appPath: string, profiles: string[]): void {
  const result = Bun.spawnSync(["/bin/ps", "-ww", "-axo", "pid=", "-o", "command="]);
  if (result.exitCode !== 0) {
    throw new Error("Unable to inspect disposable client processes before reset");
  }
  const active = result.stdout.toString("utf8").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (
      !match ||
      !match[2]!.startsWith(`${appPath}/Contents/`) ||
      !profiles.some((profile) => match[2]!.includes(`--user-data-dir=${profile}`))
    ) {
      return [];
    }
    return [`${match[1]} ${match[2]}`];
  });
  if (active.length !== 0) {
    throw new Error(
      `Stop all disposable clients before source-loss reset: ${active.join("; ")}`,
    );
  }
}

async function devtoolsResponds(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
