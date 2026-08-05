import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { patchAsar, RENDERER_INCISION_COUNT, RENDERER_PATCH_FORMAT_VERSION } from "../packages/client-adapter/src/patch";
import bridgeIconPath from "../assets/blackglass-prism.icns" with { type: "file" };
import { AsarArchive } from "./asar";
import { parseStrictFlags } from "./cli-flags";
import { inspectMacOSCodeInventory, macOSCodeInventoriesEqual } from "./macos-code-inventory";
import { inspectMacOSArtifact, publicMacOSArtifact } from "./macos-artifact";
import { createMacOSPackageReceipt, serializeMacOSPackageReceipt } from "./macos-package-receipt";
import { clearMacOSAppExtendedAttributes } from "./macos-root-metadata";
import {
  adapterProfileFileName,
  BRIDGE_BUNDLE_IDENTIFIER,
  BRIDGE_BUNDLE_NAME,
  BRIDGE_EXECUTABLE_NAME,
  BRIDGE_ICON_FILE,
  BRIDGE_LAUNCH_CONFIG_SCHEMA_VERSION,
  BRIDGE_PROFILE_DIRECTORY,
  type BridgeLaunchConfig,
} from "./launcher-config";
import { MACOS_PACKAGING_EXECUTABLES, inspectMacOSPackagingToolchain, packagingExecutionMode } from "./packaging-toolchain";
import { assertNonOverlappingPaths, canonicalExistingPath, canonicalOutputPath } from "./path-safety";
import { qualifyRendererRelease, discoverUnpackedJavaScriptFiles } from "./release-compatibility";
import {
  assertBlackglassReleaseManifest,
  BLACKGLASS_RELEASE_MANIFEST_SCHEMA_VERSION,
  type BlackglassReleaseManifest,
} from "./release-manifest";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";
import { stableJson } from "./stable-json";
import { assertStandaloneBridgeBuildInfo } from "./standalone-bridge";
import { computeToolingSourceIdentity, assertToolingSourceIdentity, type ToolingSourceIdentity } from "./tooling-source";
import { computeTreeIdentity } from "./tree-identity";
import { withPackageStaging } from "./package-staging";

const [sourceArgument, asarArgument, outputArgument, ...flagArguments] = Bun.argv.slice(2);
if (!sourceArgument || !asarArgument || !outputArgument) usage();
const flags = parseStrictFlags(flagArguments, {
  valueFlags: [
    "--control-origin", "--data-host", "--manifest", "--receipt", "--baseline",
    "--official-dmg", "--tooling-source", "--blackglass-version", "--standalone-executable",
  ],
});
const controlOrigin = flags.values.get("--control-origin");
const dataHost = flags.values.get("--data-host");
const manifestArgument = flags.values.get("--manifest");
const standaloneArgument = flags.values.get("--standalone-executable");
if (!controlOrigin || !dataHost || !manifestArgument || !standaloneArgument) usage();

const sourceApp = await canonicalExistingPath(sourceArgument, "Official Obsidian app", "directory");
const patchedAsar = await canonicalExistingPath(asarArgument, "Patched renderer", "file");
const standaloneExecutable = await canonicalExistingPath(standaloneArgument, "Standalone Bridge executable", "file");
const baselinePath = flags.values.get("--baseline")
  ? await canonicalExistingPath(flags.values.get("--baseline")!, "Compatibility baseline", "file")
  : undefined;
const officialDmg = flags.values.get("--official-dmg")
  ? await canonicalExistingPath(flags.values.get("--official-dmg")!, "Official Obsidian DMG", "file")
  : undefined;
const toolingSourcePath = flags.values.get("--tooling-source")
  ? await canonicalExistingPath(flags.values.get("--tooling-source")!, "Tooling source identity", "file")
  : undefined;
const outputApp = await canonicalOutputPath(outputArgument, "Blackglass Bridge app");
const manifestPath = await canonicalOutputPath(manifestArgument, "Release manifest");
const receiptPath = await canonicalOutputPath(
  flags.values.get("--receipt") ?? join(dirname(manifestPath), "blackglass-package-receipt.json"),
  "Package receipt",
);
if (basename(sourceApp) !== "Obsidian.app") throw new Error("Official source must be named Obsidian.app");
if (basename(outputApp) !== BRIDGE_BUNDLE_NAME) throw new Error(`Output must be named ${BRIDGE_BUNDLE_NAME}`);
if (dirname(outputApp) !== dirname(manifestPath) || dirname(outputApp) !== dirname(receiptPath)) {
  throw new Error("Launcher, manifest, and receipt must share one output directory");
}
assertNonOverlappingPaths([
  { label: "Official Obsidian app", path: sourceApp },
  { label: "Patched renderer", path: patchedAsar },
  { label: "Standalone Bridge executable", path: standaloneExecutable },
  { label: "Blackglass Bridge app", path: outputApp },
  { label: "Release manifest", path: manifestPath },
  { label: "Package receipt", path: receiptPath },
]);

