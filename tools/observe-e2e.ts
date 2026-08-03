import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { parseStrictFlags } from "./cli-flags";
import { readPreparedE2ERun } from "./e2e-network";

const [
  actionArgument,
  rootArgumentValue,
  sourceNameValue,
  destinationNameValue,
  relativePathValue,
  ...flagArguments
] = Bun.argv.slice(2);
const parsed = parseStrictFlags(flagArguments, { valueFlags: ["--timeout-ms"] });
const timeoutMs = parseTimeout(parsed.values.get("--timeout-ms"));
if (
  !["transfer", "delete"].includes(actionArgument ?? "") ||
  !rootArgumentValue ||
  !sourceNameValue ||
  !destinationNameValue ||
  !relativePathValue
) {
  usage();
}
const action = actionArgument as "transfer" | "delete";
const rootArgument = rootArgumentValue as string;
const sourceName = sourceNameValue as string;
const destinationName = destinationNameValue as string;
const relativePath = relativePathValue as string;

const allowedProofs = new Set([
  "E2E Sync Proof.md",
  "Reverse Sync Proof.md",
  "Deletion Sync Proof.md",
]);
if (!allowedProofs.has(relativePath)) {
  throw new Error(`Unsupported E2E proof path: ${relativePath}`);
}
if (
  !["client-a", "client-b"].includes(sourceName) ||
  !["client-a", "client-b"].includes(destinationName) ||
  sourceName === destinationName
) {
  throw new Error("E2E transfer must use two distinct prepared clients");
}

const e2eRoot = resolve(import.meta.dir, "../.data/e2e");
const run = await readPreparedE2ERun(rootArgument);
const root = run.root;
const source = join(root, sourceName, "vault", relativePath);
const destination = join(root, destinationName, "vault", relativePath);
await assertNoSymlinkSegments(source);
await assertNoSymlinkSegments(destination);

const slug = relativePath.replace(/\.md$/u, "").toLowerCase().replaceAll(" ", "-");
const output = join(root, "observations", `${action}-${slug}.json`);
const intentPath = `${output}.intent`;
const existingIntent = await readIntentIfExists();
if (await finishInterruptedPublication(existingIntent)) {
  console.log(JSON.stringify(JSON.parse(await readFile(output, "utf8")), null, 2));
  process.exit(0);
}
if (await exists(output)) throw new Error(`Refusing to overwrite E2E observation: ${output}`);

if (action === "transfer") {
  const intent = await prepareTransferIntent();
  const contents = Buffer.from(intent.contentsBase64, "base64");
  await ensureTransferStarted(intent, contents);
  const deadline = Date.now() + timeoutMs;
  let after: DatabaseSnapshot | undefined;
  while (Date.now() < deadline) {
    const candidate = await readIfExists(destination);
    const current = databaseSnapshot(join(root, "server.sqlite"));
    if (
      candidate?.equals(contents) &&
      current.revisions > intent.databaseBefore.revisions &&
      current.maxUid > intent.databaseBefore.maxUid &&
      current.vaultVersion > intent.databaseBefore.vaultVersion
    ) {
      after = current;
      break;
    }
    await Bun.sleep(100);
  }
  if (!after) {
    throw new Error(`Timed out waiting for background Sync transfer: ${relativePath}`);
  }
  await writeObservation(output, {
    schemaVersion: 1,
    action,
    observedAt: new Date().toISOString(),
    sourceClient: sourceName,
    destinationClient: destinationName,
    relativePath,
    sourceCreatedAt: intent.mutationAt,
    bytes: contents.byteLength,
    sha256: sha256(contents),
    markerSha256: intent.markerSha256,
    databaseBefore: intent.databaseBefore,
    databaseAfter: after,
  });
  await unlink(intentPath);
} else {
  const intent = await prepareDeleteIntent();
  const sourceBytes = Buffer.from(intent.contentsBase64, "base64");
  await ensureDeleteStarted(intent, sourceBytes);
  const deadline = Date.now() + timeoutMs;
  let after: DatabaseSnapshot | undefined;
  while (Date.now() < deadline) {
    const current = databaseSnapshot(join(root, "server.sqlite"));
    if (
      !(await exists(destination)) &&
      current.revisions > intent.databaseBefore.revisions &&
      current.maxUid > intent.databaseBefore.maxUid &&
      current.vaultVersion > intent.databaseBefore.vaultVersion
    ) {
      after = current;
      break;
    }
    await Bun.sleep(100);
  }
  if (!after) {
    throw new Error(`Timed out waiting for background Sync deletion: ${relativePath}`);
  }
  await writeObservation(output, {
    schemaVersion: 1,
    action,
    observedAt: new Date().toISOString(),
    sourceClient: sourceName,
    destinationClient: destinationName,
    relativePath,
    sourceDeletedAt: intent.mutationAt,
    bytes: sourceBytes.byteLength,
    sha256: sha256(sourceBytes),
    databaseBefore: intent.databaseBefore,
    databaseAfter: after,
  });
  await unlink(intentPath);
}

