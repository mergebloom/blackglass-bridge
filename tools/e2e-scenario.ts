export const E2E_SCENARIO_IDS = [
  "E2E-RELEASE-SYNC-RECOVERY",
  "E2E-P3-TENANCY",
  "E2E-P4-CUSTOM-E2EE",
  "E2E-P4-MANAGED-ENCRYPTION",
] as const;

export type E2EScenarioId = (typeof E2E_SCENARIO_IDS)[number];

export type E2EClientName = "client-a" | "client-b" | "client-c";

export interface E2EScenarioDefinition {
  id: E2EScenarioId;
  clients: readonly E2EClientName[];
  checkpoints: readonly string[];
  validationPrefix: string;
}

export interface E2EScenarioCheckpointDefinition {
  path: string;
  client: E2EClientName;
  requiredText: readonly string[];
  forbiddenText: readonly string[];
  connected?: boolean;
}

export const DEFAULT_E2E_SCENARIO: E2EScenarioId =
  "E2E-RELEASE-SYNC-RECOVERY";

const DEFINITIONS: Record<E2EScenarioId, E2EScenarioDefinition> = {
  "E2E-RELEASE-SYNC-RECOVERY": {
    id: "E2E-RELEASE-SYNC-RECOVERY",
    clients: ["client-a", "client-b"],
    checkpoints: [
      "client-a/settings",
      "client-a/created",
      "client-a/unlocked",
      "client-b/vault-chooser",
      "client-b/converged",
      "client-b/deleted-files",
    ],
    validationPrefix: "blackglass-release-sync-recovery",
  },
  "E2E-P3-TENANCY": {
    id: "E2E-P3-TENANCY",
    clients: ["client-a", "client-b", "client-c"],
    checkpoints: [
      "phase-3/client-a-owned-vault",
      "phase-3/client-a-converged",
      "phase-3/client-b-owned-vault",
      "phase-3/client-b-converged",
      "phase-3/client-a-isolated",
      "phase-3/client-b-isolated",
      "phase-3/client-c-isolated",
      "phase-3/client-a-reauthenticated",
      "phase-3/client-b-disabled",
    ],
    validationPrefix: "phase-3-tenancy",
  },
  "E2E-P4-CUSTOM-E2EE": {
    id: "E2E-P4-CUSTOM-E2EE",
    clients: ["client-a", "client-b", "client-c"],
    checkpoints: [
      "phase-4-custom/owner-share-list",
      "phase-4-custom/collaborator-shared-inventory",
      "phase-4-custom/wrong-password",
      "phase-4-custom/connected",
      "phase-4-custom/outsider-isolated",
      "phase-4-custom/bidirectional-convergence",
      "phase-4-custom/history-attribution",
      "phase-4-custom/owner-removed",
      "phase-4-custom/former-member-local-copy",
      "phase-4-custom/reinvited",
      "phase-4-custom/self-left",
      "phase-4-custom/cold-bootstrap",
    ],
    validationPrefix: "phase-4-custom-e2ee",
  },
  "E2E-P4-MANAGED-ENCRYPTION": {
    id: "E2E-P4-MANAGED-ENCRYPTION",
    clients: ["client-a", "client-b", "client-c"],
    checkpoints: [
      "phase-4-managed/owner-share-list",
      "phase-4-managed/collaborator-shared-inventory",
      "phase-4-managed/connected-without-password",
      "phase-4-managed/outsider-isolated",
      "phase-4-managed/bidirectional-convergence",
      "phase-4-managed/history-attribution",
      "phase-4-managed/owner-removed",
      "phase-4-managed/former-member-local-copy",
      "phase-4-managed/reinvited",
      "phase-4-managed/self-left",
      "phase-4-managed/cold-bootstrap",
    ],
    validationPrefix: "phase-4-managed-encryption",
  },
};

export function parseE2EScenarioId(value: unknown): E2EScenarioId {
  if (
    typeof value !== "string" ||
    !E2E_SCENARIO_IDS.includes(value as E2EScenarioId)
  ) {
    throw new Error(
      `Unsupported E2E scenario: ${String(value)}. Expected one of ${E2E_SCENARIO_IDS.join(", ")}`,
    );
  }
  return value as E2EScenarioId;
}

export function preparedE2EScenarioId(value: unknown): E2EScenarioId {
  return value === undefined
    ? DEFAULT_E2E_SCENARIO
    : parseE2EScenarioId(value);
}

export function e2eScenarioDefinition(value: unknown): E2EScenarioDefinition {
  return DEFINITIONS[parseE2EScenarioId(value)];
}

export function scenarioValidationFileName(
  scenarioValue: unknown,
  rendererVersion: string,
  serverRevision: string,
): string {
  const scenario = e2eScenarioDefinition(scenarioValue);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(rendererVersion)) {
    throw new Error("Scenario validation renderer version is malformed");
  }
  if (!/^[a-f0-9]{40}$/u.test(serverRevision)) {
    throw new Error("Scenario validation server revision is malformed");
  }
  return `${scenario.validationPrefix}-obsidian-${rendererVersion}-${serverRevision}.json`;
}

