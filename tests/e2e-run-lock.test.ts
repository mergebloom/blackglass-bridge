import { mkdtemp, rm } from "node:fs/promises";
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
});
