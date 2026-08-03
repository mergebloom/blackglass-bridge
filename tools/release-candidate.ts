import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalAdapterOptions, type AdapterOptions } from "../packages/client-adapter/src/patch";
import { loadCompatibilityBaseline } from "./release-compatibility";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";
import { stableJson } from "./stable-json";
import { computeToolingSourceIdentity } from "./tooling-source";

export const RELEASE_CANDIDATE_SCHEMA_VERSION = 1;

export interface ReleaseCandidate {
  schemaVersion: typeof RELEASE_CANDIDATE_SCHEMA_VERSION;
  createdAt: string;
  client: {
    version: string;
    revision: string;
    toolingSourceSha256: string;
  };
  server: {
    version: string;
    revision: string;
    releaseContractSha256: string;
  };
  endpoints: AdapterOptions;
  renderers: Array<{
    version: string;
    baselineSha256: string;
    officialDmgSha256: string;
  }>;
}

interface ServerReleaseContract {
  schemaVersion: 2;
  serverVersion: string;
  database: {
    supportedSourceSchemas: number[];
    destinationSchema: number;
  };
  rollback: {
    previousPublishedTag: string;
    previousPublishedSchema: number;
    directRollbackTag: string | null;
    directRollbackSupported: boolean;
  };
  clientToolingRevision: string;
  qualifiedRenderers: Array<{ version: string; baselineSha256: string }>;
}

export async function inspectReleaseCandidateInputs(input: {
  clientRoot: string;
  serverRoot: string;
  endpoints: AdapterOptions;
}): Promise<Omit<ReleaseCandidate, "createdAt">> {
  const clientRoot = resolve(input.clientRoot);
  const serverRoot = resolve(input.serverRoot);
  const [clientRevision, serverRevision] = await Promise.all([
    cleanGitRevision(clientRoot, "client"),
    cleanGitRevision(serverRoot, "server"),
  ]);
  const [clientPackage, serverPackage, contractBytes, toolingSource] = await Promise.all([
    readJsonFile(resolve(clientRoot, "package.json"), "client package metadata"),
    readJsonFile(resolve(serverRoot, "package.json"), "server package metadata"),
    readRealFile(resolve(serverRoot, "ops/release/release-contract.json"), "server release contract"),
    computeToolingSourceIdentity(clientRoot),
  ]);
  const clientVersion = packageVersion(clientPackage, "client");
  const serverVersion = packageVersion(serverPackage, "server");
  const contractValue = parseJson(contractBytes, "server release contract");
  assertServerReleaseContract(contractValue);
  if (contractValue.serverVersion !== serverVersion) {
    throw new Error("Server release contract version does not match package.json");
  }
  if (contractValue.clientToolingRevision !== clientRevision) {
    throw new Error(
      "Server release contract does not bind the exact clean client tooling revision",
    );
  }
  if (toolingSource.worktreeClean !== true || toolingSource.gitRevision !== clientRevision) {
    throw new Error("Client release-critical tooling identity is not the clean Git revision");
  }

  const renderers = [];
  for (const expected of contractValue.qualifiedRenderers) {
    const baselinePath = resolve(
      clientRoot,
      `compatibility/obsidian-${expected.version}.json`,
    );
    const loaded = await loadCompatibilityBaseline(baselinePath);
    if (
      loaded.baseline.rendererVersion !== expected.version ||
      loaded.sha256 !== expected.baselineSha256
    ) {
      throw new Error(
        `Server release contract baseline does not match client renderer ${expected.version}`,
      );
    }
    renderers.push({
      version: expected.version,
      baselineSha256: loaded.sha256,
      officialDmgSha256: loaded.baseline.officialDmgSha256,
    });
  }

  return {
    schemaVersion: RELEASE_CANDIDATE_SCHEMA_VERSION,
    client: {
      version: clientVersion,
      revision: clientRevision,
      toolingSourceSha256: sha256(Buffer.from(stableJson(toolingSource))),
    },
    server: {
      version: serverVersion,
      revision: serverRevision,
      releaseContractSha256: sha256(contractBytes),
    },
    endpoints: canonicalAdapterOptions(input.endpoints),
    renderers,
  };
}

export async function assertReleaseCandidateMatchesCheckouts(input: {
  candidate: ReleaseCandidate;
  clientRoot: string;
  serverRoot: string;
}): Promise<void> {
  const current = await inspectReleaseCandidateInputs({
    clientRoot: input.clientRoot,
    serverRoot: input.serverRoot,
    endpoints: input.candidate.endpoints,
  });
  const expected = { ...input.candidate };
  delete (expected as Partial<ReleaseCandidate>).createdAt;
  if (stableJson(current) !== stableJson(expected)) {
    throw new Error("Release candidate no longer matches the exact clean checkouts");
  }
}

export function parseReleaseCandidate(bytes: Uint8Array): ReleaseCandidate {
  const value = parseJson(bytes, "release candidate");
  assertReleaseCandidate(value);
  return value;
}

