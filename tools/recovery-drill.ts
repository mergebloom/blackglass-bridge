import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  type LiveClientLaunchBinding,
  verifyLiveClientLaunchBinding,
} from "./e2e-client";
import { readPreparedE2ERun } from "./e2e-network";
import { E2E_UI_EVIDENCE_SCHEMA_VERSION } from "./e2e-ui-evidence";
import { pathExists } from "./path-safety";
import {
  assertCanonicalRecoveryCorpusIdentity,
  assertCanonicalRecoveryCorpusManifest,
  canonicalRecoveryCorpusFiles,
  canonicalRecoveryCorpusIdentity,
  compareCodePointStrings,
  type RecoveryCorpusFileEntry,
  type RecoveryCorpusIdentity,
} from "./recovery-corpus";
import { assertSourceLossResetRecord } from "./source-loss-reset";

const [action, firstArgument, secondArgument] = Bun.argv.slice(2);
const e2eRoot = resolve(import.meta.dir, "../.data/e2e");

if (action === "create") {
  if (!firstArgument) usage();
  const vault = e2ePath(firstArgument, "fixture vault");
  await assertNoSymlinkSegments(vault);
  const files = canonicalRecoveryCorpusFiles();
  for (const [path, contents] of files) {
    const target = join(vault, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ action, vault, files: [...files.keys()] }, null, 2));
} else if (action === "capture") {
  if (!firstArgument || !secondArgument) usage();
  const runRoot = (await readPreparedE2ERun(firstArgument)).root;
  const vault = e2ePath(secondArgument, "source vault");
  await assertNoSymlinkSegments(vault);
  assertExpectedVault(runRoot, vault, "client-a");
  const manifest = await buildManifest(vault);
  if (manifest.length === 0) throw new Error("Recovery source vault is empty");
  assertCanonicalRecoveryCorpusManifest(manifest);
  const corpus = canonicalRecoveryCorpusIdentity();
  const runManifestSha256 = await fileSha256(join(runRoot, "run-manifest.json"));
  const serverArtifactSha256 = await fileSha256(join(runRoot, "server-artifact.json"));
  const syncReportSha256 = await fileSha256(join(runRoot, "report.json"));
  const database = databaseSnapshot(join(runRoot, "server.sqlite"));
  if (database.revisions === 0 || database.vaults.length !== 1) {
    throw new Error("Recovery capture requires one synchronized non-empty remote vault");
  }
  const output = join(runRoot, "recovery-manifest.json");
  await writeJson(
    output,
    {
      schemaVersion: 3,
      capturedAt: new Date().toISOString(),
      sourceVault: "client-a/vault",
      runManifestSha256,
      serverArtifactSha256,
      syncReportSha256,
      database,
      corpus,
      files: manifest,
    },
    true,
  );
  console.log(JSON.stringify({ action, output, count: manifest.length }, null, 2));
} else if (action === "verify") {
  if (!firstArgument || !secondArgument) usage();
  const preparedRun = await readPreparedE2ERun(firstArgument);
  const runRoot = preparedRun.root;
  const restoredVault = e2ePath(secondArgument, "restored vault");
  await assertNoSymlinkSegments(restoredVault);
  assertExpectedVault(runRoot, restoredVault, "client-b");
  const manifest = JSON.parse(
    await readFile(join(runRoot, "recovery-manifest.json"), "utf8"),
  ) as RecoveryManifest;
  if (
    manifest.schemaVersion !== 3 ||
    manifest.sourceVault !== "client-a/vault" ||
    !isSha256(manifest.runManifestSha256) ||
    !isSha256(manifest.serverArtifactSha256) ||
    !isSha256(manifest.syncReportSha256) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error("Malformed or unsupported recovery manifest");
  }
  assertRecoveryManifestEntries(manifest.files);
  assertCanonicalRecoveryCorpusIdentity(manifest.corpus);
  assertCanonicalRecoveryCorpusManifest(manifest.files);
  if (
    (await fileSha256(join(runRoot, "run-manifest.json"))) !==
      manifest.runManifestSha256 ||
    (await fileSha256(join(runRoot, "server-artifact.json"))) !==
      manifest.serverArtifactSha256 ||
    (await fileSha256(join(runRoot, "report.json"))) !==
      manifest.syncReportSha256
  ) {
    throw new Error("Recovery run identity changed after source capture");
  }
  const recoveryManifestSha256 = await fileSha256(
    join(runRoot, "recovery-manifest.json"),
  );
  const sourceLossResetBytes = await readFile(
    join(runRoot, "source-loss-reset.json"),
  );
  const sourceLossResetSha256 = createHash("sha256")
    .update(sourceLossResetBytes)
    .digest("hex");
  const reset = JSON.parse(sourceLossResetBytes.toString("utf8")) as unknown;
  assertSourceLossResetRecord(reset, {
    runManifestSha256: preparedRun.manifestSha256,
    syncReportSha256: manifest.syncReportSha256,
    recoveryManifestSha256,
    compatibilityAsarSha256: preparedRun.manifest.compatibilityAsarSha256,
    profilePath: join(runRoot, "client-b", "user-data"),
    vaultPath: join(runRoot, "client-b", "vault"),
  });
  for (const client of ["client-a", "client-b"] as const) {
    const retired = reset.retiredRuntimeHomes?.[client];
    const identityPath = join(runRoot, `${client}-launch.json`);
    if (
      typeof retired?.identitySha256 !== "string" ||
      retired.identitySha256 !== await fileSha256(identityPath) ||
      typeof retired.blackglassHomePath !== "string" ||
      !/^\/private\/tmp\/blackglass-client-[A-Za-z0-9]{6}\/h$/u.test(
        retired.blackglassHomePath,
      ) ||
      retired.runtimeHomeRemoved !== true ||
      await pathExists(retired.blackglassHomePath)
    ) {
      throw new Error(`Source-loss reset did not retire ${client} BLACKGLASS_HOME`);
    }
  }
  const recoveryIdentityPath = join(runRoot, "client-b-recovery-launch.json");
  const recoveryBinding = await verifyLiveClientLaunchBinding(recoveryIdentityPath);
  const recoveryIdentity = recoveryBinding.identity;
  if (
    recoveryIdentity.runManifestSha256 !== preparedRun.manifestSha256 ||
    recoveryIdentity.releaseManifestSha256 !==
      preparedRun.manifest.releaseManifestSha256 ||
    recoveryIdentity.profilePath !== join(runRoot, "client-b", "user-data") ||
    recoveryIdentity.vaultPath !== join(runRoot, "client-b", "vault") ||
    recoveryIdentity.adapterSha256 !==
      preparedRun.manifest.compatibilityAsarSha256 ||
    Date.parse(recoveryIdentity.startedAt) <= Date.parse(reset.resetAt) ||
    ((await stat(recoveryIdentityPath)).mode & 0o777) !== 0o600
  ) {
    throw new Error("Fresh recovery client identity does not match the source-loss reset");
  }
  const restored = await buildManifest(restoredVault);
  assertCanonicalRecoveryCorpusManifest(restored);
  const expectedMap = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const restoredMap = new Map(restored.map((entry) => [entry.path, entry]));
  const missing = manifest.files.filter((entry) => !restoredMap.has(entry.path));
  const unexpected = restored.filter((entry) => !expectedMap.has(entry.path));
  const changed = manifest.files.filter((entry) => {
    const actual = restoredMap.get(entry.path);
    return actual && (actual.sha256 !== entry.sha256 || actual.size !== entry.size);
  });
  const clientAExists = await pathExists(join(runRoot, "client-a"));
  const database = databaseSnapshot(join(runRoot, "server.sqlite"));
  const databaseRegressed =
    database.revisions < manifest.database.revisions ||
    database.maxUid < manifest.database.maxUid ||
    database.vaults.length !== manifest.database.vaults.length;
  const recoveryUx = await verifyRecoveryUi(
    runRoot,
    recoveryBinding,
  );
  const report = {
    schemaVersion: 3,
    verifiedAt: Date.now(),
    ok:
      !clientAExists &&
      !databaseRegressed &&
      missing.length === 0 &&
      unexpected.length === 0 &&
      changed.length === 0,
    clientAExists,
    databaseRegressed,
    expectedFiles: manifest.files.length,
    restoredFiles: restored.length,
    corpus: manifest.corpus,
    missing,
    unexpected,
    changed,
    databaseAtCapture: manifest.database,
    databaseAtRecovery: database,
    runManifestSha256: manifest.runManifestSha256,
    serverArtifactSha256: manifest.serverArtifactSha256,
    syncReportSha256: manifest.syncReportSha256,
    recoveryManifestSha256,
    sourceLossResetSha256,
    sourceLossResetAt: reset.resetAt,
    recoveryClient: {
      identityPath: recoveryBinding.identityPath,
      identitySha256: recoveryBinding.identitySha256,
      pid: recoveryIdentity.pid,
      debugPort: recoveryIdentity.debugPort,
      debugListenerPid: recoveryIdentity.debugListenerPid,
      debugTargetId: recoveryIdentity.debugTargetId,
      debugTargetUrl: recoveryIdentity.debugTargetUrl,
      profilePath: recoveryIdentity.profilePath,
      vaultPath: recoveryIdentity.vaultPath,
      startedAt: recoveryIdentity.startedAt,
    },
    recoveryUx,
  };
  const output = join(runRoot, "recovery-report.json");
  await writeJson(output, report, true);
  console.log(JSON.stringify({ action, output, ...report }, null, 2));
  if (!report.ok) process.exitCode = 1;
} else {
  usage();
}