const CHECKPOINTS: Record<string, Omit<E2EScenarioCheckpointDefinition, "path">> = {
  "phase-3/client-a-owned-vault": connected("client-a"),
  "phase-3/client-a-converged": connected("client-a"),
  "phase-3/client-b-owned-vault": connected("client-b"),
  "phase-3/client-b-converged": connected("client-b"),
  "phase-3/client-a-isolated": connected("client-a"),
  "phase-3/client-b-isolated": connected("client-b"),
  "phase-3/client-c-isolated": {
    client: "client-c",
    requiredText: ["You don't have any remote vaults."],
    forbiddenText: ["Blackglass E2E Tenant A", "Blackglass E2E Tenant B"],
    connected: false,
  },
  "phase-3/client-a-reauthenticated": connected("client-a"),
  "phase-3/client-b-disabled": {
    client: "client-b",
    requiredText: [],
    forbiddenText: [],
    connected: false,
  },
  "phase-4-custom/owner-share-list": sharing("client-a", "E2E Vault"),
  "phase-4-custom/collaborator-shared-inventory": sharedInventory("E2E Vault"),
  "phase-4-custom/wrong-password": {
    client: "client-b",
    requiredText: ["Unable to access vault", "Unlock your remote vault"],
    forbiddenText: [],
    connected: false,
  },
  "phase-4-custom/connected": connected("client-b"),
  "phase-4-custom/outsider-isolated": outsider("E2E Vault"),
  "phase-4-custom/bidirectional-convergence": connected("client-b"),
  "phase-4-custom/history-attribution": connected("client-a", [
    "Activity log",
    "Blackglass E2E Owner Proof.md",
    "Blackglass E2E Collaborator Proof.md",
  ]),
  "phase-4-custom/owner-removed": disconnected("client-b"),
  "phase-4-custom/former-member-local-copy": disconnected("client-b"),
  "phase-4-custom/reinvited": sharedInventory("E2E Vault"),
  "phase-4-custom/self-left": outsider("E2E Vault", "client-b"),
  "phase-4-custom/cold-bootstrap": connected("client-b"),
  "phase-4-managed/owner-share-list": sharing("client-a", "Managed E2E Vault"),
  "phase-4-managed/collaborator-shared-inventory": sharedInventory("Managed E2E Vault"),
  "phase-4-managed/connected-without-password": {
    client: "client-b",
    requiredText: ["Confirm Merge Vault"],
    forbiddenText: ["Unlock your remote vault", "Encryption password"],
    connected: false,
  },
  "phase-4-managed/outsider-isolated": outsider("Managed E2E Vault"),
  "phase-4-managed/bidirectional-convergence": connected("client-b"),
  "phase-4-managed/history-attribution": connected("client-a", [
    "Activity log",
    "Blackglass E2E Owner Proof.md",
    "Blackglass E2E Collaborator Proof.md",
  ]),
  "phase-4-managed/owner-removed": disconnected("client-b"),
  "phase-4-managed/former-member-local-copy": disconnected("client-b"),
  "phase-4-managed/reinvited": sharedInventory("Managed E2E Vault"),
  "phase-4-managed/self-left": outsider("Managed E2E Vault", "client-b"),
  "phase-4-managed/cold-bootstrap": connected("client-b"),
};

export function e2eScenarioCheckpointDefinition(
  scenarioValue: unknown,
  checkpoint: string,
): E2EScenarioCheckpointDefinition {
  const scenario = e2eScenarioDefinition(scenarioValue);
  if (!scenario.checkpoints.includes(checkpoint)) {
    throw new Error(`Checkpoint ${checkpoint} is not part of ${scenario.id}`);
  }
  const definition = CHECKPOINTS[checkpoint];
  if (!definition) throw new Error(`Checkpoint ${checkpoint} has no executable contract`);
  return { path: checkpoint, ...definition };
}

function connected(
  client: E2EClientName,
  requiredText: readonly string[] = [],
): Omit<E2EScenarioCheckpointDefinition, "path"> {
  return {
    client,
    requiredText: [
      "Currently connected to the",
      "Obsidian Sync is currently running.",
      ...requiredText,
    ],
    forbiddenText: [],
    connected: true,
  };
}

function disconnected(
  client: E2EClientName,
): Omit<E2EScenarioCheckpointDefinition, "path"> {
  return { client, requiredText: [], forbiddenText: [], connected: false };
}

function sharing(
  client: E2EClientName,
  vaultName: string,
): Omit<E2EScenarioCheckpointDefinition, "path"> {
  return {
    client,
    requiredText: [`Manage sharing for “${vaultName}”`, "currently shared with"],
    forbiddenText: [],
  };
}

function sharedInventory(
  vaultName: string,
): Omit<E2EScenarioCheckpointDefinition, "path"> {
  return {
    client: "client-b",
    requiredText: ["Vaults shared with you", vaultName, "Connect"],
    forbiddenText: [],
    connected: false,
  };
}

function outsider(
  vaultName: string,
  client: E2EClientName = "client-c",
): Omit<E2EScenarioCheckpointDefinition, "path"> {
  return {
    client,
    requiredText: ["You don't have any remote vaults."],
    forbiddenText: [vaultName, "Vaults shared with you"],
    connected: false,
  };
}