console.log(JSON.stringify(JSON.parse(await readFile(output, "utf8")), null, 2));

type DatabaseSnapshot = {
  revisions: number;
  maxUid: number;
  vaultVersion: number;
  vaultSize: number;
};

type ObservationIntent = {
  schemaVersion: 1;
  runManifestSha256: string;
  action: "transfer" | "delete";
  sourceClient: string;
  destinationClient: string;
  relativePath: string;
  mutationAt: string;
  contentsBase64: string;
  contentsSha256: string;
  markerSha256?: string;
  databaseBefore: DatabaseSnapshot;
};

async function prepareTransferIntent(): Promise<ObservationIntent> {
  const existing = await readIntentIfExists();
  if (existing) return existing;
  if (await exists(source) || await exists(destination)) {
    throw new Error(`Transfer proof exists without a resumable observation intent: ${relativePath}`);
  }
  const marker = randomBytes(24).toString("base64url");
  const contents = Buffer.from(
    `# ${relativePath.replace(/\.md$/u, "")}\n\n` +
      `Generated by the Blackglass exact-artifact E2E observer.\n\n` +
      `Marker: ${marker}\n`,
  );
  return await writeIntent({
    schemaVersion: 1,
    runManifestSha256: run.manifestSha256,
    action: "transfer",
    sourceClient: sourceName,
    destinationClient: destinationName,
    relativePath,
    mutationAt: new Date().toISOString(),
    contentsBase64: contents.toString("base64"),
    contentsSha256: sha256(contents),
    markerSha256: sha256(Buffer.from(marker)),
    databaseBefore: databaseSnapshot(join(root, "server.sqlite")),
  });
}

async function prepareDeleteIntent(): Promise<ObservationIntent> {
  const existing = await readIntentIfExists();
  if (existing) return existing;
  const sourceBytes = await readFile(source);
  const destinationBytes = await readFile(destination);
  if (!sourceBytes.equals(destinationBytes)) {
    throw new Error(`Cannot observe deletion before the two clients converge: ${relativePath}`);
  }
  return await writeIntent({
    schemaVersion: 1,
    runManifestSha256: run.manifestSha256,
    action: "delete",
    sourceClient: sourceName,
    destinationClient: destinationName,
    relativePath,
    mutationAt: new Date().toISOString(),
    contentsBase64: sourceBytes.toString("base64"),
    contentsSha256: sha256(sourceBytes),
    databaseBefore: databaseSnapshot(join(root, "server.sqlite")),
  });
}