export function assertReleaseCandidate(value: unknown): asserts value is ReleaseCandidate {
  if (!isRecord(value) || value.schemaVersion !== RELEASE_CANDIDATE_SCHEMA_VERSION) {
    throw new Error("Unsupported release candidate schema");
  }
  if (
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isRecord(value.client) ||
    !isSupportedSemver(value.client.version) ||
    !isRevision(value.client.revision) ||
    !isSha256(value.client.toolingSourceSha256) ||
    !isRecord(value.server) ||
    !isSupportedSemver(value.server.version) ||
    !isRevision(value.server.revision) ||
    !isSha256(value.server.releaseContractSha256) ||
    !Array.isArray(value.renderers) ||
    value.renderers.length === 0 ||
    !isRecord(value.endpoints)
  ) {
    throw new Error("Release candidate is malformed");
  }
  const endpoints = canonicalAdapterOptions({
    controlOrigin: String(value.endpoints.controlOrigin ?? ""),
    dataHost: String(value.endpoints.dataHost ?? ""),
  });
  if (stableJson(endpoints) !== stableJson(value.endpoints)) {
    throw new Error("Release candidate endpoints are not canonical");
  }
  const versions = new Set<string>();
  for (const renderer of value.renderers) {
    if (
      !isRecord(renderer) ||
      !isSupportedStableSemver(renderer.version) ||
      !isSha256(renderer.baselineSha256) ||
      !isSha256(renderer.officialDmgSha256) ||
      versions.has(renderer.version)
    ) {
      throw new Error("Release candidate renderer set is malformed");
    }
    versions.add(renderer.version);
  }
}

export function releaseCandidateSha256(candidate: ReleaseCandidate): string {
  return sha256(Buffer.from(stableJson(candidate)));
}

async function cleanGitRevision(root: string, label: string): Promise<string> {
  const revisionResult = Bun.spawnSync(
    ["git", "-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (revisionResult.exitCode !== 0) {
    throw new Error(`Unable to resolve ${label} Git revision`);
  }
  const revision = revisionResult.stdout.toString("utf8").trim();
  if (!isRevision(revision)) throw new Error(`${label} Git revision is malformed`);
  const status = Bun.spawnSync(
    ["git", "-C", root, "status", "--porcelain", "--untracked-files=all"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (status.exitCode !== 0 || status.stdout.length !== 0) {
    throw new Error(`${label} checkout must be clean before freezing a release candidate`);
  }
  return revision;
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  return parseJson(await readRealFile(path, label), label);
}

async function readRealFile(path: string, label: string): Promise<Buffer> {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`${label} must be a real file`);
  return readFile(path);
}

function packageVersion(value: unknown, label: string): string {
  if (!isRecord(value) || !isSupportedSemver(value.version)) {
    throw new Error(`${label} package metadata has an invalid version`);
  }
  return value.version;
}

export function assertServerReleaseContract(value: unknown): asserts value is ServerReleaseContract {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    !isSupportedSemver(value.serverVersion) ||
    !isRecord(value.database) ||
    !Array.isArray(value.database.supportedSourceSchemas) ||
    value.database.supportedSourceSchemas.length === 0 ||
    !isPositiveInteger(value.database.destinationSchema) ||
    !isRecord(value.rollback) ||
    !isReleaseTag(value.rollback.previousPublishedTag) ||
    !isPositiveInteger(value.rollback.previousPublishedSchema) ||
    !(
      value.rollback.directRollbackTag === null ||
      isReleaseTag(value.rollback.directRollbackTag)
    ) ||
    typeof value.rollback.directRollbackSupported !== "boolean" ||
    !isRevision(value.clientToolingRevision) ||
    !Array.isArray(value.qualifiedRenderers) ||
    value.qualifiedRenderers.length === 0
  ) {
    throw new Error("Server release contract is malformed");
  }
  const schemas = new Set<number>();
  for (const schema of value.database.supportedSourceSchemas) {
    if (
      !isPositiveInteger(schema) ||
      schema >= value.database.destinationSchema ||
      schemas.has(schema)
    ) {
      throw new Error("Server release contract database migration set is malformed");
    }
    schemas.add(schema);
  }
  if (
    !schemas.has(value.rollback.previousPublishedSchema) ||
    value.rollback.directRollbackSupported !==
      (value.rollback.directRollbackTag !== null)
  ) {
    throw new Error("Server release contract rollback policy is malformed");
  }
  const seen = new Set<string>();
  for (const renderer of value.qualifiedRenderers) {
    if (
      !isRecord(renderer) ||
      !isSupportedStableSemver(renderer.version) ||
      !isSha256(renderer.baselineSha256) ||
      seen.has(renderer.version)
    ) {
      throw new Error("Server release contract renderer set is malformed");
    }
    seen.add(renderer.version);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isReleaseTag(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("v") && isSupportedSemver(value.slice(1));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
