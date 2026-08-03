import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  acquirePreparedClientLease,
  acquireSourceLossResetLock,
  releasePreparedClientLease,
  releaseSourceLossResetLock,
} from "../tools/e2e-run-lock";

describe("prepared-run launch/reset locking", () => {
  test("an active client lease excludes source-loss reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    try {
      const lease = await acquirePreparedClientLease(root, "client-a");
      await expect(
        acquireSourceLossResetLock(root, "a".repeat(64)),
      ).rejects.toThrow("Stop prepared clients");
      await releasePreparedClientLease(lease);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an active source-loss reset excludes new client leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    const revision = "b".repeat(64);
    try {
      const lock = await acquireSourceLossResetLock(root, revision);
      await expect(acquirePreparedClientLease(root, "client-b")).rejects.toThrow(
        "locked for source-loss reset",
      );
      await releaseSourceLossResetLock(lock, revision);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers an exact dead-owner lease but preserves active and malformed locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    try {
      const path = join(root, ".client-a.launch.lock");
      await writeFile(path, `${JSON.stringify({
        schemaVersion: 3,
        pid: 2_147_483_647,
        clientName: "client-a",
        acquiredAt: new Date().toISOString(),
        ownerNonce: "dead-owner-nonce",
        executable: "/dead/process",
        argumentsSha256: "a".repeat(64),
        processStartIdentity: "b".repeat(64),
      })}\n`, { mode: 0o600 });
      const recovered = await acquirePreparedClientLease(root, "client-a");
      await expect(acquirePreparedClientLease(root, "client-a")).rejects.toThrow(
        "Active prepared-client launch lease",
      );
      await releasePreparedClientLease(recovered);

      await writeFile(path, "not-json\n", { mode: 0o600 });
      await expect(acquirePreparedClientLease(root, "client-a")).rejects.toThrow(
        "Refusing malformed prepared-client launch lease",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("source-loss reset recovers dead leases and rejects only the exact live process identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    const revision = "c".repeat(64);
    const path = join(root, ".client-b.launch.lock");
    try {
      const staleLease = {
        schemaVersion: 3,
        pid: process.pid,
        clientName: "client-b",
        acquiredAt: new Date().toISOString(),
        ownerNonce: "reused-process-nonce",
        executable: process.execPath,
        argumentsSha256: "d".repeat(64),
        processStartIdentity: "e".repeat(64),
      };
      await writeFile(path, `${JSON.stringify(staleLease)}\n`, { mode: 0o600 });
      const lock = await acquireSourceLossResetLock(root, revision);
      await releaseSourceLossResetLock(lock, revision);

      const active = await acquirePreparedClientLease(root, "client-b");
      await expect(acquireSourceLossResetLock(root, revision)).rejects.toThrow(
        "Stop prepared clients",
      );
      await releasePreparedClientLease(active);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
