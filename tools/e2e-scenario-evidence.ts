import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { readClientLaunchIdentity, verifyLiveClientLaunchBinding } from "./e2e-client";
import { type PreparedE2ERunManifest } from "./e2e-network";
import {
  e2eScenarioCheckpointDefinition,
  e2eScenarioDefinition,
  type E2EClientName,
  type E2EScenarioId,
} from "./e2e-scenario";
import { E2E_UI_EVIDENCE_SCHEMA_VERSION } from "./e2e-ui-evidence";
import { parseBlackglassReleaseManifest } from "./release-manifest";
import {
  computeToolingSourceIdentity,
  toolingSourceTreeEqual,
} from "./tooling-source";

export const E2E_SCENARIO_CHECKPOINT_SCHEMA_VERSION = 2;

interface FileRule {
  group: string;
  clients: readonly E2EClientName[];
  fileName: string;
  expected: "equal" | "present" | "absent";
}

export interface ScenarioFileObservation {
  group: string;
  client: E2EClientName;
  path: string;
  expected: FileRule["expected"];
  exists: boolean;
  size: number | null;
  sha256: string | null;
}

export interface ScenarioDatabaseObservation {
  sha256: string;
  users: Array<{ id: number; status: string; sessions: number }>;
  vaults: Array<{
    name: string;
    ownerUserId: number;
    managedPasswordStored: boolean;
    activeMemberships: number;
    revokedMemberships: number;
    revisionsByUser: Array<{ userId: number; count: number }>;
  }>;
}

export interface ScenarioCheckpointEvidence {
  schemaVersion: typeof E2E_SCENARIO_CHECKPOINT_SCHEMA_VERSION;
  scenarioId: E2EScenarioId;
  checkpoint: string;
  client: E2EClientName;
  observedAt: string;
  previousCheckpointProofSha256: string | null;
  runManifestSha256: string;
  releaseManifestSha256: string;
  launchIdentityPath: string;
  launchIdentitySha256: string;
  uiStatePath: string;
  uiStateSha256: string;
  screenshotPath: string;
  screenshotSha256: string;
  cleanClientResetSha256: string | null;
  database: ScenarioDatabaseObservation;
  files: ScenarioFileObservation[];
}

export function scenarioCheckpointPaths(root: string, checkpoint: string): {
  screenshot: string;
  state: string;
  proof: string;
} {
  const base = resolve(root, "evidence", checkpoint);
  return { screenshot: `${base}.png`, state: `${base}.json`, proof: `${base}.proof.json` };
}

export async function assertScenarioToolingSourceBound(options: {
  root: string;
  run: PreparedE2ERunManifest;
}): Promise<void> {
  const manifestBytes = await readFile(resolve(options.root, options.run.releaseManifestFileName));
  if (sha256(manifestBytes) !== options.run.releaseManifestSha256) {
    throw new Error("Scenario release manifest changed after E2E preparation");
  }
  const releaseManifest = parseBlackglassReleaseManifest(manifestBytes);
  const current = await computeToolingSourceIdentity();
  if (
    releaseManifest.toolingSource.worktreeClean !== true ||
    current.worktreeClean !== true ||
    releaseManifest.toolingSource.gitRevision !== current.gitRevision ||
    !toolingSourceTreeEqual(releaseManifest.toolingSource, current)
  ) {
    throw new Error("Scenario evidence tooling differs from the clean packaged source");
  }
}

