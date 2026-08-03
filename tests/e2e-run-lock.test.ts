import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  acquireCheckpointPublicationLease,
  acquirePreparedClientLease,
  acquireSourceLossResetLock,
  assertNoCheckpointPublicationLeases,
  releaseCheckpointPublicationLease,
  releasePreparedClientLease,
  releaseSourceLossResetLock,
} from "../tools/e2e-run-lock";

describe("prepared-run launch/reset locking", () => {
  test("an active client lease excludes source-loss reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    try {
      const lease = await acquirePreparedClientLease(root, "client-a");
      await expect(
        acquireSourceLossResetLock(root, "a".repeat(64), [
          "client-a",
          "client-b",
          "client-c",
        ]),
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
      const lock = await acquireSourceLossResetLock(root, revision, [
        "client-a",
        "client-b",
        "client-c",
      ]);
      await expect(acquirePreparedClientLease(root, "client-b")).rejects.toThrow(
        "locked for source-loss reset",
      );
      await releaseSourceLossResetLock(lock, revision);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a targeted client reset permits unrelated live capture clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    const revision = "f".repeat(64);
    try {
      const clientA = await acquirePreparedClientLease(root, "client-a");
      const clientC = await acquirePreparedClientLease(root, "client-c");
      const lock = await acquireSourceLossResetLock(root, revision, ["client-b"]);
      for (const client of ["client-a", "client-b", "client-c"] as const) {
        await expect(acquirePreparedClientLease(root, client)).rejects.toThrow(
          "locked for source-loss reset",
        );
      }
      await releaseSourceLossResetLock(lock, revision);
      await releasePreparedClientLease(clientA);
      await releasePreparedClientLease(clientC);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a targeted client reset still rejects the target's live lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    const revision = "1".repeat(64);
    try {
      const clientB = await acquirePreparedClientLease(root, "client-b");
      await expect(
        acquireSourceLossResetLock(root, revision, ["client-b"]),
      ).rejects.toThrow("Stop prepared clients before source-loss reset: client-b");
      await releasePreparedClientLease(clientB);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires an explicit non-empty unique reset scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    const revision = "2".repeat(64);
    try {
      await expect(acquireSourceLossResetLock(root, revision, [])).rejects.toThrow(
        "non-empty unique prepared-client scope",
      );
      await expect(
        acquireSourceLossResetLock(root, revision, ["client-b", "client-b"]),
      ).rejects.toThrow("non-empty unique prepared-client scope");
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
      const lock = await acquireSourceLossResetLock(root, revision, [
        "client-a",
        "client-b",
        "client-c",
      ]);
      await releaseSourceLossResetLock(lock, revision);

      const active = await acquirePreparedClientLease(root, "client-b");
      await expect(acquireSourceLossResetLock(root, revision, [
        "client-a",
        "client-b",
        "client-c",
      ])).rejects.toThrow(
        "Stop prepared clients",
      );
      await releasePreparedClientLease(active);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serializes checkpoint publishers with an owner-bound lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-run-lock-"));
    const checkpoint = "evidence/client-a/settings";
    try {
      const attempts = await Promise.allSettled([
        acquireCheckpointPublicationLease(root, checkpoint),
        acquireCheckpointPublicationLease(root, checkpoint),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
      await expect(assertNoCheckpointPublicationLeases(root)).rejects.toThrow(
        "Checkpoint publication leases remain",
      );
      const winner = attempts.find((attempt) => attempt.status === "fulfilled");
      if (!winner || winner.status !== "fulfilled") throw new Error("No lease winner");
      await releaseCheckpointPublicationLease(winner.value, checkpoint);
      await expect(assertNoCheckpointPublicationLeases(root)).resolves.toBeUndefined();
      const checkpointDirectory = join(root, "evidence/client-a");
      await mkdir(checkpointDirectory, { recursive: true });
      const crashedLease = await acquireCheckpointPublicationLease(root, checkpoint);
      const stale = JSON.parse(await readFile(crashedLease, "utf8"));
      stale.pid = 2_147_483_647;
      stale.processStartIdentity = "f".repeat(64);
      await writeFile(crashedLease, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
      const abandoned = await mkdtemp(join(checkpointDirectory, ".checkpoint-capture-"));
      await writeFile(join(abandoned, "capture.png"), "partial capture", { mode: 0o600 });
      const recovered = await acquireCheckpointPublicationLease(root, checkpoint);
      await releaseCheckpointPublicationLease(recovered, checkpoint);
      await expect(assertNoCheckpointPublicationLeases(root)).resolves.toBeUndefined();
      const recoveredAttempts = await readdir(join(root, "evidence/failed-attempts"));
      expect(recoveredAttempts.some((name) => name.includes("recovered-"))).toBe(true);

      await mkdtemp(join(checkpointDirectory, ".checkpoint-capture-"));
      await expect(assertNoCheckpointPublicationLeases(root)).rejects.toThrow(
        "Checkpoint publication staging remains",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
