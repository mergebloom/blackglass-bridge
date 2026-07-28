import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { Database } from "bun:sqlite";
import {
  type LiveClientLaunchBinding,
  verifyLiveClientLaunchBinding,
} from "./e2e-client";
import { readPreparedE2ERun } from "./e2e-network";
import { pathExists } from "./path-safety";

const [action, firstArgument, secondArgument] = Bun.argv.slice(2);
const e2eRoot = resolve(import.meta.dir, "../.data/e2e");

if (action === "create") {
  if (!firstArgument) usage();
  const vault = e2ePath(firstArgument, "fixture vault");
  await assertNoSymlinkSegments(vault);
  const files = fixtureFiles();
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
      schemaVersion: 2,
      capturedAt: new Date().toISOString(),
      sourceVault: "client-a/vault",
      runManifestSha256,
      serverArtifactSha256,
      syncReportSha256,
      database,
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
    manifest.schemaVersion !== 2 ||
    manifest.sourceVault !== "client-a/vault" ||
    !isSha256(manifest.runManifestSha256) ||
    !isSha256(manifest.serverArtifactSha256) ||
    !isSha256(manifest.syncReportSha256) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error("Malformed or unsupported recovery manifest");
  }
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
  const reset = JSON.parse(
    await readFile(join(runRoot, "source-loss-reset.json"), "utf8"),
  ) as {
    schemaVersion?: unknown;
    resetAt?: unknown;
    runManifestSha256?: unknown;
    syncReportSha256?: unknown;
    recoveryManifestSha256?: unknown;
    retiredRuntimeHomes?: Record<
      string,
      {
        identitySha256?: unknown;
        blackglassHomePath?: unknown;
        runtimeHomeRemoved?: unknown;
      }
    >;
    freshClient?: { adapterSha256?: unknown; initialVaultFiles?: unknown };
  };
  if (
    reset.schemaVersion !== 2 ||
    typeof reset.resetAt !== "string" ||
    !Number.isFinite(Date.parse(reset.resetAt)) ||
    reset.runManifestSha256 !== preparedRun.manifestSha256 ||
    reset.syncReportSha256 !== manifest.syncReportSha256 ||
    reset.recoveryManifestSha256 !==
      await fileSha256(join(runRoot, "recovery-manifest.json")) ||
    reset.freshClient?.adapterSha256 !==
      preparedRun.manifest.compatibilityAsarSha256 ||
    reset.freshClient?.initialVaultFiles !== 0
  ) {
    throw new Error("Source-loss reset is not bound to this recovery run");
  }
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
    schemaVersion: 2,
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
    missing,
    unexpected,
    changed,
    databaseAtCapture: manifest.database,
    databaseAtRecovery: database,
    runManifestSha256: manifest.runManifestSha256,
    serverArtifactSha256: manifest.serverArtifactSha256,
    syncReportSha256: manifest.syncReportSha256,
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

type ManifestEntry = { path: string; size: number; sha256: string };
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
  return entries.sort((a, b) => a.path.localeCompare(b.path));
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
    state.schemaVersion !== 1 ||
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

