import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { patchAsar } from "../packages/client-adapter/src/patch";
import type { RendererIncision, WrapperIncision } from "../packages/client-adapter/src/incision";
import { AsarArchive } from "../tools/asar";
import { inspectMacOSArtifact } from "../tools/macos-artifact";
import { inspectMacOSCodeInventory } from "../tools/macos-code-inventory";
import { inspectMacOSPackagingToolchain, packagingExecutionMode } from "../tools/packaging-toolchain";
import { stableJson } from "../tools/stable-json";
import { parseBlackglassReleaseManifest } from "../tools/release-manifest";
import {
  discoverRendererRelease,
  discoverUnpackedJavaScriptFiles,
  type CompatibilityAnchor,
  type CompatibilityBaseline,
} from "../tools/release-compatibility";
import { computeTreeIdentity } from "../tools/tree-identity";
import { computeToolingSourceIdentityAtRevision } from "../tools/tooling-source";
import { verifyMacOSReproducibility } from "../tools/verify-macos-reproducibility";

const projectRoot = resolve(import.meta.dir, "..");

test("packages only the open launcher and locally generated adapter", async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const fixture = await syntheticFixture();
  const first = join(fixture.root, "first");
  const second = join(fixture.root, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  const firstPaths = await packageFixture(fixture, first);
  const secondPaths = await packageFixture(fixture, second);
  const artifact = await inspectMacOSArtifact(firstPaths.app);
  expect(artifact).toMatchObject({
    schemaVersion: 9,
    appBundleName: "Blackglass Bridge.app",
    bundleIdentifier: "com.blackglass.bridge",
    executableName: "blackglass-bridge",
    rendererVersion: "1.12.7",
    officialAppUnmodified: true,
    exactOfficialAppVerifiedAtEveryLaunch: true,
  });
  expect(artifact.codeInventory.entries.map((entry) => entry.path)).toEqual([
    ".",
    "Contents/MacOS/blackglass-bridge",
  ]);
  for (const forbidden of [
    "Contents/MacOS/Obsidian",
    "Contents/MacOS/obsidian-cli",
    "Contents/Resources/app.asar",
    "Contents/Frameworks",
  ]) {
    expect(await Bun.file(join(firstPaths.app, forbidden)).exists()).toBe(false);
  }
  const release = parseBlackglassReleaseManifest(await readFile(firstPaths.manifest));
  expect(release.packagingToolchain.executionMode).toBe("development");
  expect(stableJson(release.packagingToolchain)).toBe(
    stableJson(await inspectMacOSPackagingToolchain()),
  );
  expect(release.distribution).toEqual({
    officialApplicationRedistributed: false,
    officialWrapperRedistributed: false,
    officialCliRedistributed: false,
    proprietaryAssetsRedistributed: false,
    adaptedRendererGeneratedLocally: true,
  });
  expect(release.source.unchanged).toBe(true);
  expect(release.macOS.officialAppTreeSha256).toBe(release.source.appTree.sha256);

  const reproducibility = await verifyMacOSReproducibility({
    firstApp: firstPaths.app,
    firstManifest: firstPaths.manifest,
    firstReceipt: firstPaths.receipt,
    secondApp: secondPaths.app,
    secondManifest: secondPaths.manifest,
    secondReceipt: secondPaths.receipt,
  });
  expect(reproducibility.passed).toBe(true);
  expect(reproducibility.separateOutputs).toBe(true);
}, 60_000);

test("fails closed for a changed official tree, adapter, or output identity", async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const fixture = await syntheticFixture();
  await writeFile(join(fixture.sourceApp, "changed"), "changed");
  const output = join(fixture.root, "changed-output");
  await mkdir(output);
  const result = runPackage(fixture, output);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("reviewed baseline tree");

  const wrongName = join(fixture.root, "wrong-name");
  await mkdir(wrongName);
  const wrong = runPackage(fixture, wrongName, "Blackglass.app");
  expect(wrong.exitCode).not.toBe(0);
  expect(wrong.stderr.toString()).toContain("Blackglass Bridge.app");
}, 60_000);

test("rejects an arbitrary executable in place of the source-bound Bridge", async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const fixture = await syntheticFixture();
  const output = join(fixture.root, "arbitrary-launcher");
  await mkdir(output);
  const result = runPackage({ ...fixture, standalone: "/usr/bin/true" }, output);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("valid build information");
}, 60_000);

test("attests the actual packaging executor independently from the embedded launcher", () => {
  expect(packagingExecutionMode(process.execPath)).toBe("standalone");
  expect(packagingExecutionMode("/usr/bin/true")).toBe("development");
});

interface Fixture {
  root: string;
  sourceApp: string;
  patchedAsar: string;
  baseline: string;
  dmg: string;
  standalone: string;
  toolingSource: string;
  endpoints: { controlOrigin: string; dataHost: string };
}

