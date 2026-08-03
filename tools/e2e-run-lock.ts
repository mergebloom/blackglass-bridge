import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalOutputPath, pathExists } from "./path-safety";

export type PreparedClientName = "client-a" | "client-b" | "client-c";

export function sourceLossResetLockPath(runRoot: string): string {
  return join(runRoot, ".source-loss-reset.lock");
}

export function preparedClientLeasePath(
  runRoot: string,
  clientName: PreparedClientName,
): string {
  return join(runRoot, `.${clientName}.launch.lock`);
}

export async function acquirePreparedClientLease(
  runRoot: string,
  clientName: PreparedClientName,
): Promise<string> {
  const resetPath = sourceLossResetLockPath(runRoot);
  if (await pathExists(resetPath)) {
    throw new Error("Prepared run is locked for source-loss reset");
  }
  const leasePath = await canonicalOutputPath(
    preparedClientLeasePath(runRoot, clientName),
    `${clientName} launch lease`,
  );
  await writeFile(
    leasePath,
    `${JSON.stringify({ schemaVersion: 1, pid: process.pid, clientName })}\n`,
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
    lease.schemaVersion !== 1 ||
    lease.pid !== process.pid ||
    !["client-a", "client-b", "client-c"].includes(lease.clientName)
  ) {
    throw new Error("Refusing to remove a changed prepared-client launch lease");
  }
  await unlink(leasePath);
}

export async function acquireSourceLossResetLock(
  runRoot: string,
  runManifestSha256: string,
): Promise<string> {
  const lockPath = await canonicalOutputPath(
    sourceLossResetLockPath(runRoot),
    "Source-loss reset lock",
  );
  await writeFile(
    lockPath,
    `${JSON.stringify({ schemaVersion: 1, pid: process.pid, runManifestSha256 })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  try {
    await assertNoPreparedClientLeases(runRoot, ["client-a", "client-b", "client-c"]);
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
    lock.schemaVersion !== 1 ||
    lock.pid !== process.pid ||
    lock.runManifestSha256 !== runManifestSha256
  ) {
    throw new Error("Refusing to remove a changed source-loss reset lock");
  }
  await unlink(lockPath);
}

export async function assertNoPreparedClientLeases(
  runRoot: string,
  clientNames: readonly PreparedClientName[],
): Promise<void> {
  const active: string[] = [];
  for (const client of clientNames) {
    if (await pathExists(preparedClientLeasePath(runRoot, client))) active.push(client);
  }
  if (active.length !== 0) {
    throw new Error(
      `Stop prepared clients before source-loss reset: ${active.join(", ")}`,
    );
  }
}