async function ensureTransferStarted(
  intent: ObservationIntent,
  contents: Buffer,
): Promise<void> {
  const sourceBytes = await readIfExists(source);
  const destinationBytes = await readIfExists(destination);
  if (sourceBytes && !sourceBytes.equals(contents)) {
    throw new Error(`Resumable transfer source changed: ${relativePath}`);
  }
  if (destinationBytes && !destinationBytes.equals(contents)) {
    throw new Error(`Resumable transfer destination changed: ${relativePath}`);
  }
  if (!sourceBytes) {
    if (destinationBytes) {
      throw new Error(`Cannot safely resume an unstarted transfer: ${relativePath}`);
    }
    if (!sameSnapshot(databaseSnapshot(join(root, "server.sqlite")), intent.databaseBefore)) {
      await unlink(intentPath);
      throw new Error(
        `Database advanced before transfer mutation; cleared the unstarted intent: ${relativePath}`,
      );
    }
    await writeFile(source, contents, { flag: "wx", mode: 0o600 });
  }
}

async function ensureDeleteStarted(
  intent: ObservationIntent,
  contents: Buffer,
): Promise<void> {
  const sourceBytes = await readIfExists(source);
  const destinationBytes = await readIfExists(destination);
  if (sourceBytes && !sourceBytes.equals(contents)) {
    throw new Error(`Resumable deletion source changed: ${relativePath}`);
  }
  if (destinationBytes && !destinationBytes.equals(contents)) {
    throw new Error(`Resumable deletion destination changed: ${relativePath}`);
  }
  if (sourceBytes) await unlink(source);
}

async function writeIntent(intent: ObservationIntent): Promise<ObservationIntent> {
  await mkdir(dirname(intentPath), { recursive: true, mode: 0o700 });
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return intent;
}

