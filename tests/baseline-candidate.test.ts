import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createBaselineCandidate,
  type CompatibilityCandidate,
  type CompatibilityCandidateReviewReport,
} from "../tools/create-baseline-candidate";
import {
  type CompatibilityBaseline,
  discoverRendererRelease,
  loadCompatibilityBaseline,
} from "../tools/release-compatibility";
import { inspectMacOSCodeInventory } from "../tools/macos-code-inventory";

const repositoryRoot = resolve(import.meta.dir, "..");
const anchors = [
  {
    id: "control-anchor",
    file: "app.js",
    literal: "CONTROL_ANCHOR",
    expectedMatches: 1,
  },
];
const predecessorSource =
  "CONTROL_ANCHOR;var mw=window.fetch,WS=window.WebSocket;" +
  "function gw(path){return mw(base+path,{method:'POST'})}" +
  "gw('/user/signin');new WS(url);send({op:'ping',path:item});" +
  "x.prototype.onMessage=function(e){var t=e.op;if('ready'===t)return}";
const candidateSource =
  "CONTROL_ANCHOR;var mw=window.fetch,WS=window.WebSocket;" +
  "function gw(path){return mw(base+path,{method:'POST'})}" +
  "gw('/vault/list');new WS(url);send({op:'push',path:item});" +
  "x.prototype.onMessage=function(e){var t=e.op;if('ack'===t)return}";