type ManifestEntry = RecoveryCorpusFileEntry;
type DatabaseSnapshot = {
  revisions: number;
  revisionBytes: number;
  encryptedPaths: number;
  maxUid: number;
  vaults: Array<{ name: string; size: number; version: number }>;
};
type RecoveryManifest = {
  schemaVersion: number;
  sourceVault: string;
  runManifestSha256: string;
  serverArtifactSha256: string;
  syncReportSha256: string;
  database: DatabaseSnapshot;
  corpus: RecoveryCorpusIdentity;
  files: ManifestEntry[];
};

async function buildManifest(vault: string): Promise<ManifestEntry[]> {
  const paths = await walk(vault);
  const entries: ManifestEntry[] = [];
  for (const path of paths) {
    const relativePath = relative(vault, path).split("\\").join("/");
    if (relativePath === ".DS_Store" || relativePath.startsWith(".obsidian/")) continue;
    const bytes = await readFile(path);
    entries.push({
      path: relativePath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return entries.sort((a, b) => compareCodePointStrings(a.path, b.path));
}

async function walk(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(path)));
    else if (entry.isFile() && (await stat(path)).isFile()) output.push(path);
    else throw new Error(`Recovery vault contains an unsupported entry: ${path}`);
  }
  return output;
}

function databaseSnapshot(path: string): DatabaseSnapshot {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const server = database
      .query(
        "SELECT COUNT(*) AS revisions, COALESCE(SUM(size), 0) AS revisionBytes, " +
          "COUNT(DISTINCT path) AS encryptedPaths, COALESCE(MAX(uid), 0) AS maxUid FROM revisions",
      )
      .get() as Omit<DatabaseSnapshot, "vaults">;
    const vaults = database
      .query("SELECT name, size, version FROM vaults ORDER BY created")
      .all() as DatabaseSnapshot["vaults"];
    return { ...server, vaults };
  } finally {
    database.close();
  }
}

