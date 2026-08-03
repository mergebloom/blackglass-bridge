import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { deriveE2ENetworkPlan } from "../tools/e2e-network";
import { assertNoObservationPublicationResidue } from "../tools/observation-publication";
import { pathExists } from "../tools/path-safety";

const repositoryRoot = resolve(import.meta.dir, "..");
const e2eRoot = resolve(repositoryRoot, ".data/e2e");
const observer = resolve(repositoryRoot, "tools/observe-e2e.ts");

describe("resumable background Sync observations", () => {
  test("resumes the exact transfer intent after a bounded timeout", async () => {
    await mkdir(e2eRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(e2eRoot, "observe-test-"));
    try {
      const manifest = preparedManifest();
      await writeFile(
        join(root, "run-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      for (const client of ["client-a", "client-b"]) {
        await mkdir(join(root, client, "vault"), { recursive: true, mode: 0o700 });
      }
      const database = new Database(join(root, "server.sqlite"), { create: true, strict: true });
      database.exec(`
        CREATE TABLE revisions (uid INTEGER NOT NULL);
        CREATE TABLE vaults (
          created INTEGER NOT NULL,
          version INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        INSERT INTO vaults (created, version, size) VALUES (1, 1, 0);
      `);
      database.close();

      const first = await runObserver(root, "1000");
      expect(first.exitCode).toBe(1);
      expect(first.stderr).toContain("Timed out waiting for background Sync transfer");
      const source = join(root, "client-a/vault/E2E Sync Proof.md");
      const destination = join(root, "client-b/vault/E2E Sync Proof.md");
      const output = join(root, "observations/transfer-e2e-sync-proof.json");
      const intent = `${output}.intent`;
      expect(await pathExists(source)).toBe(true);
      expect(await pathExists(intent)).toBe(true);
      expect(await pathExists(output)).toBe(false);
      const savedIntent = await readFile(intent);

      await writeFile(destination, await readFile(source), { flag: "wx", mode: 0o600 });
      const advanced = new Database(join(root, "server.sqlite"), { strict: true });
      advanced.exec(`
        INSERT INTO revisions (uid) VALUES (1);
        UPDATE vaults SET version = 2, size = 128;
      `);
      advanced.close();

      const resumed = await runObserver(root, "1000");
      expect(resumed.exitCode).toBe(0);
      const observation = JSON.parse(resumed.stdout) as any;
      expect(observation.action).toBe("transfer");
      expect(observation.databaseBefore).toEqual({
        revisions: 0,
        maxUid: 0,
        vaultVersion: 1,
        vaultSize: 0,
      });
      expect(observation.databaseAfter).toEqual({
        revisions: 1,
        maxUid: 1,
        vaultVersion: 2,
        vaultSize: 128,
      });
      expect(await pathExists(output)).toBe(true);
      expect(await pathExists(intent)).toBe(false);

      await writeFile(intent, savedIntent, { flag: "wx", mode: 0o600 });
      const finalizedPublished = await runObserver(root, "1000");
      expect(finalizedPublished.exitCode).toBe(0);
      expect(await pathExists(intent)).toBe(false);

      await rename(output, `${output}.next`);
      await writeFile(intent, savedIntent, { flag: "wx", mode: 0o600 });
      const finalizedPending = await runObserver(root, "1000");
      expect(finalizedPending.exitCode).toBe(0);
      expect(await pathExists(output)).toBe(true);
      expect(await pathExists(`${output}.next`)).toBe(false);
      expect(await pathExists(intent)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a changed proof instead of resuming its intent", async () => {
    await mkdir(e2eRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(e2eRoot, "observe-test-"));
    try {
      await writeFile(
        join(root, "run-manifest.json"),
        `${JSON.stringify(preparedManifest(), null, 2)}\n`,
        { mode: 0o600 },
      );
      for (const client of ["client-a", "client-b"]) {
        await mkdir(join(root, client, "vault"), { recursive: true, mode: 0o700 });
      }
      const database = new Database(join(root, "server.sqlite"), { create: true, strict: true });
      database.exec(`
        CREATE TABLE revisions (uid INTEGER NOT NULL);
        CREATE TABLE vaults (created INTEGER NOT NULL, version INTEGER NOT NULL, size INTEGER NOT NULL);
        INSERT INTO vaults (created, version, size) VALUES (1, 1, 0);
      `);
      database.close();
      expect((await runObserver(root, "1000")).exitCode).toBe(1);
      const intentPath = join(root, "observations/transfer-e2e-sync-proof.json.intent");
      const originalIntent = await readFile(intentPath, "utf8");
      const changedIntent = JSON.parse(originalIntent);
      changedIntent.markerSha256 = sha256("unrelated marker");
      await writeFile(intentPath, `${JSON.stringify(changedIntent, null, 2)}\n`, { mode: 0o600 });
      const mismatchedMarker = await runObserver(root, "1000");
      expect(mismatchedMarker.exitCode).toBe(1);
      expect(mismatchedMarker.stderr).toContain("Invalid or mismatched resumable observation intent");
      await writeFile(intentPath, originalIntent, { mode: 0o600 });
      await writeFile(join(root, "client-a/vault/E2E Sync Proof.md"), "tampered\n");
      const resumed = await runObserver(root, "1000");
      expect(resumed.exitCode).toBe(1);
      expect(resumed.stderr).toContain("Resumable transfer source changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resumes the exact deletion intent after a bounded timeout", async () => {
    await mkdir(e2eRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(e2eRoot, "observe-test-"));
    try {
      await writeFile(
        join(root, "run-manifest.json"),
        `${JSON.stringify(preparedManifest(), null, 2)}\n`,
        { mode: 0o600 },
      );
      const proof = Buffer.from("delete through background Sync\n");
      for (const client of ["client-a", "client-b"]) {
        const vault = join(root, client, "vault");
        await mkdir(vault, { recursive: true, mode: 0o700 });
        await writeFile(join(vault, "Deletion Sync Proof.md"), proof, { mode: 0o600 });
      }
      const database = new Database(join(root, "server.sqlite"), { create: true, strict: true });
      database.exec(`
        CREATE TABLE revisions (uid INTEGER NOT NULL);
        CREATE TABLE vaults (created INTEGER NOT NULL, version INTEGER NOT NULL, size INTEGER NOT NULL);
        INSERT INTO vaults (created, version, size) VALUES (1, 1, 64);
      `);
      database.close();

      const first = await runObserver(
        root,
        "1000",
        "delete",
        "Deletion Sync Proof.md",
      );
      expect(first.exitCode).toBe(1);
      expect(first.stderr).toContain("Timed out waiting for background Sync deletion");
      const destination = join(root, "client-b/vault/Deletion Sync Proof.md");
      await rm(destination);
      const advanced = new Database(join(root, "server.sqlite"), { strict: true });
      advanced.exec(`
        INSERT INTO revisions (uid) VALUES (1);
        UPDATE vaults SET version = 2, size = 0;
      `);
      advanced.close();

      const resumed = await runObserver(
        root,
        "1000",
        "delete",
        "Deletion Sync Proof.md",
      );
      expect(resumed.exitCode).toBe(0);
      expect(JSON.parse(resumed.stdout).action).toBe("delete");
      expect(await pathExists(
        join(root, "observations/delete-deletion-sync-proof.json.intent"),
      )).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("clears a stale intent when no proof mutation occurred", async () => {
    await mkdir(e2eRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(e2eRoot, "observe-test-"));
    try {
      await prepareRoot(root);
      expect((await runObserver(root, "1000")).exitCode).toBe(1);
      await rm(join(root, "client-a/vault/E2E Sync Proof.md"));
      const database = new Database(join(root, "server.sqlite"), { strict: true });
      database.exec(`
        INSERT INTO revisions (uid) VALUES (1);
        UPDATE vaults SET version = 2, size = 64;
      `);
      database.close();
      const stale = await runObserver(root, "1000");
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr).toContain("cleared the unstarted intent");
      expect(await pathExists(
        join(root, "observations/transfer-e2e-sync-proof.json.intent"),
      )).toBe(false);
      const fresh = await runObserver(root, "1000");
      expect(fresh.stderr).toContain("Timed out waiting for background Sync transfer");
      expect(await pathExists(join(root, "client-a/vault/E2E Sync Proof.md"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects every unpublished observation residue", async () => {
    await mkdir(e2eRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(e2eRoot, "observe-test-"));
    try {
      await mkdir(join(root, "observations"), { mode: 0o700 });
      await writeFile(join(root, "observations/unexpected-proof.json.intent"), "{}\n", {
        mode: 0o600,
      });
      await expect(assertNoObservationPublicationResidue(root)).rejects.toThrow(
        "Unpublished Sync observation evidence remains",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function runObserver(
  root: string,
  timeout: string,
  action = "transfer",
  proof = "E2E Sync Proof.md",
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([
    process.execPath,
    "run",
    observer,
    action,
    root,
    "client-a",
    "client-b",
    proof,
    "--timeout-ms",
    timeout,
  ], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function preparedManifest() {
  const endpoints = {
    controlOrigin: "https://sync.example.test",
    dataHost: "sync-data.example.test",
  };
  return {
    schemaVersion: 5,
    scenarioId: "E2E-RELEASE-SYNC-RECOVERY",
    endpoints,
    network: deriveE2ENetworkPlan(endpoints),
    compatibilityAsarSha256: sha256("adapter"),
    releaseManifestSha256: sha256("release"),
    adapterFileName: "adapter.bin",
    releaseManifestFileName: "release.json",
    reproducibilityEvidenceFileName: "reproducibility.json",
    reproducibilityEvidenceSha256: sha256("reproducibility"),
  };
}

async function prepareRoot(root: string): Promise<void> {
  await writeFile(
    join(root, "run-manifest.json"),
    `${JSON.stringify(preparedManifest(), null, 2)}\n`,
    { mode: 0o600 },
  );
  for (const client of ["client-a", "client-b"]) {
    await mkdir(join(root, client, "vault"), { recursive: true, mode: 0o700 });
  }
  const database = new Database(join(root, "server.sqlite"), { create: true, strict: true });
  database.exec(`
    CREATE TABLE revisions (uid INTEGER NOT NULL);
    CREATE TABLE vaults (created INTEGER NOT NULL, version INTEGER NOT NULL, size INTEGER NOT NULL);
    INSERT INTO vaults (created, version, size) VALUES (1, 1, 0);
  `);
  database.close();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