describe("future-release compatibility candidates", () => {
  test("writes a deterministic untrusted candidate and exact predecessor diff", async () => {
    if (process.platform !== "darwin") return;
    const firstRoot = await mkdtemp(join(tmpdir(), "blackglass-candidate-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "blackglass-candidate-second-"));
    try {
      const first = await createFixture(firstRoot, candidateSource);
      const second = await createFixture(secondRoot, candidateSource);
      const firstResult = await createBaselineCandidate(first, firstRoot);
      const secondResult = await createBaselineCandidate(second, secondRoot);

      expect(firstResult.outputDirectory).toBe(
        join(
          await realpath(firstRoot),
          ".data/compatibility-candidates/obsidian-1.12.8-from-1.12.7",
        ),
      );
      expect(await readFile(firstResult.candidatePath)).toEqual(
        await readFile(secondResult.candidatePath),
      );
      expect(await readFile(firstResult.reviewPath)).toEqual(
        await readFile(secondResult.reviewPath),
      );

      const candidate = JSON.parse(
        await readFile(firstResult.candidatePath, "utf8"),
      ) as CompatibilityCandidate;
      const report = JSON.parse(
        await readFile(firstResult.reviewPath, "utf8"),
      ) as CompatibilityCandidateReviewReport;
      expect(candidate).toMatchObject({
        formatVersion: 1,
        trust: "untrusted-candidate",
        predecessor: {
          id: "synthetic-predecessor",
          rendererVersion: "1.12.7",
        },
        promotionTarget: "compatibility/obsidian-1.12.8.json",
        proposedBaseline: {
          schemaVersion: 5,
          id: "obsidian-macos-1.12.8",
          rendererVersion: "1.12.8",
          unpackedJavaScriptReview: {
            status: "untrusted-candidate",
            discoveredPaths: ["app.asar.unpacked/node_modules/native/index.js"],
          },
        },
      });
      expect(candidate.proposedBaselineSha256).toBe(firstResult.proposedBaselineSha256);
      expect(candidate.proposedBaseline.officialDmgSha256).toBe(
        digest("authorized synthetic DMG\n"),
      );
      expect(candidate.proposedBaseline.sourceAppTree.sha256).not.toBe("b".repeat(64));
      expect(candidate.proposedBaseline.sourceMacOSCodeInventory.entries.length).toBeGreaterThan(
        1,
      );
      expect(candidate.proposedBaseline.sourceAsarSha256).toBe(
        digest(rendererArchive("1.12.8", candidateSource)),
      );
      expect(candidate.proposedBaseline.sourceWrapperAsarSha256).toBe(
        digest(makeArchive({ "main.js": Buffer.from("// wrapper\n") })),
      );
      expect(report).toMatchObject({
        formatVersion: 1,
        trust: "untrusted-review-report",
        candidate: {
          rendererVersion: "1.12.8",
          proposedBaselineSha256: firstResult.proposedBaselineSha256,
        },
        anchors: [
          {
            id: "control-anchor",
            expectedMatches: 1,
            actualMatches: 1,
            matched: true,
          },
        ],
      });
      expect(report.fileChanges.packedJavaScript.changed["app.js"]).toBeDefined();
      expect(
        report.fileChanges.unpackedJavaScript.added[
          "app.asar.unpacked/node_modules/native/index.js"
        ],
      ).toBeDefined();
      expect(report.semanticInventoryChanges.controlPlaneRoutes).toMatchObject({
        added: { "/vault/list": 1 },
        removed: { "/user/signin": 1 },
      });
      expect((await lstat(firstResult.outputDirectory)).mode & 0o777).toBe(0o700);
      expect((await lstat(firstResult.candidatePath)).mode & 0o777).toBe(0o600);
      expect((await lstat(firstResult.reviewPath)).mode & 0o777).toBe(0o600);
      await expect(loadCompatibilityBaseline(firstResult.candidatePath)).rejects.toThrow(
        "Unsupported compatibility baseline schema",
      );
      await expect(createBaselineCandidate(first, firstRoot)).rejects.toThrow(
        "already exists",
      );
      await expect(lstat(join(firstRoot, "compatibility"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  test("fails before output when a predecessor anchor no longer matches", async () => {
    if (process.platform !== "darwin") return;
    const root = await mkdtemp(join(tmpdir(), "blackglass-candidate-anchor-"));
    try {
      const fixture = await createFixture(
        root,
        candidateSource.replace("CONTROL_ANCHOR", "CHANGED_ANCHOR"),
      );
      await expect(createBaselineCandidate(fixture, root)).rejects.toThrow(
        "no longer matches predecessor anchors",
      );
      await expect(lstat(join(root, ".data"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails before output when any critical semantic inventory is empty", async () => {
    if (process.platform !== "darwin") return;
    const root = await mkdtemp(join(tmpdir(), "blackglass-candidate-empty-"));
    try {
      const fixture = await createFixture(root, "CONTROL_ANCHOR;");
      await expect(createBaselineCandidate(fixture, root)).rejects.toThrow(
        "empty critical semantic inventories",
      );
      await expect(lstat(join(root, ".data"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exposes the candidate workflow through the package script", async () => {
    const metadata = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(metadata.scripts["baseline:candidate"]).toBe(
      "bun run tools/create-baseline-candidate.ts",
    );
  });
});

async function createFixture(
  root: string,
  nextSource: string,
): Promise<{
  officialDmg: string;
  sourceApp: string;
  predecessorBaseline: string;
}> {
  const inputs = join(root, "inputs");
  const sourceApp = join(inputs, "Obsidian.app");
  const contents = join(sourceApp, "Contents");
  const resources = join(sourceApp, "Contents/Resources");
  const executableDirectory = join(contents, "MacOS");
  const unpacked = join(resources, "app.asar.unpacked/node_modules/native");
  await Promise.all([
    mkdir(unpacked, { recursive: true }),
    mkdir(executableDirectory, { recursive: true }),
  ]);

  const predecessorAsar = rendererArchive("1.12.7", predecessorSource);
  const predecessorDiscovery = discoverRendererRelease(predecessorAsar, anchors);
  const officialDmg = join(inputs, "Obsidian-1.12.8.dmg");
  const predecessorBaseline = join(inputs, "obsidian-1.12.7.json");
  await Promise.all([
    writeFile(officialDmg, "authorized synthetic DMG\n"),
    writeFile(join(resources, "obsidian.asar"), rendererArchive("1.12.8", nextSource)),
    writeFile(
      join(resources, "app.asar"),
      makeArchive({ "main.js": Buffer.from("// wrapper\n") }),
    ),
    writeFile(join(unpacked, "index.js"), "module.exports = true;\n"),
    writeFile(join(contents, "Info.plist"), sourceInfoPlist()),
    copyFile("/usr/bin/true", join(executableDirectory, "Obsidian")),
  ]);
  await chmod(join(executableDirectory, "Obsidian"), 0o755);
  signSyntheticApp(sourceApp);
  const baseline: CompatibilityBaseline = {
    schemaVersion: 5,
    id: "synthetic-predecessor",
    rendererVersion: predecessorDiscovery.rendererVersion,
    officialDmgSha256: "a".repeat(64),
    sourceAppTree: {
      formatVersion: 1,
      sha256: "b".repeat(64),
      entries: 1,
      files: 1,
      directories: 0,
      symlinks: 0,
      fileBytes: 1,
    },
    sourceMacOSCodeInventory: await inspectMacOSCodeInventory(
      sourceApp,
      "source-contract",
    ),
    sourceAsarSha256: predecessorDiscovery.sourceAsarSha256,
    sourceWrapperAsarSha256: "c".repeat(64),
    keyFiles: predecessorDiscovery.keyFiles,
    javaScriptFiles: predecessorDiscovery.javaScriptFiles,
    unpackedJavaScriptFiles: {},
    unpackedJavaScriptReview: { status: "reviewed", reviewedPaths: [] },
    anchors,
    controlPlaneRoutes: predecessorDiscovery.controlPlaneRoutes,
    controlPlaneRouteLocations: predecessorDiscovery.controlPlaneRouteLocations,
    controlPlaneRequestHelpers: predecessorDiscovery.controlPlaneRequestHelpers,
    networkConstructors: predecessorDiscovery.networkConstructors,
    syncOperations: predecessorDiscovery.syncOperations,
    syncOperationLocations: predecessorDiscovery.syncOperationLocations,
    syncMessageShapes: predecessorDiscovery.syncMessageShapes,
    syncMessageShapeLocations: predecessorDiscovery.syncMessageShapeLocations,
    syncInboundOperations: predecessorDiscovery.syncInboundOperations,
  };
  await writeFile(predecessorBaseline, `${JSON.stringify(baseline)}\n`);
  return { officialDmg, sourceApp, predecessorBaseline };
}

function sourceInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Obsidian</string>
  <key>CFBundleIdentifier</key><string>md.obsidian.synthetic</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;
}

function signSyntheticApp(app: string): void {
  const result = Bun.spawnSync([
    "/usr/bin/codesign",
    "--force",
    "--deep",
    "--sign",
    "-",
    app,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8"));
  }
}

function rendererArchive(version: string, appJs: string): Buffer {
  return makeArchive({
    "app.js": Buffer.from(appJs),
    "main.js": Buffer.from("// desktop main\n"),
    "index.html": Buffer.from('<script src="app.js"></script>'),
    "package.json": Buffer.from(JSON.stringify({ version })),
  });
}

function makeArchive(files: Record<string, Buffer>): Buffer {
  let offset = 0;
  const nodes: Record<string, unknown> = {};
  const payloads: Buffer[] = [];
  for (const [name, contents] of Object.entries(files)) {
    nodes[name] = {
      size: contents.length,
      offset: String(offset),
      integrity: {
        algorithm: "SHA256",
        hash: createHash("sha256").update(contents).digest("hex"),
      },
    };
    payloads.push(contents);
    offset += contents.length;
  }
  const json = Buffer.from(JSON.stringify({ files: nodes }), "utf8");
  const paddedStringLength = (json.length + 3) & ~3;
  const headerPayloadSize = 4 + paddedStringLength;
  const headerPickleSize = 4 + headerPayloadSize;
  const header = Buffer.alloc(8 + headerPickleSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerPickleSize, 4);
  header.writeUInt32LE(headerPayloadSize, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...payloads]);
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
