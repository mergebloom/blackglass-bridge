import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalAdapterOptions,
  type AdapterOptions,
} from "../packages/client-adapter/src/patch";
import {
  assertNoSymlinkSegments,
  assertPathWithin,
  canonicalExistingPath,
} from "./path-safety";
import { stableJson } from "./stable-json";

export const E2E_NETWORK_SCHEMA_VERSION = 1;

export interface E2ENetworkPlan {
  schemaVersion: typeof E2E_NETWORK_SCHEMA_VERSION;
  control: {
    publicOrigin: string;
    hostname: string;
    authority: string;
    upstreamHost: "127.0.0.1";
    upstreamPort: 3000;
  };
  data: {
    publicHost: string;
    hostname: string;
    authority: string;
    upstreamHost: "127.0.0.1";
    upstreamPort: 3003;
  };
  tlsProxy: {
    listenHost: "127.0.0.1";
    listenPort: 8443;
    chromiumHostResolverRules: string;
  };
}

export interface PreparedE2ERunManifest {
  schemaVersion: 2;
  endpoints: AdapterOptions;
  network: E2ENetworkPlan;
  compatibilityAsarSha256: string;
  releaseManifestSha256: string;
  adapterFileName: string;
  releaseManifestFileName: string;
  [key: string]: unknown;
}

export function deriveE2ENetworkPlan(endpointsValue: AdapterOptions): E2ENetworkPlan {
  const endpoints = canonicalAdapterOptions(endpointsValue);
  const control = new URL(endpoints.controlOrigin);
  if (control.protocol !== "https:") {
    throw new Error("Prepared TLS E2E runs require an HTTPS control origin");
  }
  const data = new URL(`wss://${endpoints.dataHost}`);
  const hosts = [...new Set([control.hostname, data.hostname])].sort();
  for (const host of hosts) {
    if (!isSafeResolverHostname(host)) {
      throw new Error(`E2E host is unsafe for Chromium resolver rules: ${host}`);
    }
  }
  const listenPort = 8443;
  return {
    schemaVersion: E2E_NETWORK_SCHEMA_VERSION,
    control: {
      publicOrigin: endpoints.controlOrigin,
      hostname: control.hostname,
      authority: control.host,
      upstreamHost: "127.0.0.1",
      upstreamPort: 3000,
    },
    data: {
      publicHost: endpoints.dataHost,
      hostname: data.hostname,
      authority: data.host,
      upstreamHost: "127.0.0.1",
      upstreamPort: 3003,
    },
    tlsProxy: {
      listenHost: "127.0.0.1",
      listenPort,
      chromiumHostResolverRules: hosts
        .map((host) => `MAP ${host} 127.0.0.1:${listenPort}`)
        .join(","),
    },
  };
}

export function assertE2ENetworkPlan(
  value: unknown,
  endpoints: AdapterOptions,
): asserts value is E2ENetworkPlan {
  const expected = deriveE2ENetworkPlan(endpoints);
  if (stableJson(value) !== stableJson(expected)) {
    throw new Error("Prepared E2E network plan is not derived from the release endpoints");
  }
}

export async function readPreparedE2ERun(
  rootArgument: string,
): Promise<{
  root: string;
  manifestPath: string;
  manifestBytes: Buffer;
  manifestSha256: string;
  manifest: PreparedE2ERunManifest;
}> {
  const allowedRoot = await canonicalExistingPath(
    resolve(import.meta.dir, "../.data/e2e"),
    "E2E data root",
    "directory",
  );
  const root = await canonicalExistingPath(rootArgument, "E2E run", "directory");
  assertPathWithin(root, allowedRoot, "E2E run");
  await assertNoSymlinkSegments(allowedRoot, root, "E2E run");
  const manifestPath = await canonicalExistingPath(
    resolve(root, "run-manifest.json"),
    "E2E run manifest",
    "file",
  );
  await assertNoSymlinkSegments(root, manifestPath, "E2E run manifest");
  const manifestBytes = await readFile(manifestPath);
  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid E2E run manifest JSON: ${String(error)}`);
  }
  assertPreparedE2ERunManifest(value);
  return {
    root,
    manifestPath,
    manifestBytes,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    manifest: value,
  };
}

export function assertPreparedE2ERunManifest(
  value: unknown,
): asserts value is PreparedE2ERunManifest {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.endpoints)) {
    throw new Error("Unsupported prepared E2E run manifest schema");
  }
  const endpoints = canonicalAdapterOptions({
    controlOrigin: String(value.endpoints.controlOrigin ?? ""),
    dataHost: String(value.endpoints.dataHost ?? ""),
  });
  if (
    endpoints.controlOrigin !== value.endpoints.controlOrigin ||
    endpoints.dataHost !== value.endpoints.dataHost
  ) {
    throw new Error("Prepared E2E endpoints are not canonical");
  }
  assertE2ENetworkPlan(value.network, endpoints);
  for (const field of ["compatibilityAsarSha256", "releaseManifestSha256"] as const) {
    if (!isSha256(value[field])) throw new Error(`Prepared E2E ${field} is invalid`);
  }
  for (const field of ["adapterFileName", "releaseManifestFileName"] as const) {
    if (
      typeof value[field] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value[field] as string)
    ) {
      throw new Error(`Prepared E2E ${field} is invalid`);
    }
  }
}

function isSafeResolverHostname(host: string): boolean {
  return (
    host.length <= 253 &&
    (host === "localhost" ||
      /^\[[0-9a-f:]+\]$/iu.test(host) ||
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(host))
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