const sourceAsarPath = join(sourceApp, "Contents/Resources/obsidian.asar");
const sourceWrapperPath = join(sourceApp, "Contents/Resources/app.asar");
const sourceCliPath = join(sourceApp, "Contents/MacOS/obsidian-cli");
const sourceAsarBytes = await readFile(sourceAsarPath);
const sourceWrapperBytes = await readFile(sourceWrapperPath);
const sourceCliBytes = await readFile(sourceCliPath);
const patchedAsarBytes = await readFile(patchedAsar);
const sourceArchive = AsarArchive.fromBuffer(sourceAsarBytes);
const patchedArchive = AsarArchive.fromBuffer(patchedAsarBytes);
const rendererVersion = archiveVersion(sourceArchive);
if (archiveVersion(patchedArchive) !== rendererVersion) throw new Error("Patched renderer version changed");
patchedArchive.read("app.js");
patchedArchive.read("starter.js");
patchedArchive.read("main.js");
const qualification = await qualifyRendererRelease(
  sourceAsarBytes,
  baselinePath,
  await discoverUnpackedJavaScriptFiles(join(sourceApp, "Contents/Resources")),
);
const sourceTree = await computeTreeIdentity(sourceApp);
if (stableJson(sourceTree) !== stableJson(qualification.loadedBaseline.baseline.sourceAppTree)) {
  throw new Error("Official Obsidian application does not match the reviewed baseline tree");
}
const sourceCodeInventory = await inspectMacOSCodeInventory(sourceApp, "source-contract");
if (!macOSCodeInventoriesEqual(sourceCodeInventory, qualification.loadedBaseline.baseline.sourceMacOSCodeInventory)) {
  throw new Error("Official Obsidian code inventory does not match the reviewed baseline");
}
const sourceWrapperSha256 = sha256(sourceWrapperBytes);
const sourceCliSha256 = sha256(sourceCliBytes);
if (sourceWrapperSha256 !== qualification.loadedBaseline.baseline.sourceWrapperAsarSha256) {
  throw new Error("Official wrapper does not match the reviewed baseline");
}
const reproduced = patchAsar(
  sourceAsarBytes,
  { controlOrigin, dataHost },
  qualification.loadedBaseline.baseline.patchIncisions,
);
if (!reproduced.buffer.equals(patchedAsarBytes)) {
  throw new Error("Patched renderer is not the deterministic reviewed adaptation");
}
const officialDmgSha256 = officialDmg ? await sha256File(officialDmg) : undefined;
if (officialDmgSha256 && officialDmgSha256 !== qualification.loadedBaseline.baseline.officialDmgSha256) {
  throw new Error("Official DMG does not match the reviewed compatibility baseline");
}
const toolingSource = toolingSourcePath
  ? await readToolingSourceIdentity(toolingSourcePath)
  : await computeToolingSourceIdentity();
const packagingToolchain = await inspectMacOSPackagingToolchain({
  executionMode: packagingExecutionMode(standaloneExecutable),
});
const blackglassVersion = flags.values.get("--blackglass-version") ?? await packageVersion();
if (!isSupportedSemver(blackglassVersion)) throw new Error("Blackglass version is invalid");
const standaloneInfo = inspectStandaloneExecutable(standaloneExecutable);
if (
  standaloneInfo.version !== blackglassVersion ||
  stableJson(standaloneInfo.toolingSource) !== stableJson(toolingSource)
) {
  throw new Error("Standalone Bridge executable does not match the requested version and tooling source");
}
const standaloneArchitectures = runText([
  MACOS_PACKAGING_EXECUTABLES.lipo,
  "-archs",
  standaloneExecutable,
]).split(/\s+/u).filter(Boolean);
if (standaloneArchitectures.length !== 1 || standaloneArchitectures[0] !== "arm64") {
  throw new Error("Standalone Bridge executable must contain exactly one arm64 architecture");
}