function fixtureFiles(): Map<string, string | Uint8Array> {
  const files = new Map<string, string | Uint8Array>();
  files.set(
    "Home.md",
    `---\ntags: [recovery, sync, e2e]\nstatus: verified-source\n---\n\n# Recovery Drill Home\n\n> [!success] Background sync fixture\n> This vault mixes notes, images, structured data, a canvas, source code, and a PDF.\n\n## Navigation\n\n- [[Projects/Recovery Plan]]\n- [[Research/Field Notes]]\n- [[Journal/2026-07-25]]\n- [[Data/Inventory]]\n- [[Gallery]]\n\n## Visual proof\n\n![[Assets/recovery-chart.png]]\n\n![[Assets/system-map.svg]]\n\n| Stage | Expected result |\n| --- | --- |\n| Client A | Uploads automatically |\n| Server | Stores encrypted revisions |\n| Client B | Restores byte-identical files |\n`,
  );
  files.set(
    "Projects/Recovery Plan.md",
    `# Recovery Plan\n\n- [x] Connect client A\n- [x] Enable images, PDFs, and other types\n- [ ] Remove the original local client\n- [ ] Restore to a clean client B\n- [ ] Compare every SHA-256 digest\n\n## Acceptance\n\n1. No manual retry after fixture creation.\n2. Server revision count and bytes increase.\n3. The clean client recreates the complete manifest.\n\nSee [[Home]] and [[Research/Field Notes]].\n`,
  );
  files.set(
    "Research/Field Notes.md",
    `# Field Notes\n\n## Hypothesis\n\nThe patched stock Sync client can preserve the built-in UX while targeting a self-hosted control and data plane.\n\n> [!note]\n> Paths and content should be encrypted before reaching the server.\n\n## Evidence links\n\n- [[Data/Inventory]]\n- [[Gallery]]\n- [[Projects/Recovery Plan]]\n`,
  );
  files.set(
    "Journal/2026-07-25.md",
    `# 2026-07-25\n\nCreated the recovery corpus from disposable client A.\n\n- Mixed Markdown syntax\n- Multiple nested folders\n- Raster and vector images\n- PDF and structured data\n- Canvas and JavaScript fixture\n\nUnique marker: RECOVERY-20260725-ALPHA\n`,
  );
  files.set(
    "Gallery.md",
    `# Gallery\n\n## PNG\n\n![[Assets/recovery-chart.png]]\n\n## SVG\n\n![[Assets/system-map.svg]]\n\nThe two images exercise raster and vector attachment synchronization.\n`,
  );
  files.set(
    "Data/Inventory.md",
    `# Inventory\n\nThe structured fixtures are [[inventory.csv]] and [[sample.json]].\n\n| Kind | File | Purpose |\n| --- | --- | --- |\n| CSV | inventory.csv | Tabular data |\n| JSON | sample.json | Structured metadata |\n| Canvas | ../Boards/Recovery.canvas | Visual graph |\n| Source | ../Snippets/recovery-check.js | Unsupported extension |\n| PDF | ../Documents/recovery-brief.pdf | Document attachment |\n`,
  );
  files.set("Data/inventory.csv", "kind,path,count\nnote,Markdown,6\nimage,Assets,2\ndocument,Documents,1\nstructured,Data,2\n");
  files.set(
    "Data/sample.json",
    JSON.stringify({ drill: "recovery", date: "2026-07-25", expected: "byte-identical", values: [1, 2, 3, 5, 8] }, null, 2) + "\n",
  );
  files.set(
    "Boards/Recovery.canvas",
    JSON.stringify(
      {
        nodes: [
          { id: "a", type: "text", text: "Client A", x: 0, y: 0, width: 240, height: 120 },
          { id: "s", type: "text", text: "Blackglass Server", x: 360, y: 0, width: 260, height: 120 },
          { id: "b", type: "text", text: "Fresh client B", x: 760, y: 0, width: 240, height: 120 },
        ],
        edges: [
          { id: "e1", fromNode: "a", fromSide: "right", toNode: "s", toSide: "left" },
          { id: "e2", fromNode: "s", fromSide: "right", toNode: "b", toSide: "left" },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  files.set(
    "Snippets/recovery-check.js",
    `export function recoveryMarker() {\n  return "RECOVERY-20260725-ALPHA";\n}\n`,
  );
  files.set("Assets/recovery-chart.png", makePng(720, 360));
  files.set(
    "Assets/system-map.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300"><rect width="900" height="300" rx="24" fill="#171923"/><g font-family="Arial,sans-serif" text-anchor="middle"><rect x="55" y="85" width="210" height="130" rx="18" fill="#7c3aed"/><rect x="345" y="85" width="210" height="130" rx="18" fill="#2563eb"/><rect x="635" y="85" width="210" height="130" rx="18" fill="#059669"/><g fill="white" font-size="25" font-weight="700"><text x="160" y="155">Client A</text><text x="450" y="155">Blackglass</text><text x="740" y="155">Client B</text></g><g stroke="#d1d5db" stroke-width="7" fill="none"><path d="M265 150h75"/><path d="M555 150h75"/></g><g fill="#d1d5db"><path d="M335 135l25 15-25 15z"/><path d="M625 135l25 15-25 15z"/></g></g></svg>\n`,
  );
  files.set("Documents/recovery-brief.pdf", makePdf());
  return files;
}

function makePng(width: number, height: number): Uint8Array {
  const scanline = width * 3 + 1;
  const raw = Buffer.alloc(scanline * height);
  for (let y = 0; y < height; y++) {
    raw[y * scanline] = 0;
    for (let x = 0; x < width; x++) {
      const offset = y * scanline + 1 + x * 3;
      const band = Math.floor((x / width) * 5);
      raw[offset] = 42 + band * 35;
      raw[offset + 1] = 74 + Math.floor((y / height) * 140);
      raw[offset + 2] = 190 - band * 18;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(payload), data.length + 8);
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePdf(): Uint8Array {
  const stream = "BT /F1 24 Tf 72 720 Td (Blackglass recovery drill) Tj 0 -36 Td /F1 14 Tf (RECOVERY-20260725-ALPHA) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
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
