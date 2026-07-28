import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readClientLaunchIdentity } from "./e2e-client";
import { readPreparedE2ERun } from "./e2e-network";
import { canonicalExistingPath, canonicalOutputPath } from "./path-safety";
import { computeTreeIdentity } from "./tree-identity";

const [rootArgument, ...flags] = Bun.argv.slice(2);
if (!rootArgument || flags.length !== 0) {
  console.error("Usage: bun run tools/reset-e2e-for-recovery.ts <run-directory>");
  process.exit(2);
}

const run = await readPreparedE2ERun(rootArgument);
const root = run.root;
const reportPath = await canonicalExistingPath(join(root, "report.json"), "Sync report", "file");
const recoveryManifestPath = await canonicalExistingPath(
  join(root, "recovery-manifest.json"),
  "Recovery manifest",
  "file",
);
const reportSha256 = await fileSha256(reportPath);
const resetOutput = await canonicalOutputPath(
  join(root, "source-loss-reset.json"),
  "Source-loss reset record",
);
const recoveryManifest = JSON.parse(await readFile(recoveryManifestPath, "utf8")) as {
  schemaVersion?: unknown;
  syncReportSha256?: unknown;
};
if (
  recoveryManifest.schemaVersion !== 2 ||
  recoveryManifest.syncReportSha256 !== reportSha256
) {
  throw new Error("Recovery capture is not bound to the completed Sync report");
}

const clientArtifactPath = await canonicalExistingPath(
  join(root, "client-artifact.json"),
  "Client artifact identity",
  "file",
);
const clientArtifact = JSON.parse(await readFile(clientArtifactPath, "utf8")) as {
  appPath?: unknown;
  embeddedAsarSha256?: unknown;
};
if (
  typeof clientArtifact.appPath !== "string" ||
  typeof clientArtifact.embeddedAsarSha256 !== "string"
) {
  throw new Error("Malformed client artifact identity");
}
const embeddedAsar = await canonicalExistingPath(
  join(clientArtifact.appPath, "Contents/Resources/obsidian.asar"),
  "Packaged embedded renderer",
  "file",
);
const adapterBytes = await readFile(embeddedAsar);
if (
  sha256(adapterBytes) !== clientArtifact.embeddedAsarSha256 ||
  sha256(adapterBytes) !== run.manifest.compatibilityAsarSha256
) {
  throw new Error("Packaged renderer no longer matches the prepared recovery run");
}

const clients = ["client-a", "client-b"] as const;
const launchIdentities = await Promise.all(
  clients.map((client) => readClientLaunchIdentity(join(root, `${client}-launch.json`))),
);
for (const [index, identity] of launchIdentities.entries()) {
  const client = clients[index]!;
  if (processExists(identity.pid) || await devtoolsResponds(identity.debugPort)) {
    throw new Error(`Stop ${client} before beginning source-loss recovery`);
  }
}

const clientRoots = await Promise.all(
  clients.map((client) =>
    canonicalExistingPath(join(root, client), `${client} disposable directory`, "directory"),
  ),
);
const [clientATree, clientBTree] = await Promise.all(
  clientRoots.map((clientRoot) => computeTreeIdentity(clientRoot)),
);

const freshClient = await canonicalOutputPath(
  join(root, "client-b.next"),
  "Fresh recovery client staging directory",
);
const freshProfile = join(freshClient, "user-data");
const freshHome = join(freshClient, "home");
const freshVault = join(freshClient, "vault");
await mkdir(freshProfile, { recursive: true, mode: 0o700 });
await mkdir(freshHome, { recursive: true, mode: 0o700 });
await mkdir(freshVault, { recursive: true, mode: 0o700 });
await writeFile(join(freshProfile, run.manifest.adapterFileName), adapterBytes, {
  flag: "wx",
  mode: 0o600,
});
const vaultId = createHash("sha256").update(join(root, "client-b", "vault")).digest("hex").slice(0, 16);
await writeFile(join(freshProfile, `${vaultId}.json`), "{}", {
  flag: "wx",
  mode: 0o600,
});
await writeFile(
  join(freshProfile, "obsidian.json"),
  `${JSON.stringify({
    updateDisabled: true,
    vaults: {
      [vaultId]: {
        path: join(root, "client-b", "vault"),
        ts: Date.now(),
        open: true,
      },
    },
  }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);

const resetRecord = {
  schemaVersion: 1,
  resetAt: new Date().toISOString(),
  runManifestSha256: run.manifestSha256,
  syncReportSha256: reportSha256,
  recoveryManifestSha256: await fileSha256(recoveryManifestPath),
  removed: {
    clientA: clientATree,
    clientB: clientBTree,
  },
  freshClient: {
    name: "client-b",
    profilePath: join(root, "client-b", "user-data"),
    homePath: join(root, "client-b", "home"),
    vaultPath: join(root, "client-b", "vault"),
    adapterSha256: sha256(adapterBytes),
    initialVaultFiles: 0,
  },
};
const resetTemporary = `${resetOutput}.next`;
await writeFile(resetTemporary, `${JSON.stringify(resetRecord, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});

// These targets were resolved from one validated prepared run, both clients are
// stopped, and all source evidence was captured above. No user-selected path or
// installed application is removed here.
await rm(clientRoots[0]!, { recursive: true, force: false });
await rm(clientRoots[1]!, { recursive: true, force: false });
await rename(freshClient, join(root, "client-b"));
await rename(resetTemporary, resetOutput);

console.log(JSON.stringify(resetRecord, null, 2));

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function devtoolsResponds(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