async function syntheticFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "blackglass-launcher-package-"));
  const sourceApp = join(root, "Obsidian.app");
  const resources = join(sourceApp, "Contents/Resources");
  const macos = join(sourceApp, "Contents/MacOS");
  await Promise.all([mkdir(resources, { recursive: true }), mkdir(macos, { recursive: true })]);
  const sourceAsar = makeRendererArchive();
  const wrapperFixture = sourceWrapperFixture();
  const wrapperAsar = makeArchive({
    "main.js": wrapperFixture.source,
    "package.json": Buffer.from('{"name":"obsidian"}'),
  });
  await Promise.all([
    writeFile(join(resources, "obsidian.asar"), sourceAsar),
    writeFile(join(resources, "app.asar"), wrapperAsar),
    copyFile("/usr/bin/true", join(macos, "Obsidian")),
    writeFile(join(macos, "obsidian-cli"), ".obsidian-cli.sock .obsidian-cli.sock"),
    writeFile(join(sourceApp, "Contents/Info.plist"), sourceInfoPlist()),
  ]);
  await chmod(join(macos, "Obsidian"), 0o755);
  run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", "--timestamp=none", sourceApp]);
  const dmg = join(root, "Obsidian-1.12.7.dmg");
  await writeFile(dmg, "synthetic official DMG");
  const baseline = join(root, "compatibility.json");
  const baselineValue = await testCompatibilityBaseline(
    sourceAsar,
    wrapperAsar,
    wrapperFixture.incisions,
    sourceApp,
    dmg,
  );
  await writeFile(baseline, `${JSON.stringify(baselineValue, null, 2)}\n`);
  const endpoints = { controlOrigin: "http://127.0.0.1:3000", dataHost: "127.0.0.1:3003" };
  const patchedAsar = join(root, "blackglass.asar");
  await writeFile(patchedAsar, patchAsar(sourceAsar, endpoints, baselineValue.patchIncisions).buffer);
  const revision = runText(["git", "-C", projectRoot, "rev-parse", "HEAD"]);
  const sourceIdentity = computeToolingSourceIdentityAtRevision(projectRoot, revision);
  const toolingSource = join(root, "tooling-source.json");
  await writeFile(toolingSource, `${JSON.stringify(sourceIdentity, null, 2)}\n`);
  const standalone = join(root, "blackglass-bridge");
  const build = Bun.spawnSync([
    Bun.which("bun")!, "build", "--compile", "--target=bun-darwin-arm64",
    "tools/bridge-cli.ts", "--outfile", standalone,
    "--define", `__BLACKGLASS_BRIDGE_VERSION__=${JSON.stringify("0.3.0")}`,
    "--define", `__BLACKGLASS_BRIDGE_REVISION__=${JSON.stringify(revision)}`,
    "--define", `__BLACKGLASS_TOOLING_SOURCE_JSON__=${JSON.stringify(JSON.stringify(sourceIdentity))}`,
  ], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  return { root, sourceApp, patchedAsar, baseline, dmg, standalone, toolingSource, endpoints };
}

async function packageFixture(fixture: Fixture, output: string) {
  const result = runPackage(fixture, output);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return {
    app: join(output, "Blackglass Bridge.app"),
    manifest: join(output, "release.json"),
    receipt: join(output, "receipt.json"),
  };
}

