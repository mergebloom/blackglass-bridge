import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readClientLaunchIdentity } from "./e2e-client";
import { readPreparedE2ERun } from "./e2e-network";
import {
  acquireSourceLossResetLock,
  assertNoPreparedClientLeases,
  releaseSourceLossResetLock,
} from "./e2e-run-lock";
import { pathExists } from "./path-safety";
import { computeTreeIdentity } from "./tree-identity";
import { stageFreshClientLayout } from "./fresh-client-layout";

const [rootArgument, clientName = "client-b", ...extra] = Bun.argv.slice(2);
if (!rootArgument || clientName !== "client-b" || extra.length !== 0) {
  throw new Error("Usage: bun run tools/reset-e2e-client.ts <prepared-run> [client-b]");
}
const run = await readPreparedE2ERun(rootArgument);
if (run.manifest.scenarioId !== "E2E-P4-CUSTOM-E2EE" &&
  run.manifest.scenarioId !== "E2E-P4-MANAGED-ENCRYPTION") {
  throw new Error("Clean-client lifecycle reset is for Phase 4 collaboration scenarios");
}
const root = run.root;
const clientRoot = join(root, clientName);
const recordPath = join(root, `${clientName}-clean-reset.json`);
const staging = join(root, `.${clientName}.fresh-${randomUUID()}`);
const retired = join(root, `.${clientName}.retired-${randomUUID()}`);
if (await pathExists(recordPath) || await pathExists(staging) || await pathExists(retired)) {
  throw new Error("Clean-client lifecycle output already exists");
}
const launchPath = join(root, `${clientName}-launch.json`);
const launchBytes = await readFile(launchPath);
const launch = await readClientLaunchIdentity(launchPath);
if (processIsAlive(launch.pid)) throw new Error(`Stop ${clientName} before clean-client reset`);
if (await pathExists(launch.blackglassHomePath)) {
  throw new Error(`${clientName} retained its disposable BLACKGLASS_HOME`);
}
const before = await computeTreeIdentity(clientRoot);
const adapter = await readFile(join(clientRoot, "user-data", run.manifest.adapterFileName));
if (sha256(adapter) !== run.manifest.compatibilityAsarSha256) {
  throw new Error("Client adapter changed before clean-client reset");
}

const resetAt = new Date().toISOString();
await stageFreshClientLayout({
  stagingRoot: staging,
  finalVaultPath: join(root, clientName, "vault"),
  adapterFileName: run.manifest.adapterFileName,
  adapter,
  timestamp: Date.now(),
});

let lock: string | undefined;
let transitioned = false;
try {
  lock = await acquireSourceLossResetLock(root, run.manifestSha256, [clientName]);
  await assertNoPreparedClientLeases(root, [clientName]);
  await rename(clientRoot, retired);
  try {
    await rename(staging, clientRoot);
    transitioned = true;
  } catch (error) {
    await rename(retired, clientRoot);
    throw error;
  }
  const freshVault = await computeTreeIdentity(join(clientRoot, "vault"));
  if (freshVault.files !== 0 || freshVault.fileBytes !== 0) {
    throw new Error("Fresh client vault is not empty");
  }
  const record = {
    schemaVersion: 1,
    scenarioId: run.manifest.scenarioId,
    client: clientName,
    resetAt,
    runManifestSha256: run.manifestSha256,
    compatibilityAsarSha256: run.manifest.compatibilityAsarSha256,
    priorLaunchIdentitySha256: sha256(launchBytes),
    removedClientTree: before,
    freshProfilePath: join(clientRoot, "user-data"),
    freshVaultPath: join(clientRoot, "vault"),
    initialVaultFiles: 0,
    initialVaultBytes: 0,
  };
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rm(retired, { recursive: true, force: false });
  console.log(JSON.stringify(record, null, 2));
} catch (error) {
  if (transitioned && !(await pathExists(recordPath))) {
    await rm(clientRoot, { recursive: true, force: false });
    await rename(retired, clientRoot);
  }
  throw error;
} finally {
  if (await pathExists(staging)) await rm(staging, { recursive: true, force: false });
  if (lock) await releaseSourceLossResetLock(lock, run.manifestSha256);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