function e2ePath(value: string, label: string): string {
  const path = resolve(value);
  if (!path.startsWith(`${e2eRoot}/`)) {
    throw new Error(`${label} must be inside ${e2eRoot}`);
  }
  return path;
}

function assertExpectedVault(runRoot: string, vault: string, client: string): void {
  const expected = join(runRoot, client, "vault");
  if (vault !== expected) {
    throw new Error(`Expected ${client} vault at ${expected}; received ${vault}`);
  }
}

async function assertNoSymlinkSegments(path: string): Promise<void> {
  const relativePath = relative(e2eRoot, path);
  let current = e2eRoot;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Recovery path must not traverse a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyRecoveryUi(
  runRoot: string,
  launch: LiveClientLaunchBinding,
): Promise<Record<string, unknown>> {
  const screenshotPath = join(runRoot, "evidence/recovery/client-b-restored.png");
  const statePath = join(runRoot, "evidence/recovery/client-b-restored.json");
  const screenshot = await readFile(screenshotPath);
  const screenshotStat = await stat(screenshotPath);
  const stateStat = await stat(statePath);
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    schemaVersion?: unknown;
    observedAt?: unknown;
    debugPort?: unknown;
    rendererPageCount?: unknown;
    visibleRendererPageCount?: unknown;
    url?: unknown;
    bodyText?: unknown;
    accessibleText?: unknown;
    screenshotPath?: unknown;
    screenshotSha256?: unknown;
    launchIdentityPath?: unknown;
    launchIdentitySha256?: unknown;
    runManifestSha256?: unknown;
    releaseManifestSha256?: unknown;
    launchedPid?: unknown;
    debugListenerPid?: unknown;
    debugTargetId?: unknown;
    profilePath?: unknown;
    vaultPath?: unknown;
  };
  const identity = launch.identity;
  const width = screenshot.length >= 24 ? screenshot.readUInt32BE(16) : 0;
  const height = screenshot.length >= 24 ? screenshot.readUInt32BE(20) : 0;
  if (
    screenshot.length < 1024 ||
    (screenshotStat.mode & 0o777) !== 0o600 ||
    (stateStat.mode & 0o777) !== 0o600 ||
    !screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    screenshot.subarray(12, 16).toString("ascii") !== "IHDR" ||
    width < 640 ||
    height < 400 ||
    width > 16_384 ||
    height > 16_384 ||
    state.schemaVersion !== E2E_UI_EVIDENCE_SCHEMA_VERSION ||
    state.debugPort !== identity.debugPort ||
    state.rendererPageCount !== 1 ||
    state.visibleRendererPageCount !== 1 ||
    state.url !== identity.debugTargetUrl ||
    typeof state.observedAt !== "string" ||
    !Number.isFinite(Date.parse(state.observedAt)) ||
    Date.parse(state.observedAt) <= Date.parse(identity.startedAt) ||
    Date.parse(state.observedAt) > Date.now() + 5_000 ||
    Math.abs(screenshotStat.mtimeMs - Date.parse(state.observedAt)) > 30_000 ||
    typeof state.bodyText !== "string" ||
    !state.bodyText.includes("Recovery Drill Home") ||
    !Array.isArray(state.accessibleText) ||
    state.accessibleText.some((value) => typeof value !== "string") ||
    !state.accessibleText.includes("Fully synced") ||
    typeof state.screenshotPath !== "string" ||
    resolve(state.screenshotPath) !== screenshotPath ||
    state.screenshotSha256 !== sha256(screenshot) ||
    state.launchIdentityPath !== launch.identityPath ||
    state.launchIdentitySha256 !== launch.identitySha256 ||
    state.runManifestSha256 !== launch.run.manifestSha256 ||
    state.releaseManifestSha256 !== identity.releaseManifestSha256 ||
    state.launchedPid !== identity.pid ||
    state.debugListenerPid !== identity.debugListenerPid ||
    state.debugTargetId !== identity.debugTargetId ||
    state.profilePath !== identity.profilePath ||
    state.vaultPath !== identity.vaultPath
  ) {
    throw new Error("Recovery UI evidence is missing or not bound to the fresh client");
  }
  return {
    path: relative(runRoot, screenshotPath),
    statePath: relative(runRoot, statePath),
    bytes: screenshotStat.size,
    sha256: sha256(screenshot),
    width,
    height,
    observedAt: state.observedAt,
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertRecoveryManifestEntries(
  value: unknown,
): asserts value is RecoveryCorpusFileEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Recovery manifest does not contain a file list");
  }
  let previousPath = "";
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("path" in entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path
        .split("/")
        .some((segment: string) => !segment || segment === "." || segment === "..") ||
      !("size" in entry) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      !("sha256" in entry) ||
      !isSha256(entry.sha256) ||
      compareCodePointStrings(entry.path, previousPath) <= 0
    ) {
      throw new Error("Recovery manifest has malformed, duplicate, or unsorted files");
    }
    previousPath = entry.path;
  }
}

async function writeJson(path: string, value: unknown, exclusive = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: exclusive ? "wx" : "w",
    mode: 0o600,
  });
}

function usage(): never {
  console.error(
    "Usage: bun run tools/recovery-drill.ts create <vault> | " +
      "capture <run-root> <vault> | verify <run-root> <restored-vault>",
  );
  process.exit(2);
}
