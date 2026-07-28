import {
  createHash,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  readPreparedE2ERun,
  type E2ENetworkPlan,
} from "./e2e-network";
import {
  assertNoSymlinkSegments,
  canonicalExistingPath,
  pathsEqual,
} from "./path-safety";
import { stableJson } from "./stable-json";

export const E2E_TLS_METADATA_SCHEMA_VERSION = 2;

export interface E2ETlsMetadata {
  schemaVersion: typeof E2E_TLS_METADATA_SCHEMA_VERSION;
  runManifestSha256: string;
  hosts: string[];
  certificateFileName: "tls-certificate.pem";
  keyFileName: "tls-private-key.pem";
  certificateSha256: string;
  certificatePemSha256: string;
  privateKeySha256: string;
  spkiSha256Base64: string;
  validFrom: string;
  validTo: string;
  chromiumHostResolverRules: string;
  network: E2ENetworkPlan;
}

export function e2eTlsHosts(network: E2ENetworkPlan): string[] {
  return [...new Set([network.control.hostname, network.data.hostname])].sort();
}

export function certificateSubjectAltName(hosts: string[]): string {
  return hosts
    .map((host) => {
      const address = stripIpv6Brackets(host);
      return isIP(address) ? `IP:${address}` : `DNS:${host}`;
    })
    .join(",");
}

export function buildE2ETlsMetadata(options: {
  runManifestSha256: string;
  network: E2ENetworkPlan;
  certificateBytes: Buffer;
  privateKeyBytes: Buffer;
}): E2ETlsMetadata {
  const certificate = new X509Certificate(options.certificateBytes);
  const certificateSpki = Buffer.from(
    certificate.publicKey.export({ type: "spki", format: "der" }),
  );
  const privateKeySpki = Buffer.from(
    createPublicKey(options.privateKeyBytes).export({ type: "spki", format: "der" }),
  );
  if (!certificateSpki.equals(privateKeySpki)) {
    throw new Error("Generated E2E certificate and private key do not match");
  }
  const hosts = e2eTlsHosts(options.network);
  for (const host of hosts) assertCertificateHost(certificate, host);
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error("Generated E2E certificate is not currently valid");
  }
  return {
    schemaVersion: E2E_TLS_METADATA_SCHEMA_VERSION,
    runManifestSha256: options.runManifestSha256,
    hosts,
    certificateFileName: "tls-certificate.pem",
    keyFileName: "tls-private-key.pem",
    certificateSha256: sha256(certificate.raw),
    certificatePemSha256: sha256(options.certificateBytes),
    privateKeySha256: sha256(options.privateKeyBytes),
    spkiSha256Base64: createHash("sha256").update(certificateSpki).digest("base64"),
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    chromiumHostResolverRules: options.network.tlsProxy.chromiumHostResolverRules,
    network: options.network,
  };
}

export async function readVerifiedE2ETls(
  runRootArgument: string,
  metadataArgument?: string,
): Promise<{
  run: Awaited<ReturnType<typeof readPreparedE2ERun>>;
  metadataPath: string;
  metadataBytes: Buffer;
  metadataSha256: string;
  metadata: E2ETlsMetadata;
  certificatePath: string;
  certificateBytes: Buffer;
  keyPath: string;
  privateKeyBytes: Buffer;
}> {
  const run = await readPreparedE2ERun(runRootArgument);
  const expectedMetadataPath = join(run.root, "tls-metadata.json");
  const metadataPath = await canonicalExistingPath(
    metadataArgument ?? expectedMetadataPath,
    "E2E TLS metadata",
    "file",
  );
  if (!pathsEqual(metadataPath, expectedMetadataPath)) {
    throw new Error("E2E TLS metadata must belong to the selected prepared run");
  }
  await assertNoSymlinkSegments(run.root, metadataPath, "E2E TLS metadata");
  const metadataBytes = await readFile(metadataPath);
  let value: unknown;
  try {
    value = JSON.parse(metadataBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid E2E TLS metadata JSON: ${String(error)}`);
  }
  assertE2ETlsMetadata(value);
  if (
    value.runManifestSha256 !== run.manifestSha256 ||
    stableJson(value.network) !== stableJson(run.manifest.network) ||
    value.chromiumHostResolverRules !==
      run.manifest.network.tlsProxy.chromiumHostResolverRules ||
    stableJson(value.hosts) !== stableJson(e2eTlsHosts(run.manifest.network))
  ) {
    throw new Error("E2E TLS metadata is not bound to the selected prepared run");
  }
  const certificatePath = await canonicalExistingPath(
    join(run.root, value.certificateFileName),
    "E2E TLS certificate",
    "file",
  );
  const keyPath = await canonicalExistingPath(
    join(run.root, value.keyFileName),
    "E2E TLS private key",
    "file",
  );
  await assertNoSymlinkSegments(run.root, certificatePath, "E2E TLS certificate");
  await assertNoSymlinkSegments(run.root, keyPath, "E2E TLS private key");
  if (((await lstat(keyPath)).mode & 0o077) !== 0) {
    throw new Error("E2E TLS private key permissions are not owner-only");
  }
  const [certificateBytes, privateKeyBytes] = await Promise.all([
    readFile(certificatePath),
    readFile(keyPath),
  ]);
  const reproduced = buildE2ETlsMetadata({
    runManifestSha256: run.manifestSha256,
    network: run.manifest.network,
    certificateBytes,
    privateKeyBytes,
  });
  if (stableJson(reproduced) !== stableJson(value)) {
    throw new Error("E2E TLS files do not match their bound metadata");
  }
  return {
    run,
    metadataPath,
    metadataBytes,
    metadataSha256: sha256(metadataBytes),
    metadata: value,
    certificatePath,
    certificateBytes,
    keyPath,
    privateKeyBytes,
  };
}

export function assertE2ETlsMetadata(value: unknown): asserts value is E2ETlsMetadata {
  if (
    !isRecord(value) ||
    value.schemaVersion !== E2E_TLS_METADATA_SCHEMA_VERSION ||
    value.certificateFileName !== "tls-certificate.pem" ||
    value.keyFileName !== "tls-private-key.pem" ||
    !isSha256(value.runManifestSha256) ||
    !isSha256(value.certificateSha256) ||
    !isSha256(value.certificatePemSha256) ||
    !isSha256(value.privateKeySha256) ||
    typeof value.spkiSha256Base64 !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(value.spkiSha256Base64) ||
    typeof value.validFrom !== "string" ||
    typeof value.validTo !== "string" ||
    typeof value.chromiumHostResolverRules !== "string" ||
    !Array.isArray(value.hosts) ||
    value.hosts.some((host) => typeof host !== "string") ||
    !isRecord(value.network)
  ) {
    throw new Error("Malformed E2E TLS metadata");
  }
}

function assertCertificateHost(certificate: X509Certificate, host: string): void {
  const address = stripIpv6Brackets(host);
  const matched = isIP(address)
    ? certificate.checkIP(address)
    : certificate.checkHost(host);
  if (!matched) throw new Error(`E2E certificate does not cover ${host}`);
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
