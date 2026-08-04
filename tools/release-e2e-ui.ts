import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readClientLaunchIdentity } from "./e2e-client";
import {
  E2E_UI_EVIDENCE_SCHEMA_VERSION,
  e2eUiSnapshotText,
  isBoundE2EUiSnapshotPage,
} from "./e2e-ui-evidence";

export const RELEASE_UI_CHECKPOINT_PROOF_SCHEMA_VERSION = 1;

export type ReleaseUiCheckpoint = {
  client: "client-a" | "client-b";
  path: string;
  requiredText: readonly string[];
  requiredBodyText?: readonly string[];
  requiredAccessibleText?: readonly string[];
  forbiddenText: readonly string[];
};

const RELEASE_UI_CHECKPOINTS: readonly ReleaseUiCheckpoint[] = [
  {
    client: "client-a",
    path: "evidence/client-a/settings",
    requiredText: ["Automatic updates", "Your account"],
    forbiddenText: ["quit unexpectedly"],
  },
  {
    client: "client-a",
    path: "evidence/client-a/created",
    requiredText: ["Your remote vaults", "E2E Vault", "Blackglass Server"],
    forbiddenText: ["Unable to connect"],
  },
  {
    client: "client-a",
    path: "evidence/client-a/unlocked",
    requiredText: ["Setup connection", "connected to", "E2E Vault", "Start syncing"],
    forbiddenText: ["Unable to retrieve your vault size", "Unable to connect"],
  },
  {
    client: "client-b",
    path: "evidence/client-b/vault-chooser",
    requiredText: ["Your remote vaults", "E2E Vault", "Blackglass Server"],
    forbiddenText: ["Unable to connect"],
  },
  {
    client: "client-b",
    path: "evidence/client-b/converged",
    requiredText: ["E2E Vault", "Fully synced", "E2E Sync Proof"],
    forbiddenText: ["Unable to", "Sync error"],
  },
  {
    client: "client-b",
    path: "evidence/client-b/deleted-files",
    requiredText: ["Deleted files", "Deletion Sync Proof"],
    forbiddenText: ["Unable to", "Sync error"],
  },
  {
    client: "client-b",
    path: "evidence/recovery/client-b-restored",
    requiredText: ["Recovery Drill Home", "Fully synced"],
    requiredBodyText: ["Recovery Drill Home"],
    requiredAccessibleText: ["Fully synced"],
    forbiddenText: ["Unable to", "Sync error"],
  },
] as const;

export function releaseUiCheckpoints(rendererVersion: string): readonly ReleaseUiCheckpoint[] {
  if (!/^\d+\.\d+\.\d+$/u.test(rendererVersion)) {
    throw new Error("Release UI renderer version is malformed");
  }
  return RELEASE_UI_CHECKPOINTS.map((checkpoint, index) => index === 0
    ? { ...checkpoint, requiredText: [`Version ${rendererVersion}`, ...checkpoint.requiredText] }
    : checkpoint);
}

export function releasePrimaryUiCheckpoints(
  rendererVersion: string,
): readonly ReleaseUiCheckpoint[] {
  return releaseUiCheckpoints(rendererVersion).slice(0, -1);
}

export function releaseUiCheckpoint(
  path: string,
  rendererVersion: string,
): ReleaseUiCheckpoint {
  const checkpoint = releaseUiCheckpoints(rendererVersion).find((item) => item.path === path);
  if (!checkpoint) throw new Error(`Unsupported release UI checkpoint: ${path}`);
  return checkpoint;
}

export function releaseUiCheckpointPaths(root: string, path: string): {
  screenshot: string;
  state: string;
  proof: string;
} {
  const base = resolve(root, path);
  return {
    screenshot: `${base}.png`,
    state: `${base}.json`,
    proof: `${base}.proof.json`,
  };
}

export function assertReleaseUiCheckpointContent(
  checkpoint: ReleaseUiCheckpoint,
  state: Record<string, unknown>,
  launchStartedAt: string,
  now = Date.now(),
): void {
  const text = e2eUiSnapshotText(state);
  if (!text || typeof state.observedAt !== "string") {
    throw new Error(`Release UI checkpoint has malformed content: ${checkpoint.path}`);
  }
  const observedAt = Date.parse(state.observedAt);
  const startedAt = Date.parse(launchStartedAt);
  if (
    !Number.isFinite(observedAt) || !Number.isFinite(startedAt) ||
    observedAt <= startedAt || observedAt > now + 5_000
  ) {
    throw new Error(`Release UI checkpoint has an invalid observation time: ${checkpoint.path}`);
  }
  for (const required of checkpoint.requiredText) {
    if (!text.combined.includes(required)) {
      throw new Error(`Release UI checkpoint is missing required text: ${required}`);
    }
  }
  for (const required of checkpoint.requiredBodyText ?? []) {
    if (!text.bodyText.includes(required)) {
      throw new Error(`Release UI checkpoint body is missing required text: ${required}`);
    }
  }
  for (const required of checkpoint.requiredAccessibleText ?? []) {
    if (!text.accessibleText.includes(required)) {
      throw new Error(`Release UI checkpoint accessibility tree is missing exact text: ${required}`);
    }
  }
  for (const forbidden of checkpoint.forbiddenText) {
    if (text.combined.toLowerCase().includes(forbidden.toLowerCase())) {
      throw new Error(`Release UI checkpoint contains failure text: ${forbidden}`);
    }
  }
}

