import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalOutputPath, pathExists } from "./path-safety";

export type PreparedClientName = "client-a" | "client-b" | "client-c";
const PROCESS_OWNER_NONCE = randomUUID();
const PROCESS_ARGUMENTS_SHA256 = createHash("sha256")
  .update(JSON.stringify(process.argv))
  .digest("hex");
const PROCESS_START_IDENTITY = processStartIdentity(process.pid);

export function sourceLossResetLockPath(runRoot: string): string {
  return join(runRoot, ".source-loss-reset.lock");
}

export function preparedClientLeasePath(
  runRoot: string,
  clientName: PreparedClientName,
): string {
  return join(runRoot, `.${clientName}.launch.lock`);
}

export async function acquireCheckpointPublicationLease(
  runRoot: string,
  checkpoint: string,
): Promise<string> {
  if (!/^(?:evidence\/)?[a-z0-9-]+\/[a-z0-9-]+$/u.test(checkpoint)) {
    throw new Error(`Unsafe checkpoint publication path: ${checkpoint}`);
  }
  const evidenceRoot = join(runRoot, "evidence");
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const checkpointSha256 = createHash("sha256").update(checkpoint).digest("hex");
  const requestedPath = join(evidenceRoot, `.checkpoint-${checkpointSha256}.lock`);
  const recovered = await recoverDeadOwnerLock(requestedPath, "checkpoint publication lease");
  if (recovered) await quarantineRecoveredCheckpointStaging(runRoot, checkpoint);
  const leasePath = await canonicalOutputPath(requestedPath, "checkpoint publication lease");
  await writeFile(
    leasePath,
    `${JSON.stringify({
      schemaVersion: 3,
      pid: process.pid,
      checkpoint,
      acquiredAt: new Date().toISOString(),
      ownerNonce: PROCESS_OWNER_NONCE,
      executable: process.execPath,
      argumentsSha256: PROCESS_ARGUMENTS_SHA256,
      processStartIdentity: PROCESS_START_IDENTITY,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return leasePath;
}

export async function releaseCheckpointPublicationLease(
  leasePath: string,
  checkpoint: string,
): Promise<void> {
  const lease = JSON.parse(await readFile(leasePath, "utf8")) as any;
  if (
    lease.schemaVersion !== 3 || lease.pid !== process.pid ||
    lease.checkpoint !== checkpoint || lease.ownerNonce !== PROCESS_OWNER_NONCE ||
    lease.executable !== process.execPath ||
    lease.argumentsSha256 !== PROCESS_ARGUMENTS_SHA256 ||
    lease.processStartIdentity !== PROCESS_START_IDENTITY
  ) {
    throw new Error("Refusing to remove a changed checkpoint publication lease");
  }
  await unlink(leasePath);
}

export async function assertNoCheckpointPublicationLeases(runRoot: string): Promise<void> {
  const evidenceRoot = join(runRoot, "evidence");
  const leases = (await readdir(evidenceRoot))
    .filter((name) => /^\.checkpoint-[a-f0-9]{64}\.lock$/u.test(name))
    .sort();
  if (leases.length > 0) {
    throw new Error(`Checkpoint publication leases remain: ${leases.join(", ")}`);
  }
  const staging = await findCheckpointStagingResidue(evidenceRoot, evidenceRoot);
  if (staging.length > 0) {
    throw new Error(`Checkpoint publication staging remains: ${staging.join(", ")}`);
  }
}

async function findCheckpointStagingResidue(root: string, directory: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith(".checkpoint-capture-")) {
      results.push(path.slice(root.length + 1));
    } else if (entry.isDirectory() && entry.name !== "failed-attempts" &&
      !entry.name.startsWith(".interrupted-checkpoint-")) {
      results.push(...await findCheckpointStagingResidue(root, path));
    }
  }
  return results.sort();
}

export async function acquirePreparedClientLease(
  runRoot: string,
  clientName: PreparedClientName,
): Promise<string> {
  const resetPath = sourceLossResetLockPath(runRoot);
  if (await pathExists(resetPath)) {
    throw new Error("Prepared run is locked for source-loss reset");
  }
  const requestedLeasePath = preparedClientLeasePath(runRoot, clientName);
  await recoverDeadOwnerLock(requestedLeasePath, "prepared-client launch lease");
  const leasePath = await canonicalOutputPath(
    requestedLeasePath,
    `${clientName} launch lease`,
  );
  await writeFile(
    leasePath,
    `${JSON.stringify({
      schemaVersion: 3,
      pid: process.pid,
      clientName,
      acquiredAt: new Date().toISOString(),
      ownerNonce: PROCESS_OWNER_NONCE,
      executable: process.execPath,
      argumentsSha256: PROCESS_ARGUMENTS_SHA256,
      processStartIdentity: PROCESS_START_IDENTITY,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  if (await pathExists(resetPath)) {
    await releasePreparedClientLease(leasePath);
    throw new Error("Prepared run became locked while acquiring its launch lease");
  }
  return leasePath;
}

export async function releasePreparedClientLease(leasePath: string): Promise<void> {
  const lease = JSON.parse(await readFile(leasePath, "utf8")) as any;
  if (
    lease.schemaVersion !== 3 ||
    lease.pid !== process.pid ||
    lease.ownerNonce !== PROCESS_OWNER_NONCE ||
    lease.executable !== process.execPath ||
    lease.argumentsSha256 !== PROCESS_ARGUMENTS_SHA256 ||
    lease.processStartIdentity !== PROCESS_START_IDENTITY ||
    !["client-a", "client-b", "client-c"].includes(lease.clientName)
  ) {
    throw new Error("Refusing to remove a changed prepared-client launch lease");
  }
  await unlink(leasePath);
}

export async function acquireSourceLossResetLock(
  runRoot: string,
  runManifestSha256: string,
  clientsThatMustBeStopped: readonly PreparedClientName[],
): Promise<string> {
  if (
    clientsThatMustBeStopped.length === 0 ||
    new Set(clientsThatMustBeStopped).size !== clientsThatMustBeStopped.length ||
    clientsThatMustBeStopped.some((client) =>
      !["client-a", "client-b", "client-c"].includes(client)
    )
  ) {
    throw new Error("Source-loss reset requires a non-empty unique prepared-client scope");
  }
  const requestedLockPath = sourceLossResetLockPath(runRoot);
  await recoverDeadOwnerLock(requestedLockPath, "source-loss reset lock");
  const lockPath = await canonicalOutputPath(
    requestedLockPath,
    "Source-loss reset lock",
  );
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 3,
      pid: process.pid,
      runManifestSha256,
      acquiredAt: new Date().toISOString(),
      ownerNonce: PROCESS_OWNER_NONCE,
      executable: process.execPath,
      argumentsSha256: PROCESS_ARGUMENTS_SHA256,
      processStartIdentity: PROCESS_START_IDENTITY,
    })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  try {
    await assertNoPreparedClientLeases(runRoot, clientsThatMustBeStopped);
  } catch (error) {
    await releaseSourceLossResetLock(lockPath, runManifestSha256);
    throw error;
  }
  return lockPath;
}

export async function releaseSourceLossResetLock(
  lockPath: string,
  runManifestSha256: string,
): Promise<void> {
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as any;
  if (
    lock.schemaVersion !== 3 ||
    lock.pid !== process.pid ||
    lock.ownerNonce !== PROCESS_OWNER_NONCE ||
    lock.executable !== process.execPath ||
    lock.argumentsSha256 !== PROCESS_ARGUMENTS_SHA256 ||
    lock.processStartIdentity !== PROCESS_START_IDENTITY ||
    lock.runManifestSha256 !== runManifestSha256
  ) {
    throw new Error("Refusing to remove a changed source-loss reset lock");
  }
  await unlink(lockPath);
}

async function recoverDeadOwnerLock(path: string, label: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const metadata = await lstat(path);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid!() || (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error(`Refusing non-regular ${label}: ${path}`);
  }
  let lock: Record<string, unknown>;
  try {
    lock = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`Refusing malformed ${label}: ${path}`);
  }
  if (
    lock.schemaVersion !== 3 ||
    !Number.isSafeInteger(lock.pid) ||
    Number(lock.pid) < 1 ||
    typeof lock.ownerNonce !== "string" || lock.ownerNonce.length < 16 ||
    typeof lock.executable !== "string" || lock.executable.length === 0 ||
    typeof lock.argumentsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(lock.argumentsSha256) ||
    typeof lock.processStartIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(lock.processStartIdentity) ||
    typeof lock.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(lock.acquiredAt))
  ) {
    throw new Error(`Refusing malformed ${label}: ${path}`);
  }
  if (processIsAlive(Number(lock.pid)) &&
      processStartIdentity(Number(lock.pid)) === lock.processStartIdentity) {
    throw new Error(`Active ${label} already exists: ${path}`);
  }
  const current = await readFile(path);
  if (!current.equals(bytes)) throw new Error(`Refusing changed ${label}: ${path}`);
  await unlink(path);
  return true;
}