const invocationId = randomUUID();
const startedAt = new Date().toISOString();
await withPackageStaging(outputApp, async (stagingRoot) => {
  const stagedApp = join(stagingRoot, BRIDGE_BUNDLE_NAME);
  const stagedManifest = join(stagingRoot, basename(manifestPath));
  const stagedReceipt = join(stagingRoot, basename(receiptPath));
  const contents = join(stagedApp, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await mkdir(macos, { recursive: true, mode: 0o755 });
  await mkdir(resources, { recursive: true, mode: 0o755 });
  const launcherExecutable = join(macos, BRIDGE_EXECUTABLE_NAME);
  const embeddedAdapter = join(resources, "blackglass.asar");
  const embeddedIcon = join(resources, BRIDGE_ICON_FILE);
  await copyFile(standaloneExecutable, launcherExecutable);
  await chmod(launcherExecutable, 0o755);
  await copyFile(patchedAsar, embeddedAdapter);
  await chmod(embeddedAdapter, 0o600);
  await copyFile(bridgeIconPath, embeddedIcon);
  await chmod(embeddedIcon, 0o644);
  const launchConfig: BridgeLaunchConfig = {
    schemaVersion: BRIDGE_LAUNCH_CONFIG_SCHEMA_VERSION,
    blackglassVersion,
    rendererVersion,
    adapterFileName: "blackglass.asar",
    adapterSha256: reproduced.report.patchedSha256,
    adapterProfileFileName: adapterProfileFileName(rendererVersion),
    officialAppPath: sourceApp,
    officialBundleIdentifier: "md.obsidian",
    officialExecutableName: "Obsidian",
    officialAppTree: sourceTree,
    officialCodeInventory: sourceCodeInventory,
    profileDirectory: BRIDGE_PROFILE_DIRECTORY,
    profileMode: 0o700,
    updateDisabled: true,
    requireExclusiveOfficialInstance: true,
  };
  await writeFile(join(resources, "bridge-launch.json"), `${stableJson(launchConfig)}\n`, { mode: 0o600 });
  await writeFile(join(contents, "Info.plist"), infoPlist(blackglassVersion, rendererVersion), { mode: 0o644 });
  await clearMacOSAppExtendedAttributes(stagedApp);
  signLauncher(launcherExecutable, stagedApp);
  const artifact = await inspectMacOSArtifact(stagedApp);
  const publicArtifact = publicMacOSArtifact(artifact);
  const manifest: BlackglassReleaseManifest = {
    schemaVersion: BLACKGLASS_RELEASE_MANIFEST_SCHEMA_VERSION,
    blackglassVersion,
    rendererVersion,
    compatibilityBaseline: qualification.report.baseline,
    source: {
      officialDmgSha256: qualification.loadedBaseline.baseline.officialDmgSha256,
      appTree: sourceTree,
      rendererAsarSha256: reproduced.report.upstreamSha256,
      wrapperAsarSha256: sourceWrapperSha256,
      cliExecutableSha256: sourceCliSha256,
      macOSCodeInventory: sourceCodeInventory,
      unchanged: true,
    },
    patcher: { renderer: { formatVersion: RENDERER_PATCH_FORMAT_VERSION, incisions: RENDERER_INCISION_COUNT } },
    endpoints: { controlOrigin: reproduced.report.controlOrigin, dataHost: reproduced.report.dataHost },
    packagingToolchain,
    toolingSource,
    renderer: reproduced.report,
    macOS: publicArtifact,
    launchPolicy: {
      profileDirectory: BRIDGE_PROFILE_DIRECTORY,
      profileMode: 0o700,
      explicitUserDataDir: true,
      nativeHomePreserved: true,
      blackglassHomeEnvironment: "BLACKGLASS_HOME",
      updatesDisabledBeforeLaunch: true,
      exactOfficialAppVerifiedAtEveryLaunch: true,
      exclusiveOfficialInstance: true,
      officialChildSupervisionRequired: true,
    },
    distribution: {
      officialApplicationRedistributed: false,
      officialWrapperRedistributed: false,
      officialCliRedistributed: false,
      proprietaryAssetsRedistributed: false,
      adaptedRendererGeneratedLocally: true,
    },
    reproduction: {
      officialDmgMatchedBaseline: officialDmgSha256 !== undefined,
      sourceAppTreeMatchedBaseline: true,
      sourceCodeInventoryMatchedBaseline: true,
      sourceWrapperMatchesBaseline: true,
      sourceCliMatchesBaseline: true,
      rendererByteIdentical: true,
      launcherContainsOnlyBridgeCodeAndLocalAdapter: true,
      officialAppUnmodified: true,
    },
  };
  assertBlackglassReleaseManifest(manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(stagedManifest, manifestBytes, { flag: "wx", mode: 0o600 });
  const receipt = createMacOSPackageReceipt({
    invocationId,
    startedAt,
    completedAt: new Date().toISOString(),
    manifest,
    releaseManifestSha256: sha256(manifestBytes),
    artifact: publicArtifact,
  });
  await writeFile(stagedReceipt, serializeMacOSPackageReceipt(receipt), { flag: "wx", mode: 0o600 });
  await publish(stagedApp, outputApp, stagedManifest, manifestPath, stagedReceipt, receiptPath);
  console.log(JSON.stringify({ passed: true, outputApp, manifestPath, receiptPath, artifact: publicArtifact }, null, 2));
});

function archiveVersion(archive: AsarArchive): string {
  const value = JSON.parse(archive.read("package.json").toString("utf8")) as { version?: unknown };
  if (!isSupportedStableSemver(value.version)) throw new Error("Renderer has no stable semantic version");
  return value.version;
}

function infoPlist(version: string, rendererVersion: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>Blackglass Bridge</string>
<key>CFBundleExecutable</key><string>${BRIDGE_EXECUTABLE_NAME}</string>
<key>CFBundleIdentifier</key><string>${BRIDGE_BUNDLE_IDENTIFIER}</string>
<key>CFBundleIconFile</key><string>${BRIDGE_ICON_FILE}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>Blackglass Bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>BlackglassRendererVersion</key><string>${rendererVersion}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSMultipleInstancesProhibited</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

function signLauncher(executable: string, app: string): void {
  run([MACOS_PACKAGING_EXECUTABLES.codesign, "--force", "--sign", "-", "--timestamp=none", "--identifier", `${BRIDGE_BUNDLE_IDENTIFIER}.executable`, executable]);
  run([MACOS_PACKAGING_EXECUTABLES.codesign, "--force", "--sign", "-", "--timestamp=none", "--identifier", BRIDGE_BUNDLE_IDENTIFIER, app]);
  run([MACOS_PACKAGING_EXECUTABLES.codesign, "--verify", "--deep", "--strict", "--all-architectures", app]);
}

function run(args: string[]): void {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
}

function runText(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
  return result.stdout.toString("utf8").trim();
}

function inspectStandaloneExecutable(path: string) {
  const result = Bun.spawnSync([path, "build-info"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error("Standalone Bridge executable did not provide valid build information");
  }
  let value: unknown;
  try { value = JSON.parse(result.stdout.toString("utf8")); }
  catch { throw new Error("Standalone Bridge build information is not JSON"); }
  assertStandaloneBridgeBuildInfo(value);
  return value;
}

async function readToolingSourceIdentity(path: string): Promise<ToolingSourceIdentity> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertToolingSourceIdentity(value);
  if (!value.worktreeClean || !value.gitRevision) throw new Error("Packaging requires clean source-bound tooling");
  return value;
}

async function packageVersion(): Promise<string> {
  return String((JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8")) as { version: unknown }).version);
}

async function sha256File(path: string): Promise<string> { return sha256(await readFile(path)); }
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function publish(app: string, outputApp: string, manifest: string, outputManifest: string, receipt: string, outputReceipt: string): Promise<void> {
  const published: Array<[string, string]> = [];
  try {
    for (const [source, destination] of [
      [app, outputApp],
      [manifest, outputManifest],
      [receipt, outputReceipt],
    ] as const) {
      await rename(source, destination);
      published.push([destination, source]);
    }
  } catch (error) {
    const rollbackErrors: Error[] = [];
    for (const [destination, source] of published.reverse()) {
      try { await rename(destination, source); }
      catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
      }
    }
    throw rollbackErrors.length === 0
      ? new Error(`Package publication failed and was rolled back: ${String(error)}`)
      : new AggregateError(
          [error instanceof Error ? error : new Error(String(error)), ...rollbackErrors],
          "Package publication failed and rollback was incomplete",
        );
  }
}

function usage(): never {
  console.error(`Usage: bun run tools/package-macos.ts <official Obsidian.app> <patched.asar> <${BRIDGE_BUNDLE_NAME}> --control-origin <https-origin> --data-host <host[:port]> --manifest <release.json> --standalone-executable <blackglass-bridge> [--receipt <receipt.json>] [--baseline <baseline.json>] [--official-dmg <official.dmg>] [--tooling-source <identity.json>] [--blackglass-version <version>]`);
  process.exit(2);
}