export async function buildScenarioCheckpointEvidence(options: {
  root: string;
  run: PreparedE2ERunManifest;
  runManifestSha256: string;
  checkpoint: string;
  capturePaths?: { screenshot: string; state: string };
}): Promise<ScenarioCheckpointEvidence> {
  const scenario = e2eScenarioDefinition(options.run.scenarioId);
  if (scenario.id === "E2E-RELEASE-SYNC-RECOVERY") {
    throw new Error("The release Sync/recovery scenario uses its dedicated verifier");
  }
  const contract = e2eScenarioCheckpointDefinition(scenario.id, options.checkpoint);
  const paths = scenarioCheckpointPaths(options.root, options.checkpoint);
  const stateBytes = await readFile(options.capturePaths?.state ?? paths.state);
  const screenshotBytes = await readFile(options.capturePaths?.screenshot ?? paths.screenshot);
  const state = JSON.parse(stateBytes.toString("utf8")) as Record<string, any>;
  await assertFreshScenarioObservedAt(
    state.observedAt,
    [options.capturePaths?.state ?? paths.state, options.capturePaths?.screenshot ?? paths.screenshot],
    true,
  );
  const launch = await verifyLiveClientLaunchBinding(String(state.launchIdentityPath ?? ""));
  const expectedProfile = resolve(options.root, contract.client, "user-data");
  const expectedVault = resolve(options.root, contract.client, "vault");
  const bodyText = String(state.bodyText ?? "");
  if (
    state.schemaVersion !== E2E_UI_EVIDENCE_SCHEMA_VERSION ||
    state.runManifestSha256 !== options.runManifestSha256 ||
    state.releaseManifestSha256 !== options.run.releaseManifestSha256 ||
    state.screenshotPath !== paths.screenshot ||
    state.screenshotSha256 !== sha256(screenshotBytes) ||
    launch.identity.profilePath !== expectedProfile ||
    launch.identity.vaultPath !== expectedVault ||
    launch.identity.runManifestSha256 !== options.runManifestSha256 ||
    launch.identity.releaseManifestSha256 !== options.run.releaseManifestSha256 ||
    !Number.isFinite(Date.parse(String(state.observedAt)))
  ) {
    throw new Error(`Checkpoint UI evidence is not bound to ${contract.client}: ${options.checkpoint}`);
  }
  for (const required of contract.requiredText) {
    if (!bodyText.includes(required)) {
      throw new Error(`Checkpoint ${options.checkpoint} is missing required UI text: ${required}`);
    }
  }
  for (const forbidden of contract.forbiddenText) {
    if (bodyText.includes(forbidden)) {
      throw new Error(`Checkpoint ${options.checkpoint} contains forbidden UI text: ${forbidden}`);
    }
  }
  if (contract.connected !== undefined) {
    const connected =
      state.syncState?.serverPresent === true && state.syncState?.vaultIdPresent === true;
    if (connected !== contract.connected) {
      throw new Error(
        `Checkpoint ${options.checkpoint} expected connected=${contract.connected}, observed ${connected}`,
      );
    }
  }
  const database = await observeScenarioDatabase(options.root);
  assertDatabaseContract(scenario.id, options.checkpoint, database);
  const files = await observeFiles(options.root, scenario.id, options.checkpoint);
  assertFileContract(files);
  const cleanClientResetSha256 = options.checkpoint.endsWith("cold-bootstrap")
    ? await assertCleanClientLifecycle(options.root, options.runManifestSha256, launch.identity)
    : null;
  const checkpointIndex = scenario.checkpoints.indexOf(options.checkpoint);
  const previousCheckpoint = scenario.checkpoints[checkpointIndex - 1];
  const previousCheckpointProofSha256 = checkpointIndex === 0
    ? null
    : previousCheckpoint
      ? sha256(await readFile(scenarioCheckpointPaths(options.root, previousCheckpoint).proof))
      : (() => { throw new Error("Scenario checkpoint order is malformed"); })();
  return {
    schemaVersion: E2E_SCENARIO_CHECKPOINT_SCHEMA_VERSION,
    scenarioId: scenario.id,
    checkpoint: options.checkpoint,
    client: contract.client,
    observedAt: state.observedAt,
    previousCheckpointProofSha256,
    runManifestSha256: options.runManifestSha256,
    releaseManifestSha256: options.run.releaseManifestSha256,
    launchIdentityPath: launch.identityPath,
    launchIdentitySha256: launch.identitySha256,
    uiStatePath: paths.state,
    uiStateSha256: sha256(stateBytes),
    screenshotPath: paths.screenshot,
    screenshotSha256: sha256(screenshotBytes),
    cleanClientResetSha256,
    database,
    files,
  };
}

