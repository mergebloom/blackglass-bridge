import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  inspectServerArtifact,
  publicServerArtifact,
  type ServerArtifact,
} from "./server-artifact";
import {
  inspectMacOSArtifact,
  publicMacOSArtifact,
  type MacOSArtifact,
} from "./macos-artifact";

const rootArgument = Bun.argv[2];
if (!rootArgument) {
  console.error("Usage: bun run tools/verify-e2e.ts <run-directory>");
  process.exit(2);
}

const root = resolve(rootArgument);
const projectDataRoot = resolve(import.meta.dir, "../.data/e2e");
if (!root.startsWith(`${projectDataRoot}/`)) {
  throw new Error(`E2E directory must be inside ${projectDataRoot}`);
}
const runManifest = JSON.parse(
  await readFile(resolve(root, "run-manifest.json"), "utf8"),
) as {
  schemaVersion: number;
  rendererVersion: string;
  adapterFileName: string;
  compatibilityAsarSha256: string;
};
if (runManifest.schemaVersion !== 1 || !/^obsidian-\d+\.\d+\.\d+\.asar$/.test(runManifest.adapterFileName)) {
  throw new Error("Unsupported or malformed E2E run manifest");
}
const recordedServer = JSON.parse(
  await readFile(resolve(root, "server-artifact.json"), "utf8"),
) as ServerArtifact;
const recordedClient = JSON.parse(
  await readFile(resolve(root, "client-artifact.json"), "utf8"),
) as MacOSArtifact;
const currentServer = await inspectServerArtifact(recordedServer.binaryPath);
if (
  JSON.stringify(publicServerArtifact(currentServer)) !==
  JSON.stringify(publicServerArtifact(recordedServer))
) {
  throw new Error("The server binary changed after this E2E run started");
}
const currentClient = await inspectMacOSArtifact(recordedClient.appPath);
if (
  JSON.stringify(publicMacOSArtifact(currentClient)) !==
  JSON.stringify(publicMacOSArtifact(recordedClient))
) {
  throw new Error("The packaged macOS app changed after this E2E run was prepared");
}

const proofPairs = [
  {
    direction: "client-a-to-client-b",
    source: resolve(root, "client-a/vault/E2E Sync Proof.md"),
    destination: resolve(root, "client-b/vault/E2E Sync Proof.md"),
  },
  {
    direction: "client-b-to-client-a",
    source: resolve(root, "client-b/vault/Reverse Sync Proof.md"),
    destination: resolve(root, "client-a/vault/Reverse Sync Proof.md"),
  },
] as const;

const proofs = [];
for (const pair of proofPairs) {
  const source = Buffer.from(await Bun.file(pair.source).arrayBuffer());
  const destination = Buffer.from(await Bun.file(pair.destination).arrayBuffer());
  const sourceSha256 = sha256(source);
  const destinationSha256 = sha256(destination);
  if (!source.equals(destination)) {
    throw new Error(`${pair.direction} did not converge byte-for-byte`);
  }
  proofs.push({
    direction: pair.direction,
    bytes: source.byteLength,
    sourceSha256,
    destinationSha256,
    identical: true,
  });
}

const clientAsars = [
  resolve(root, "client-a/user-data", runManifest.adapterFileName),
  resolve(root, "client-b/user-data", runManifest.adapterFileName),
];
const clientAsarHashes = await Promise.all(
  clientAsars.map(async (path) => sha256(Buffer.from(await Bun.file(path).arrayBuffer()))),
);
if (new Set(clientAsarHashes).size !== 1) {
  throw new Error("Clients did not run the same compatibility ASAR");
}
if (clientAsarHashes[0] !== runManifest.compatibilityAsarSha256) {
  throw new Error("Client compatibility ASAR does not match the prepared run manifest");
}

const databasePath = resolve(root, "server.sqlite");
const database = new Database(databasePath, { readonly: true });
const hasExternalContent = Boolean(
  database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='revision_content'").get(),
);
const vault = database
  .query<{ id: string; name: string; size: number; version: number }, []>(
    "SELECT id, name, size, version FROM vaults LIMIT 1",
  )
  .get();
const revisionSummary = database
  .query<{ revisions: number; maxUid: number; encryptedBytes: number }, []>(
    `SELECT COUNT(*) AS revisions,
            COALESCE(MAX(uid), 0) AS maxUid,
            COALESCE(SUM(LENGTH(${hasExternalContent ? "COALESCE(rc.content, r.content)" : "r.content"})), 0) AS encryptedBytes
       FROM revisions r
       ${hasExternalContent ? "LEFT JOIN revision_content rc ON rc.uid = r.uid" : ""}`,
  )
  .get();
const ciphertextRows = database
  .query<{ content: Uint8Array }, []>(
    hasExternalContent
      ? "SELECT COALESCE(rc.content, r.content) AS content FROM revisions r LEFT JOIN revision_content rc ON rc.uid = r.uid WHERE COALESCE(rc.content, r.content) IS NOT NULL"
      : "SELECT content FROM revisions WHERE content IS NOT NULL",
  )
  .all();
database.close();
if (!vault || !revisionSummary || revisionSummary.revisions === 0) {
  throw new Error("Server database has no synchronized vault revisions");
}
if (vault.version !== revisionSummary.maxUid) {
  throw new Error("Vault version is not the latest committed revision UID");
}
for (const pair of proofPairs) {
  const plaintext = Buffer.from(await Bun.file(pair.source).arrayBuffer());
  if (ciphertextRows.some((row) => Buffer.from(row.content).includes(plaintext))) {
    throw new Error("Server payload unexpectedly contains a proof note in plaintext");
  }
}

const screenshotPaths = [
  resolve(root, "client-a/settings.png"),
  resolve(root, "client-a/created.png"),
  resolve(root, "client-a/unlocked.png"),
  resolve(root, "client-b/vault-chooser.png"),
  resolve(root, "client-b/converged.png"),
  resolve(root, "client-b/deleted-files.png"),
];
for (const screenshot of screenshotPaths) {
  if ((await stat(screenshot)).size < 1024) {
    throw new Error(`Missing or implausibly small screenshot: ${screenshot}`);
  }
  const signature = Buffer.from(await readFile(screenshot)).subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`UX evidence is not a PNG screenshot: ${screenshot}`);
  }
}
const databaseMode = (await stat(databasePath)).mode & 0o777;
const stagingMode = (await stat(resolve(root, "uploads"))).mode & 0o777;
if (process.platform !== "win32" && (databaseMode !== 0o600 || stagingMode !== 0o700)) {
  throw new Error(
    `Unsafe E2E state permissions: database=${databaseMode.toString(8)}, staging=${stagingMode.toString(8)}`,
  );
}

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  passed: true,
  referenceClient: {
    version: runManifest.rendererVersion,
    platform: "macOS Apple Silicon",
    compatibilityAsarSha256: clientAsarHashes[0],
    isolatedClients: 2,
    app: publicMacOSArtifact(recordedClient),
  },
  proofs,
  server: {
    implementation: hasExternalContent ? "rust" : "bun-oracle",
    artifact: publicServerArtifact(recordedServer),
    vaultName: vault.name,
    revisions: revisionSummary.revisions,
    version: vault.version,
    encryptedBytes: revisionSummary.encryptedBytes,
    exactProofPlaintextFound: false,
    databaseMode: databaseMode.toString(8).padStart(4, "0"),
    stagingMode: stagingMode.toString(8).padStart(4, "0"),
  },
  uxEvidence: screenshotPaths.map((path) => path.slice(root.length + 1)),
};
await writeFile(resolve(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(JSON.stringify(report, null, 2));

function sha256(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
