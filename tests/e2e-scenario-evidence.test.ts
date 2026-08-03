import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { observeScenarioDatabase } from "../tools/e2e-scenario-evidence";

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