function runPackage(fixture: Fixture, output: string, appName = "Blackglass Bridge.app") {
  return Bun.spawnSync([
    Bun.which("bun")!, "run", "tools/package-macos.ts",
    fixture.sourceApp, fixture.patchedAsar, join(output, appName),
    "--control-origin", fixture.endpoints.controlOrigin,
    "--data-host", fixture.endpoints.dataHost,
    "--manifest", join(output, "release.json"),
    "--receipt", join(output, "receipt.json"),
    "--official-dmg", fixture.dmg,
    "--baseline", fixture.baseline,
    "--standalone-executable", fixture.standalone,
    "--tooling-source", fixture.toolingSource,
    "--blackglass-version", "0.3.0",
  ], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
}

function makeRendererArchive(): Buffer {
  const control = "false".padEnd(64, " ");
  const data = "true".padEnd(64, " ");
  const runtime = "hm.homedir()".padEnd(48, " ");
  const registration = 'let aa=pp.join(rr,"obsidian-cli");if(ff.existsSync(aa)){let cc="/usr/local/bin/obsidian";';
  return makeArchive({
    "app.js": Buffer.from(`var dw="https://"+[${control}].join("."),mw=window.fetch;function gw(path){return mw(dw+path,{method:"POST"})}if(${data})throw Error();gw("/user/signin");new WebSocket(url);socket.send({op:"ping"});x.prototype.onMessage=function(e){var t=e.op;if("ready"===t)return};`),
    "main.js": Buffer.from(`module.exports=function(){const home=${runtime};const socket=".obsidian-cli.sock";${registration}}}`),
    "starter.js": Buffer.from(`var sa="https://"+[${control}].join(".");gw("/user/signin");`),
    "index.html": Buffer.from('<script src="app.js"></script>'),
    "package.json": Buffer.from('{"version":"1.12.7"}'),
  });
}

async function testCompatibilityBaseline(
  sourceAsar: Buffer,
  wrapperAsar: Buffer,
  wrapperIncisions: WrapperIncision[],
  sourceApp: string,
  dmg: string,
): Promise<CompatibilityBaseline> {
  const incisions = rendererPatchIncisions(sourceAsar);
  const anchors: CompatibilityAnchor[] = incisions.map(({ replacement: _replacement, ...range }) => range);
  const unpacked = await discoverUnpackedJavaScriptFiles(join(sourceApp, "Contents/Resources"));
  const discovered = discoverRendererRelease(sourceAsar, anchors, unpacked);
  return {
    schemaVersion: 6,
    id: "synthetic-obsidian-1.12.7",
    rendererVersion: discovered.rendererVersion,
    officialDmgSha256: sha256(await readFile(dmg)),
    sourceAppTree: await computeTreeIdentity(sourceApp),
    sourceMacOSCodeInventory: await inspectMacOSCodeInventory(sourceApp, "source-contract"),
    sourceAsarSha256: discovered.sourceAsarSha256,
    sourceWrapperAsarSha256: sha256(wrapperAsar),
    keyFiles: discovered.keyFiles,
    javaScriptFiles: discovered.javaScriptFiles,
    unpackedJavaScriptFiles: discovered.unpackedJavaScriptFiles,
    unpackedJavaScriptReview: { status: "reviewed", reviewedPaths: Object.keys(discovered.unpackedJavaScriptFiles) },
    anchors,
    patchIncisions: incisions,
    wrapperIncisions,
    runtimeContract: { wrapperRendererArguments: 2, rendererDevModeArgument: null },
    controlPlaneRoutes: discovered.controlPlaneRoutes,
    controlPlaneRouteLocations: discovered.controlPlaneRouteLocations,
    controlPlaneRequestHelpers: discovered.controlPlaneRequestHelpers,
    networkConstructors: discovered.networkConstructors,
    syncOperations: discovered.syncOperations,
    syncOperationLocations: discovered.syncOperationLocations,
    syncMessageShapes: discovered.syncMessageShapes,
    syncMessageShapeLocations: discovered.syncMessageShapeLocations,
    syncInboundOperations: discovered.syncInboundOperations,
  };
}

function sourceWrapperFixture(): { source: Buffer; incisions: WrapperIncision[] } {
  const prefix = "const fs=require('fs'),path=require('path'),util=require('util'),os=require('os');\n";
  const ranges = [" ".repeat(1400), " ".repeat(160), " ".repeat(220)];
  const source = Buffer.from(`${prefix}${ranges.join("\n")}`);
  let offset = prefix.length;
  const replacements = ["profile-bootstrap", "disable-updater", "embedded-renderer-only"] as const;
  const incisions = ranges.map((value, index) => {
    const result = { id: `wrapper-${index}`, file: "main.js" as const, offset, length: value.length, sha256: sha256(Buffer.from(value)), replacement: replacements[index]! };
    offset += value.length + 1;
    return result;
  });
  return { source, incisions };
}

function rendererPatchIncisions(sourceAsar: Buffer): RendererIncision[] {
  const archive = AsarArchive.fromBuffer(sourceAsar);
  const definitions = [
    ["control", "app.js", "false".padEnd(64, " "), "control-host"],
    ["data", "app.js", "true".padEnd(64, " "), "data-host-guard"],
    ["starter", "starter.js", "false".padEnd(64, " "), "control-host"],
    ["runtime", "main.js", "hm.homedir()".padEnd(48, " "), "cli-runtime-home"],
    ["socket", "main.js", ".obsidian-cli.sock", "cli-socket"],
    ["registration", "main.js", 'let aa=pp.join(rr,"obsidian-cli");if(ff.existsSync(aa)){let cc="/usr/local/bin/obsidian";', "cli-registration"],
  ] as const;
  return definitions.map(([id, file, value, replacement]) => {
    const bytes = archive.read(file);
    const needle = Buffer.from(value);
    const offset = bytes.indexOf(needle);
    return { id, file, offset, length: needle.length, sha256: sha256(needle), replacement };
  });
}

function makeArchive(files: Record<string, Buffer>): Buffer {
  let offset = 0;
  const nodes: Record<string, unknown> = {};
  const payloads: Buffer[] = [];
  for (const [name, contents] of Object.entries(files)) {
    nodes[name] = { size: contents.length, offset: String(offset), integrity: { algorithm: "SHA256", hash: sha256(contents) } };
    payloads.push(contents);
    offset += contents.length;
  }
  const json = Buffer.from(JSON.stringify({ files: nodes }));
  const padded = (json.length + 3) & ~3;
  const header = Buffer.alloc(12 + 4 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...payloads]);
}

function sourceInfoPlist(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Obsidian</string><key>CFBundleIdentifier</key><string>md.obsidian</string><key>CFBundleName</key><string>Obsidian</string><key>CFBundleDisplayName</key><string>Obsidian</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>';
}
function run(args: string[]): void {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
function runText(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