async function quarantineRecoveredCheckpointStaging(
  runRoot: string,
  checkpoint: string,
): Promise<void> {
  const evidenceRoot = join(runRoot, "evidence");
  const checkpointBase = checkpoint.startsWith("evidence/")
    ? join(runRoot, checkpoint)
    : join(evidenceRoot, checkpoint);
  const checkpointDirectory = dirname(checkpointBase);
  const failedRoot = join(evidenceRoot, "failed-attempts");
  await mkdir(failedRoot, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(checkpointDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".checkpoint-capture-")) continue;
    const destination = join(
      failedRoot,
      `${checkpoint.replaceAll("/", "-")}-recovered-${randomUUID()}`,
    );
    await rename(join(checkpointDirectory, entry.name), destination);
    await writeFile(
      join(destination, "recovery.txt"),
      `Staging from a dead checkpoint publisher preserved for ${checkpoint}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function assertNoPreparedClientLeases(
  runRoot: string,
  clientNames: readonly PreparedClientName[],
): Promise<void> {
  const active: string[] = [];
  for (const client of clientNames) {
    const path = preparedClientLeasePath(runRoot, client);
    if (!(await pathExists(path))) continue;
    try {
      await recoverDeadOwnerLock(path, "prepared-client launch lease");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Active prepared-client launch lease")) {
        active.push(client);
      } else {
        throw error;
      }
    }
  }
  if (active.length !== 0) {
    throw new Error(
      `Stop prepared clients before source-loss reset: ${active.join(", ")}`,
    );
  }
}

function processStartIdentity(pid: number): string {
  try {
    const result = Bun.spawnSync([
      "/bin/ps", "-ww", "-p", String(pid), "-o", "lstart=", "-o", "command=",
    ], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      return createHash("sha256").update(result.stdout).digest("hex");
    }
  } catch { /* Restricted unit-test sandboxes can deny process inspection. */ }
  return createHash("sha256").update(`unavailable:${pid}`).digest("hex");
}
