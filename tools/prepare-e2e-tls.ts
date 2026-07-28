import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readPreparedE2ERun } from "./e2e-network";
import {
  buildE2ETlsMetadata,
  certificateSubjectAltName,
  e2eTlsHosts,
} from "./e2e-tls";
import { canonicalOutputPath } from "./path-safety";

const [rootArgument, ...extraArguments] = Bun.argv.slice(2);
if (!rootArgument || extraArguments.length !== 0) usage();

const run = await readPreparedE2ERun(rootArgument);
const certificatePath = await canonicalOutputPath(
  join(run.root, "tls-certificate.pem"),
  "E2E TLS certificate",
);
const keyPath = await canonicalOutputPath(
  join(run.root, "tls-private-key.pem"),
  "E2E TLS private key",
);
const metadataPath = await canonicalOutputPath(
  join(run.root, "tls-metadata.json"),
  "E2E TLS metadata",
);
const hosts = e2eTlsHosts(run.manifest.network);
const openssl = Bun.spawnSync([
  "/usr/bin/openssl",
  "req",
  "-x509",
  "-newkey",
  "rsa:3072",
  "-sha256",
  "-nodes",
  "-days",
  "2",
  "-subj",
  `/CN=${hosts[0]}`,
  "-addext",
  `subjectAltName=${certificateSubjectAltName(hosts)}`,
  "-keyout",
  keyPath,
  "-out",
  certificatePath,
]);
if (openssl.exitCode !== 0) {
  throw new Error(Buffer.from(openssl.stderr).toString("utf8").trim());
}
await chmod(keyPath, 0o600);
await chmod(certificatePath, 0o600);
const [certificateBytes, privateKeyBytes] = await Promise.all([
  readFile(certificatePath),
  readFile(keyPath),
]);
const metadata = buildE2ETlsMetadata({
  runManifestSha256: run.manifestSha256,
  network: run.manifest.network,
  certificateBytes,
  privateKeyBytes,
});
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify({ root: run.root, metadataPath, metadata }, null, 2));

function usage(): never {
  console.error("Usage: bun run tools/prepare-e2e-tls.ts <prepared-E2E-run-directory>");
  process.exit(2);
}