export async function assertScenarioCheckpointEvidence(
  value: unknown,
  options: {
    root: string;
    run: PreparedE2ERunManifest;
    runManifestSha256: string;
    checkpoint: string;
  },
): Promise<ScenarioCheckpointEvidence> {
  const scenario = e2eScenarioDefinition(options.run.scenarioId);
  const contract = e2eScenarioCheckpointDefinition(scenario.id, options.checkpoint);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed scenario checkpoint evidence: ${options.checkpoint}`);
  }
  const proof = value as ScenarioCheckpointEvidence;
  const paths = scenarioCheckpointPaths(options.root, options.checkpoint);
  const [stateBytes, screenshotBytes, identityBytes] = await Promise.all([
    readFile(paths.state),
    readFile(paths.screenshot),
    readFile(proof.launchIdentityPath),
  ]);
  const state = JSON.parse(stateBytes.toString("utf8")) as Record<string, any>;
  await assertFreshScenarioObservedAt(proof.observedAt, [paths.state, paths.screenshot], false);
  const identity = await readClientLaunchIdentity(proof.launchIdentityPath);
  const checkpointIndex = scenario.checkpoints.indexOf(options.checkpoint);
  const previousCheckpoint = scenario.checkpoints[checkpointIndex - 1];
  const expectedPreviousProofSha256 = checkpointIndex === 0
    ? null
    : previousCheckpoint
      ? sha256(await readFile(scenarioCheckpointPaths(options.root, previousCheckpoint).proof))
      : (() => { throw new Error("Scenario checkpoint order is malformed"); })();
  const expectedCleanClientResetSha256 = options.checkpoint.endsWith("cold-bootstrap")
    ? await assertCleanClientLifecycle(options.root, options.runManifestSha256, identity)
    : null;
  if (
    proof.schemaVersion !== E2E_SCENARIO_CHECKPOINT_SCHEMA_VERSION ||
    proof.scenarioId !== scenario.id ||
    proof.checkpoint !== options.checkpoint ||
    proof.client !== contract.client ||
    proof.previousCheckpointProofSha256 !== expectedPreviousProofSha256 ||
    proof.runManifestSha256 !== options.runManifestSha256 ||
    proof.releaseManifestSha256 !== options.run.releaseManifestSha256 ||
    !proof.launchIdentityPath.startsWith(`${options.root}/`) ||
    proof.uiStatePath !== paths.state ||
    proof.uiStateSha256 !== sha256(stateBytes) ||
    proof.screenshotPath !== paths.screenshot ||
    proof.screenshotSha256 !== sha256(screenshotBytes) ||
    proof.cleanClientResetSha256 !== expectedCleanClientResetSha256 ||
    proof.launchIdentitySha256 !== sha256(identityBytes) ||
    state.launchIdentityPath !== proof.launchIdentityPath ||
    state.schemaVersion !== E2E_UI_EVIDENCE_SCHEMA_VERSION ||
    state.runManifestSha256 !== options.runManifestSha256 ||
    state.releaseManifestSha256 !== options.run.releaseManifestSha256 ||
    state.screenshotPath !== paths.screenshot ||
    state.observedAt !== proof.observedAt ||
    state.screenshotSha256 !== proof.screenshotSha256 ||
    identity.profilePath !== resolve(options.root, contract.client, "user-data") ||
    identity.vaultPath !== resolve(options.root, contract.client, "vault") ||
    identity.runManifestSha256 !== options.runManifestSha256 ||
    identity.releaseManifestSha256 !== options.run.releaseManifestSha256 ||
    Date.parse(proof.observedAt) < Date.parse(identity.startedAt) ||
    !Number.isFinite(Date.parse(proof.observedAt)) ||
    !Array.isArray(proof.files) ||
    !proof.database || typeof proof.database !== "object"
  ) {
    throw new Error(`Scenario checkpoint evidence changed or is malformed: ${options.checkpoint}`);
  }
  const bodyText = String(state.bodyText ?? "");
  for (const required of contract.requiredText) {
    if (!bodyText.includes(required)) {
      throw new Error(`Checkpoint ${options.checkpoint} is missing required UI text: ${required}`);
    }
  }
  for (const forbidden of contract.forbiddenText) {
    if (bodyText.includes(forbidden)) {
      throw new Error(`Checkpoint ${options.checkpoint} contains forbidden UI text: ${forbidden}`);
    }
  }
  if (contract.connected !== undefined) {
    const connected = state.syncState?.serverPresent === true && state.syncState?.vaultIdPresent === true;
    if (connected !== contract.connected) {
      throw new Error(`Checkpoint ${options.checkpoint} has the wrong connection state`);
    }
  }
  assertDatabaseContract(scenario.id, options.checkpoint, proof.database);
  const { sha256: databaseSha256, ...databaseProjection } = proof.database;
  if (
    !isSha256(databaseSha256) ||
    databaseSha256 !== sha256(Buffer.from(stableJson(databaseProjection)))
  ) {
    throw new Error(`Checkpoint ${options.checkpoint} has a malformed database projection`);
  }
  assertFileContract(proof.files);
  const expectedRules = fileRules(scenario.id, options.checkpoint);
  const expectedFileKeys = expectedRules.flatMap((rule) =>
    rule.clients.map((client) => `${rule.group}\0${client}\0${rule.fileName}\0${rule.expected}`),
  );
  const actualFileKeys = proof.files.map((item) =>
    `${item.group}\0${item.client}\0${item.path.split("/").at(-1)}\0${item.expected}`,
  );
  if (stableJson(actualFileKeys) !== stableJson(expectedFileKeys)) {
    throw new Error(`Checkpoint ${options.checkpoint} has unexpected file observations`);
  }
  for (const item of proof.files) {
    const fileName = item.path.split("/").at(-1);
    if (
      item.path !== `${item.client}/vault/${fileName}` ||
      typeof item.exists !== "boolean" ||
      (item.exists
        ? !Number.isInteger(item.size) || Number(item.size) < 0 || !isSha256(item.sha256)
        : item.size !== null || item.sha256 !== null)
    ) {
      throw new Error(`Checkpoint ${options.checkpoint} has a malformed file observation`);
    }
  }
  return proof;
}

export async function assertFreshScenarioObservedAt(
  value: unknown,
  evidencePaths: readonly string[],
  requireRecent: boolean,
): Promise<void> {
  if (typeof value !== "string") throw new Error("Scenario checkpoint time is missing");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("Scenario checkpoint time is not canonical ISO-8601");
  }
  const now = Date.now();
  if (timestamp > now + 5 * 60_000 || (requireRecent && timestamp < now - 10 * 60_000)) {
    throw new Error("Scenario checkpoint time is outside the allowed capture window");
  }
  for (const path of evidencePaths) {
    const metadata = await stat(path);
    if (Math.abs(metadata.mtimeMs - timestamp) > 10 * 60_000) {
      throw new Error("Scenario checkpoint time is not close to its evidence file metadata");
    }
  }
}

export async function assertCleanClientLifecycle(
  root: string,
  runManifestSha256: string,
  launch: { startedAt: string; profilePath: string; vaultPath: string },
): Promise<string> {
  const path = resolve(root, "client-b-clean-reset.json");
  const bytes = await readFile(path);
  const priorLaunchIdentitySha256 = sha256(
    await readFile(resolve(root, "client-b-launch.json")),
  );
  const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 || record.client !== "client-b" ||
    record.runManifestSha256 !== runManifestSha256 ||
    record.freshProfilePath !== resolve(root, "client-b", "user-data") ||
    record.freshVaultPath !== resolve(root, "client-b", "vault") ||
    record.initialVaultFiles !== 0 || record.initialVaultBytes !== 0 ||
    typeof record.resetAt !== "string" || !Number.isFinite(Date.parse(record.resetAt)) ||
    Date.parse(launch.startedAt) <= Date.parse(record.resetAt) ||
    launch.profilePath !== record.freshProfilePath || launch.vaultPath !== record.freshVaultPath ||
    record.priorLaunchIdentitySha256 !== priorLaunchIdentitySha256
  ) {
    throw new Error("Cold-bootstrap checkpoint lacks a bound clean-client lifecycle transition");
  }
  return sha256(bytes);
}

export async function observeScenarioDatabase(
  root: string,
): Promise<ScenarioDatabaseObservation> {
  const path = resolve(root, "server.sqlite");
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const users = db.query(`
      SELECT users.id, users.status,
        COUNT(CASE
          WHEN sessions.revoked_at IS NULL AND sessions.expires_at > ?
          THEN sessions.token_hash
        END) AS sessions
      FROM users LEFT JOIN sessions ON sessions.user_id = users.id
      GROUP BY users.id, users.status ORDER BY users.id
    `).all(Date.now()) as Array<{ id: number; status: string; sessions: number }>;
    const rawVaults = db.query(`
      SELECT vaults.id, vaults.name, vaults.owner_user_id AS ownerUserId,
        CASE WHEN vaults.password IS NULL THEN 0 ELSE 1 END AS managedPasswordStored,
        SUM(CASE WHEN memberships.revoked_at IS NULL AND memberships.id IS NOT NULL THEN 1 ELSE 0 END) AS activeMemberships,
        SUM(CASE WHEN memberships.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revokedMemberships
      FROM vaults LEFT JOIN memberships ON memberships.vault_id = vaults.id
      GROUP BY vaults.id ORDER BY vaults.created, vaults.id
    `).all() as Array<Record<string, any>>;
    const revisions = db.query(`
      SELECT vault_id AS vaultId, user_id AS userId, COUNT(*) AS count
      FROM revisions GROUP BY vault_id, user_id ORDER BY vault_id, user_id
    `).all() as Array<{ vaultId: string; userId: number; count: number }>;
    const projection = {
      users: users.map((user) => ({
        id: Number(user.id),
        status: String(user.status),
        sessions: Number(user.sessions),
      })),
      vaults: rawVaults.map((vault) => ({
        name: String(vault.name),
        ownerUserId: Number(vault.ownerUserId),
        managedPasswordStored: Boolean(vault.managedPasswordStored),
        activeMemberships: Number(vault.activeMemberships),
        revokedMemberships: Number(vault.revokedMemberships),
        revisionsByUser: revisions
          .filter((revision) => revision.vaultId === vault.id)
          .map(({ userId, count }) => ({ userId: Number(userId), count: Number(count) })),
      })),
    };
    return {
      sha256: sha256(Buffer.from(stableJson(projection))),
      ...projection,
    };
  } finally {
    db.close();
  }
}

function assertDatabaseContract(
  scenarioId: E2EScenarioId,
  checkpoint: string,
  database: ScenarioDatabaseObservation,
): void {
  if (database.users.length < 3) throw new Error("Scenario database lacks three isolated users");
  if (scenarioId === "E2E-P3-TENANCY") {
    if (database.vaults.some((vault) => vault.activeMemberships + vault.revokedMemberships > 0)) {
      throw new Error("Phase 3 scenario unexpectedly contains sharing memberships");
    }
    if (checkpoint.endsWith("client-b-disabled")) {
      const user = database.users.find((candidate) => candidate.id === 2);
      if (user?.status !== "disabled" || user.sessions !== 0) {
        throw new Error("Phase 3 disabled-user checkpoint did not revoke user 2 sessions");
      }
    }
    return;
  }
  const managed = scenarioId === "E2E-P4-MANAGED-ENCRYPTION";
  const name = managed ? "Managed E2E Vault" : "E2E Vault";
  const vault = database.vaults.find((candidate) => candidate.name === name);
  if (!vault || vault.ownerUserId !== 1 || vault.managedPasswordStored !== managed) {
    throw new Error("Phase 4 database does not contain the expected encryption-mode vault");
  }
  const activeExpected = checkpoint.endsWith("owner-removed") ||
    checkpoint.endsWith("former-member-local-copy") || checkpoint.endsWith("self-left")
    ? 0
    : 1;
  if (vault.activeMemberships !== activeExpected) {
    throw new Error(`Phase 4 checkpoint expected ${activeExpected} active membership`);
  }
  if (
    (checkpoint.endsWith("owner-removed") || checkpoint.endsWith("former-member-local-copy") ||
      checkpoint.endsWith("reinvited") || checkpoint.endsWith("self-left") ||
      checkpoint.endsWith("cold-bootstrap")) && vault.revokedMemberships < 1
  ) {
    throw new Error("Phase 4 lifecycle checkpoint lacks a durable revoked membership");
  }
  if (checkpoint.endsWith("self-left") && vault.revokedMemberships < 2) {
    throw new Error("Phase 4 self-leave checkpoint lacks both revocation transitions");
  }
  if (checkpoint.includes("convergence") || checkpoint.includes("history-attribution")) {
    const authors = new Set(vault.revisionsByUser.filter((item) => item.count > 0).map((item) => item.userId));
    if (!authors.has(1) || !authors.has(2)) {
      throw new Error("Phase 4 convergence lacks revisions attributed to both users");
    }
  }
}

async function observeFiles(
  root: string,
  scenarioId: E2EScenarioId,
  checkpoint: string,
): Promise<ScenarioFileObservation[]> {
  const observations: ScenarioFileObservation[] = [];
  for (const rule of fileRules(scenarioId, checkpoint)) {
    for (const client of rule.clients) {
      const path = resolve(root, client, "vault", rule.fileName);
      let bytes: Buffer | null = null;
      try {
        bytes = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      observations.push({
        group: rule.group,
        client,
        path: `${client}/vault/${rule.fileName}`,
        expected: rule.expected,
        exists: bytes !== null,
        size: bytes?.length ?? null,
        sha256: bytes ? sha256(bytes) : null,
      });
    }
  }
  return observations;
}

function fileRules(scenarioId: E2EScenarioId, checkpoint: string): FileRule[] {
  if (scenarioId === "E2E-P3-TENANCY" && checkpoint.endsWith("isolated")) {
    return [
      { group: "tenant-a", clients: ["client-a"], fileName: "Blackglass E2E Tenant A Proof.md", expected: "present" },
      { group: "tenant-a", clients: ["client-b", "client-c"], fileName: "Blackglass E2E Tenant A Proof.md", expected: "absent" },
      { group: "tenant-b", clients: ["client-b"], fileName: "Blackglass E2E Tenant B Proof.md", expected: "present" },
      { group: "tenant-b", clients: ["client-a", "client-c"], fileName: "Blackglass E2E Tenant B Proof.md", expected: "absent" },
    ];
  }
  if (checkpoint.endsWith("bidirectional-convergence")) {
    return [
      { group: "owner", clients: ["client-a", "client-b"], fileName: "Blackglass E2E Owner Proof.md", expected: "equal" },
      { group: "collaborator", clients: ["client-a", "client-b"], fileName: "Blackglass E2E Collaborator Proof.md", expected: "equal" },
      { group: "owner-outsider", clients: ["client-c"], fileName: "Blackglass E2E Owner Proof.md", expected: "absent" },
      { group: "collaborator-outsider", clients: ["client-c"], fileName: "Blackglass E2E Collaborator Proof.md", expected: "absent" },
    ];
  }
  if (checkpoint.endsWith("former-member-local-copy")) {
    return [
      { group: "former-member", clients: ["client-b"], fileName: "Blackglass E2E Former Member Proof.md", expected: "present" },
      { group: "former-member", clients: ["client-a", "client-c"], fileName: "Blackglass E2E Former Member Proof.md", expected: "absent" },
    ];
  }
  if (checkpoint.endsWith("cold-bootstrap")) {
    return [
      { group: "cold-bootstrap", clients: ["client-a", "client-b"], fileName: "Blackglass E2E Cold Bootstrap Proof.md", expected: "equal" },
      { group: "cold-bootstrap-outsider", clients: ["client-c"], fileName: "Blackglass E2E Cold Bootstrap Proof.md", expected: "absent" },
    ];
  }
  return [];
}

function assertFileContract(files: ScenarioFileObservation[]): void {
  for (const item of files) {
    if (item.expected === "absent" ? item.exists : !item.exists) {
      throw new Error(`Scenario file assertion failed: ${item.path} expected ${item.expected}`);
    }
  }
  for (const group of new Set(files.filter((item) => item.expected === "equal").map((item) => item.group))) {
    const members = files.filter((item) => item.group === group && item.expected === "equal");
    if (members.length < 2 || new Set(members.map((item) => item.sha256)).size !== 1) {
      throw new Error(`Scenario file equality assertion failed: ${group}`);
    }
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
