import { describe, expect, test } from "bun:test";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  assertFreshScenarioObservedAt,
  assertCleanClientLifecycle,
  observeScenarioDatabase,
} from "../tools/e2e-scenario-evidence";

describe("scenario database evidence", () => {
  test("projects only unrevoked sessions without exposing token hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-scenario-evidence-"));
    const db = new Database(join(root, "server.sqlite"), { create: true, strict: true });
    db.exec(`
      CREATE TABLE users(id INTEGER PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE sessions(
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE vaults(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id INTEGER NOT NULL,
        password TEXT, created INTEGER NOT NULL
      );
      CREATE TABLE memberships(
        id INTEGER PRIMARY KEY, vault_id TEXT NOT NULL, revoked_at INTEGER
      );
      CREATE TABLE revisions(vault_id TEXT NOT NULL, user_id INTEGER NOT NULL);
      INSERT INTO users VALUES (1, 'active'), (2, 'active'), (3, 'disabled');
      INSERT INTO sessions VALUES
        ('secret-token-digest', 1, 4000000000000, NULL),
        ('expired-token-digest', 2, 1, NULL),
        ('revoked-token-digest', 3, 4000000000000, 1234);
      INSERT INTO vaults VALUES ('secret-vault-id', 'E2E Vault', 1, NULL, 1);
      INSERT INTO memberships VALUES (1, 'secret-vault-id', NULL);
      INSERT INTO revisions VALUES ('secret-vault-id', 1), ('secret-vault-id', 2);
    `);
    db.close();

    const projection = await observeScenarioDatabase(root);
    expect(projection.users).toEqual([
      { id: 1, status: "active", sessions: 1 },
      { id: 2, status: "active", sessions: 0 },
      { id: 3, status: "disabled", sessions: 0 },
    ]);
    expect(projection.vaults[0]).toMatchObject({
      name: "E2E Vault",
      ownerUserId: 1,
      managedPasswordStored: false,
      activeMemberships: 1,
      revokedMemberships: 0,
      revisionsByUser: [{ userId: 1, count: 1 }, { userId: 2, count: 1 }],
    });
    expect(JSON.stringify(projection)).not.toContain("secret-token-digest");
    expect(JSON.stringify(projection)).not.toContain("revoked-token-digest");
    expect(JSON.stringify(projection)).not.toContain("expired-token-digest");
    expect(JSON.stringify(projection)).not.toContain("secret-vault-id");
  });
});

describe("scenario checkpoint freshness", () => {
  test("accepts a current canonical capture close to both evidence mtimes", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-scenario-time-"));
    const state = join(root, "state.json");
    const screenshot = join(root, "state.png");
    await Promise.all([writeFile(state, "{}"), writeFile(screenshot, "png")]);
    const observedAt = new Date().toISOString();
    const seconds = Date.parse(observedAt) / 1_000;
    await Promise.all([utimes(state, seconds, seconds), utimes(screenshot, seconds, seconds)]);
    await expect(assertFreshScenarioObservedAt(observedAt, [state, screenshot], true))
      .resolves.toBeUndefined();
  });

  test("rejects future, stale, noncanonical, and recaptured-file timestamps", async () => {
    const root = await mkdtemp(join(tmpdir(), "blackglass-scenario-time-"));
    const evidence = join(root, "state.json");
    await writeFile(evidence, "{}");
    const now = Date.now();
    await expect(assertFreshScenarioObservedAt(
      new Date(now + 6 * 60_000).toISOString(), [evidence], true,
    )).rejects.toThrow("outside the allowed capture window");
    await expect(assertFreshScenarioObservedAt(
      new Date(now - 11 * 60_000).toISOString(), [evidence], true,
    )).rejects.toThrow("outside the allowed capture window");
    await expect(assertFreshScenarioObservedAt(
      new Date(now).toISOString().replace("Z", "+00:00"), [evidence], true,
    )).rejects.toThrow("not canonical ISO-8601");
    const old = new Date(now - 11 * 60_000).toISOString();
    await expect(assertFreshScenarioObservedAt(old, [evidence], false))
      .rejects.toThrow("not close to its evidence file metadata");
  });
});

test("clean-client lifecycle binds the exact retired launch identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "blackglass-clean-client-evidence-"));
  const prior = Buffer.from("exact initial launch identity\n");
  await writeFile(join(root, "client-b-launch.json"), prior);
  const resetAt = new Date(Date.now() - 2_000).toISOString();
  const record = {
    schemaVersion: 1,
    client: "client-b",
    runManifestSha256: "a".repeat(64),
    freshProfilePath: join(root, "client-b/user-data"),
    freshVaultPath: join(root, "client-b/vault"),
    initialVaultFiles: 0,
    initialVaultBytes: 0,
    resetAt,
    priorLaunchIdentitySha256: "b".repeat(64),
  };
  await writeFile(join(root, "client-b-clean-reset.json"), `${JSON.stringify(record)}\n`);
  const launch = {
    startedAt: new Date().toISOString(),
    profilePath: record.freshProfilePath,
    vaultPath: record.freshVaultPath,
  };
  await expect(assertCleanClientLifecycle(root, record.runManifestSha256, launch))
    .rejects.toThrow("lacks a bound clean-client lifecycle transition");
  record.priorLaunchIdentitySha256 = createHash("sha256").update(prior).digest("hex");
  await writeFile(join(root, "client-b-clean-reset.json"), `${JSON.stringify(record)}\n`);
  await expect(assertCleanClientLifecycle(root, record.runManifestSha256, launch))
    .resolves.toMatch(/^[a-f0-9]{64}$/u);
});