export function assertReleaseUiCheckpointProof(options: {
  checkpoint: ReleaseUiCheckpoint;
  proof: Record<string, unknown>;
  observedAt: string;
  previousCheckpointProofSha256: string | null;
  runManifestSha256: string;
  releaseManifestSha256: string;
  launchIdentitySha256: string;
  stateBytes: Uint8Array;
  screenshotBytes: Uint8Array;
}): void {
  const { checkpoint, proof } = options;
  if (
    proof.schemaVersion !== RELEASE_UI_CHECKPOINT_PROOF_SCHEMA_VERSION ||
    proof.scenarioId !== "E2E-RELEASE-SYNC-RECOVERY" ||
    proof.checkpoint !== checkpoint.path || proof.client !== checkpoint.client ||
    proof.observedAt !== options.observedAt ||
    proof.previousCheckpointProofSha256 !== options.previousCheckpointProofSha256 ||
    proof.runManifestSha256 !== options.runManifestSha256 ||
    proof.releaseManifestSha256 !== options.releaseManifestSha256 ||
    proof.launchIdentitySha256 !== options.launchIdentitySha256 ||
    proof.uiStateSha256 !== sha256(options.stateBytes) ||
    proof.screenshotSha256 !== sha256(options.screenshotBytes)
  ) {
    throw new Error(`Malformed or unchained release UI checkpoint: ${checkpoint.path}`);
  }
}

export async function validateReleaseUiCheckpointChain(options: {
  root: string;
  rendererVersion: string;
  runManifestSha256: string;
  releaseManifestSha256: string;
  throughPath?: string;
}): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  let previousProofSha256: string | null = null;
  for (const checkpoint of releaseUiCheckpoints(options.rendererVersion)) {
    const paths = releaseUiCheckpointPaths(options.root, checkpoint.path);
    const [screenshotBytes, stateBytes, proofBytes] = await Promise.all([
      readFile(paths.screenshot),
      readFile(paths.state),
      readFile(paths.proof),
    ]);
    const [screenshotStat, stateStat, proofStat] = await Promise.all([
      stat(paths.screenshot), stat(paths.state), stat(paths.proof),
    ]);
    const state = JSON.parse(stateBytes.toString("utf8")) as Record<string, any>;
    const proof = JSON.parse(proofBytes.toString("utf8")) as Record<string, unknown>;
    const identityBytes = await readFile(String(state.launchIdentityPath ?? ""));
    const identity = await readClientLaunchIdentity(String(state.launchIdentityPath ?? ""));
    assertReleaseUiCheckpointContent(checkpoint, state, identity.startedAt);
    assertReleaseUiCheckpointProof({
      checkpoint,
      proof,
      observedAt: String(state.observedAt),
      previousCheckpointProofSha256: previousProofSha256,
      runManifestSha256: options.runManifestSha256,
      releaseManifestSha256: options.releaseManifestSha256,
      launchIdentitySha256: sha256(identityBytes),
      stateBytes,
      screenshotBytes,
    });
    const observedAt = Date.parse(String(state.observedAt ?? ""));
    if (
      screenshotStat.size < 1024 || !isPng(screenshotBytes) ||
      (screenshotStat.mode & 0o777) !== 0o600 ||
      (stateStat.mode & 0o777) !== 0o600 || (proofStat.mode & 0o777) !== 0o600 ||
      state.schemaVersion !== E2E_UI_EVIDENCE_SCHEMA_VERSION ||
      state.runManifestSha256 !== options.runManifestSha256 ||
      state.releaseManifestSha256 !== options.releaseManifestSha256 ||
      state.launchIdentitySha256 !== sha256(identityBytes) ||
      state.screenshotPath !== paths.screenshot ||
      state.screenshotSha256 !== sha256(screenshotBytes) ||
      identity.profilePath !== resolve(options.root, checkpoint.client, "user-data") ||
      identity.vaultPath !== resolve(options.root, checkpoint.client, "vault") ||
      identity.runManifestSha256 !== options.runManifestSha256 ||
      identity.releaseManifestSha256 !== options.releaseManifestSha256 ||
      state.launchedPid !== identity.pid || state.debugPort !== identity.debugPort ||
      state.debugListenerPid !== identity.debugListenerPid ||
      state.debugTargetId !== identity.debugTargetId ||
      state.profilePath !== identity.profilePath || state.vaultPath !== identity.vaultPath ||
      state.rendererPageCount !== 1 || state.visibleRendererPageCount !== 1 ||
      !isBoundE2EUiSnapshotPage(state, identity.debugTargetUrl) ||
      !Number.isFinite(observedAt) ||
      Math.abs(screenshotStat.mtimeMs - observedAt) > 30_000
    ) {
      throw new Error(`Malformed or unchained release UI checkpoint: ${checkpoint.path}`);
    }
    previousProofSha256 = sha256(proofBytes);
    hashes.set(checkpoint.path, previousProofSha256);
    if (checkpoint.path === options.throughPath) return hashes;
  }
  if (options.throughPath) {
    throw new Error(`Unsupported release UI checkpoint: ${options.throughPath}`);
  }
  return hashes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPng(bytes: Buffer): boolean {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width >= 640 && height >= 400 && width <= 16_384 && height <= 16_384;
}