async function readIntentIfExists(): Promise<ObservationIntent | undefined> {
  const bytes = await readIfExists(intentPath);
  if (!bytes) return undefined;
  const metadata = await lstat(intentPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid!() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Unsafe resumable observation intent: ${intentPath}`);
  }
  const value = JSON.parse(bytes.toString("utf8")) as ObservationIntent;
  const contents = Buffer.from(value.contentsBase64 ?? "", "base64");
  const marker = value.action === "transfer" ? markerFromTransferContents(contents) : undefined;
  if (
    value.schemaVersion !== 1 ||
    value.runManifestSha256 !== run.manifestSha256 ||
    value.action !== action ||
    value.sourceClient !== sourceName ||
    value.destinationClient !== destinationName ||
    value.relativePath !== relativePath ||
    !Number.isFinite(Date.parse(value.mutationAt)) ||
    contents.toString("base64") !== value.contentsBase64 ||
    sha256(contents) !== value.contentsSha256 ||
    (value.action === "transfer" && sha256(Buffer.from(marker ?? "")) !== value.markerSha256) ||
    (value.action === "delete" && value.markerSha256 !== undefined) ||
    !validSnapshot(value.databaseBefore)
  ) {
    throw new Error(`Invalid or mismatched resumable observation intent: ${intentPath}`);
  }
  return value;
}

async function finishInterruptedPublication(
  intent: ObservationIntent | undefined,
): Promise<boolean> {
  const temporary = `${output}.next`;
  const [publishedBytes, temporaryBytes] = await Promise.all([
    readIfExists(output),
    readIfExists(temporary),
  ]);
  if (!publishedBytes && !temporaryBytes) return false;
  if (!intent) {
    throw new Error(`Observation publication residue has no valid intent: ${output}`);
  }
  if (publishedBytes && temporaryBytes) {
    throw new Error(`Observation has conflicting published and pending evidence: ${output}`);
  }
  const evidenceBytes = publishedBytes ?? temporaryBytes!;
  validateCompletedObservation(evidenceBytes, intent);
  if (temporaryBytes) await rename(temporary, output);
  await unlink(intentPath);
  return true;
}

function validateCompletedObservation(
  bytes: Buffer,
  intent: ObservationIntent,
): void {
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
  const expectedKeys = [
    "action",
    "bytes",
    "databaseAfter",
    "databaseBefore",
    "destinationClient",
    "observedAt",
    "relativePath",
    "schemaVersion",
    "sha256",
    "sourceClient",
    intent.action === "transfer" ? "markerSha256" : undefined,
    intent.action === "transfer" ? "sourceCreatedAt" : "sourceDeletedAt",
  ].filter((item): item is string => Boolean(item)).sort();
  const actualKeys = Object.keys(value).sort();
  const timestampKey = intent.action === "transfer" ? "sourceCreatedAt" : "sourceDeletedAt";
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    value.schemaVersion !== 1 ||
    value.action !== intent.action ||
    value.sourceClient !== intent.sourceClient ||
    value.destinationClient !== intent.destinationClient ||
    value.relativePath !== intent.relativePath ||
    value[timestampKey] !== intent.mutationAt ||
    value.bytes !== Buffer.from(intent.contentsBase64, "base64").byteLength ||
    value.sha256 !== intent.contentsSha256 ||
    (intent.action === "transfer" && value.markerSha256 !== intent.markerSha256) ||
    JSON.stringify(value.databaseBefore) !== JSON.stringify(intent.databaseBefore) ||
    !validSnapshot(value.databaseAfter) ||
    !snapshotAdvanced(value.databaseAfter, intent.databaseBefore) ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    Date.parse(value.observedAt) < Date.parse(intent.mutationAt)
  ) {
    throw new Error(`Pending observation does not match its publication intent: ${output}`);
  }
}

function markerFromTransferContents(contents: Buffer): string | undefined {
  const match = contents.toString("utf8").match(/\nMarker: ([A-Za-z0-9_-]{32})\n$/u);
  return match?.[1];
}

function validSnapshot(value: DatabaseSnapshot): boolean {
  return Boolean(value) && [
    value.revisions,
    value.maxUid,
    value.vaultVersion,
    value.vaultSize,
  ].every((item) => Number.isSafeInteger(item) && item >= 0);
}

function sameSnapshot(left: DatabaseSnapshot, right: DatabaseSnapshot): boolean {
  return left.revisions === right.revisions && left.maxUid === right.maxUid &&
    left.vaultVersion === right.vaultVersion && left.vaultSize === right.vaultSize;
}

function snapshotAdvanced(after: DatabaseSnapshot, before: DatabaseSnapshot): boolean {
  return after.revisions > before.revisions && after.maxUid > before.maxUid &&
    after.vaultVersion > before.vaultVersion;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return 300_000;
  if (!/^[0-9]+$/u.test(value)) throw new Error("Observation timeout must be an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new Error("Observation timeout must be between 1000 and 600000 milliseconds");
  }
  return parsed;
}

function databaseSnapshot(path: string): DatabaseSnapshot {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const revision = database
      .query<{ revisions: number; maxUid: number }, []>(
        "SELECT COUNT(*) AS revisions, COALESCE(MAX(uid), 0) AS maxUid FROM revisions",
      )
      .get();
    const vault = database
      .query<{ version: number; size: number }, []>(
        "SELECT version, size FROM vaults ORDER BY created LIMIT 1",
      )
      .get();
    if (!revision || !vault) throw new Error("E2E database has no remote vault");
    return {
      revisions: revision.revisions,
      maxUid: revision.maxUid,
      vaultVersion: vault.version,
      vaultSize: vault.size,
    };
  } finally {
    database.close();
  }
}

async function writeObservation(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await readIfExists(path)) !== undefined;
}

async function assertNoSymlinkSegments(path: string): Promise<void> {
  const relativePath = relative(e2eRoot, path);
  let current = e2eRoot;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`E2E proof path must not traverse a symbolic link: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function usage(): never {
  console.error(
    "Usage: bun run tools/observe-e2e.ts <transfer|delete> <run-directory> " +
      "<source-client> <destination-client> <proof.md> [--timeout-ms <milliseconds>]",
  );
  process.exit(2);
}
