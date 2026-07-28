import { createHash } from "node:crypto";
import { copyFile, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  patchAsar,
  RENDERER_INCISION_COUNT,
  RENDERER_PATCH_FORMAT_VERSION,
} from "../packages/client-adapter/src/patch";
import {
  inspectEmbeddedRendererDevModeContract,
  patchMacOSWrapperAsar,
  WRAPPER_INCISION_COUNT,
  WRAPPER_PATCH_FORMAT_VERSION,
} from "../packages/client-adapter/src/wrapper";
import { AsarArchive, asarHeaderSha256 } from "./asar";
import {
  CLI_BINARY_INCISION_COUNT,
  CLI_BINARY_PATCH_FORMAT_VERSION,
  inspectPatchedCliBinary,
  patchCliBinary,
} from "./cli-binary";
import { parseStrictFlags } from "./cli-flags";
import {
  ELECTRON_HELPER_VARIANTS,
  inspectMacOSArtifact,
  publicMacOSArtifact,
} from "./macos-artifact";
import {
  discoverUnpackedJavaScriptFiles,
  qualifyRendererRelease,
} from "./release-compatibility";
import {
  assertNonOverlappingPaths,
  canonicalExistingPath,
  canonicalOutputPath,
} from "./path-safety";
import {
  assertBridgeReleaseManifest,
  BRIDGE_RELEASE_MANIFEST_SCHEMA_VERSION,
  type BridgeReleaseManifest,
} from "./release-manifest";
import { computeTreeIdentity } from "./tree-identity";
import { computeToolingSourceIdentity } from "./tooling-source";
import { withPackageStaging } from "./package-staging";
import { isSupportedSemver, isSupportedStableSemver } from "./semver";

const [sourceArgument, asarArgument, outputArgument, ...flags] = Bun.argv.slice(
  2,
);
if (!sourceArgument || !asarArgument || !outputArgument) {
  usage();
}

const parsedFlags = parseStrictFlags(flags, {
  valueFlags: [
    "--control-origin",
    "--data-host",
    "--manifest",
    "--baseline",
    "--official-dmg",
  ],
});
const controlOrigin = parsedFlags.values.get("--control-origin");
const dataHost = parsedFlags.values.get("--data-host");
const manifestArgument = parsedFlags.values.get("--manifest");
const baselineArgument = parsedFlags.values.get("--baseline");
const officialDmgArgument = parsedFlags.values.get("--official-dmg");
if (!controlOrigin || !dataHost || !manifestArgument || !officialDmgArgument) {
  usage();
}

const sourceApp = await canonicalExistingPath(
  sourceArgument,
  "Source app",
  "directory",
);
const patchedAsar = await canonicalExistingPath(
  asarArgument,
  "Patched ASAR",
  "file",
);
const officialDmg = await canonicalExistingPath(
  officialDmgArgument,
  "Official release DMG",
  "file",
);
const baselinePath = baselineArgument
  ? await canonicalExistingPath(
    baselineArgument,
    "Compatibility baseline",
    "file",
  )
  : undefined;
const outputApp = await canonicalOutputPath(outputArgument, "Output app");
const manifestPath = await canonicalOutputPath(
  manifestArgument,
  "Release manifest",
);
if (!sourceApp.endsWith(".app") || !outputApp.endsWith(".app")) {
  throw new Error("Source and output must be .app bundles");
}
if (!manifestPath.endsWith(".json")) {
  throw new Error("Release manifest output must be a .json file");
}
if (dirname(manifestPath) !== dirname(outputApp)) {
  throw new Error(
    "Output app and release manifest must use the same canonical directory",
  );
}
assertNonOverlappingPaths([
  { label: "Source app", path: sourceApp },
  { label: "Patched ASAR", path: patchedAsar },
  { label: "Official release DMG", path: officialDmg },
  { label: "Output app", path: outputApp },
  { label: "Release manifest", path: manifestPath },
  ...(baselinePath
    ? [{ label: "Compatibility baseline", path: baselinePath }]
    : []),
]);

const sourceAsar = join(sourceApp, "Contents/Resources/obsidian.asar");
const sourceWrapperAsar = join(sourceApp, "Contents/Resources/app.asar");
const sourceCliExecutable = join(sourceApp, "Contents/MacOS/obsidian-cli");
const sourceInfoPlist = join(sourceApp, "Contents/Info.plist");
const sourceAsarBytes = await readFile(sourceAsar);
const sourceCliBytes = await readFile(sourceCliExecutable);
const generatedCli = patchCliBinary(sourceCliBytes);
const patchedAsarBytes = await readFile(patchedAsar);
const sourceArchive = AsarArchive.fromBuffer(sourceAsarBytes);
const patchedArchive = AsarArchive.fromBuffer(patchedAsarBytes);
const toolingSource = await computeToolingSourceIdentity();
const sourceVersion = readVersion(sourceArchive);
const patchedVersion = readVersion(patchedArchive);
patchedArchive.read("app.js");
patchedArchive.read("starter.js");
const unpackedJavaScriptFiles = await discoverUnpackedJavaScriptFiles(
  join(sourceApp, "Contents/Resources"),
);
const qualification = await qualifyRendererRelease(
  sourceAsarBytes,
  baselinePath,
  unpackedJavaScriptFiles,
);
const officialDmgSha256 = await sha256File(officialDmg);
if (
  officialDmgSha256 !== qualification.loadedBaseline.baseline.officialDmgSha256
) {
  throw new Error(
    "Official release DMG does not match the reviewed compatibility baseline",
  );
}
const sourceAppTree = await computeTreeIdentity(sourceApp);
if (
  !treeIdentityEqual(
    sourceAppTree,
    qualification.loadedBaseline.baseline.sourceAppTree,
  )
) {
  throw new Error(
    "Source app tree does not match the reviewed official DMG baseline",
  );
}
const reproducedRenderer = patchAsar(sourceAsarBytes, {
  controlOrigin,
  dataHost,
});
if (!reproducedRenderer.buffer.equals(patchedAsarBytes)) {
  throw new Error(
    "Adapter ASAR is not the byte-identical result of the reviewed source, endpoints, and current patcher",
  );
}
const sourceAsarSha256 = reproducedRenderer.report.upstreamSha256;
const patchedAsarSha256 = reproducedRenderer.report.patchedSha256;
if (sourceAsarSha256 === patchedAsarSha256) {
  throw new Error("Adapter ASAR is byte-identical to the official renderer");
}
const bundleVersion = runText([
  "plutil",
  "-extract",
  "CFBundleShortVersionString",
  "raw",
  "-o",
  "-",
  sourceInfoPlist,
]);
if (sourceVersion !== patchedVersion || sourceVersion !== bundleVersion) {
  throw new Error(
    `Version mismatch: bundle=${bundleVersion}, source=${sourceVersion}, adapter=${patchedVersion}`,
  );
}

const sourceWrapperBytes = await readFile(sourceWrapperAsar);
inspectEmbeddedRendererDevModeContract(sourceAsarBytes, sourceWrapperBytes);
if (
  generatedSha256(sourceWrapperBytes) !==
    qualification.loadedBaseline.baseline.sourceWrapperAsarSha256
) {
  throw new Error(
    "Upstream Electron wrapper does not match the reviewed compatibility baseline",
  );
}
const sourceWrapperDeclaredSha256 = electronAsarIntegrityHash(sourceInfoPlist);
if (asarHeaderSha256(sourceWrapperBytes) !== sourceWrapperDeclaredSha256) {
  throw new Error(
    "Upstream Electron wrapper hash does not match Info.plist integrity metadata",
  );
}
const sourceBundleIdentifier = plistString(
  sourceInfoPlist,
  "CFBundleIdentifier",
);
const sourceDisplayName = plistString(sourceInfoPlist, "CFBundleDisplayName");
const sourceBundleName = plistString(sourceInfoPlist, "CFBundleName");
const sourceExecutableName = plistString(sourceInfoPlist, "CFBundleExecutable");
if (
  sourceBundleIdentifier !== "md.obsidian" ||
  sourceDisplayName !== "Obsidian" ||
  sourceBundleName !== "Obsidian" ||
  sourceExecutableName !== "Obsidian"
) {
  throw new Error(
    "Unexpected upstream macOS runtime identity: " +
      JSON.stringify({
        bundleIdentifier: sourceBundleIdentifier,
        displayName: sourceDisplayName,
        bundleName: sourceBundleName,
        executableName: sourceExecutableName,
      }),
  );
}
const sourceUrlScheme = plistString(
  sourceInfoPlist,
  "CFBundleURLTypes.0.CFBundleURLSchemes.0",
);
if (sourceUrlScheme !== "obsidian") {
  throw new Error(
    `Expected the upstream wrapper to register obsidian://, found ${sourceUrlScheme}`,
  );
}
await validatePreservedElectronHelpers(
  sourceApp,
  sourceDisplayName,
  sourceBundleIdentifier,
);

await withPackageStaging(outputApp, async (stagingRoot) => {
  const stagedApp = join(stagingRoot, basename(outputApp));
  const stagedManifest = join(stagingRoot, basename(manifestPath));
  run(["ditto", sourceApp, stagedApp]);
  const stagedCopyTree = await computeTreeIdentity(stagedApp);
  if (!treeIdentityEqual(stagedCopyTree, sourceAppTree)) {
    throw new Error("Staged app copy does not match the reviewed source tree");
  }
  const infoPlist = join(stagedApp, "Contents/Info.plist");
  const packagedAsar = join(stagedApp, "Contents/Resources/obsidian.asar");
  await copyFile(patchedAsar, packagedAsar);
  if ((await sha256File(packagedAsar)) !== patchedAsarSha256) {
    throw new Error("Packaged renderer hash does not match the adapter input");
  }
  const generatedWrapper = patchMacOSWrapperAsar(sourceWrapperBytes);
  inspectEmbeddedRendererDevModeContract(
    patchedAsarBytes,
    generatedWrapper.buffer,
  );
  const packagedWrapperAsar = join(stagedApp, "Contents/Resources/app.asar");
  await writeFile(packagedWrapperAsar, generatedWrapper.buffer);
  setElectronAsarIntegrityHash(
    infoPlist,
    generatedWrapper.report.patchedHeaderSha256,
  );
  if (
    (await sha256File(packagedWrapperAsar)) !==
      generatedWrapper.report.patchedSha256 ||
    electronAsarIntegrityHash(infoPlist) !==
      generatedWrapper.report.patchedHeaderSha256
  ) {
    throw new Error(
      "Packaged Electron wrapper integrity metadata is inconsistent",
    );
  }
  const packagedCliExecutable = join(stagedApp, "Contents/MacOS/obsidian-cli");
  await writeFile(packagedCliExecutable, generatedCli.buffer);
  const stagedCliSafety = inspectPatchedCliBinary(
    await readFile(packagedCliExecutable),
  );
  if (stagedCliSafety.sha256 !== generatedCli.report.patchedSha256) {
    throw new Error("Packaged CLI does not match the deterministic socket patch");
  }
  run([
    "plutil",
    "-replace",
    "CFBundleDisplayName",
    "-string",
    "Blackglass Bridge",
    infoPlist,
  ]);
  run([
    "plutil",
    "-replace",
    "CFBundleIdentifier",
    "-string",
    "com.blackglass.bridge",
    infoPlist,
  ]);
  const helperBundleIdentifiers = await validatePreservedElectronHelpers(
    stagedApp,
    sourceDisplayName,
    sourceBundleIdentifier,
  );
  run(["plutil", "-remove", "CFBundleURLTypes", infoPlist]);
  if (hasPlistKey(infoPlist, "NSUbiquitousContainers")) {
    run(["plutil", "-remove", "NSUbiquitousContainers", infoPlist]);
  }
  for (
    const key of [
      "NSAppleEventsUsageDescription",
      "NSCalendarsUsageDescription",
      "NSCameraUsageDescription",
      "NSContactsUsageDescription",
      "NSMicrophoneUsageDescription",
      "NSRemindersUsageDescription",
    ]
  ) {
    if (!hasPlistKey(infoPlist, key)) continue;
    const description = plistString(infoPlist, key);
    run([
      "plutil",
      "-replace",
      key,
      "-string",
      description.replaceAll("Obsidian", "Blackglass Bridge"),
      infoPlist,
    ]);
  }
  assertPlistString(infoPlist, "CFBundleDisplayName", "Blackglass Bridge");
  assertPlistString(infoPlist, "CFBundleName", sourceBundleName);
  assertPlistString(infoPlist, "CFBundleIdentifier", "com.blackglass.bridge");
  assertPlistString(infoPlist, "CFBundleExecutable", sourceExecutableName);
  if (hasPlistKey(infoPlist, "CFBundleURLTypes")) {
    throw new Error(
      "Packaged app must not claim the upstream obsidian:// URL scheme",
    );
  }
  run(["codesign", "--force", "--deep", "--sign", "-", stagedApp]);
  run(["codesign", "--verify", "--deep", "--strict", stagedApp]);

  const macOSArtifact = await inspectMacOSArtifact(stagedApp);
  const bridgeVersion = await readBridgeVersion();
  const releaseManifest: BridgeReleaseManifest = {
    schemaVersion: BRIDGE_RELEASE_MANIFEST_SCHEMA_VERSION,
    bridgeVersion,
    rendererVersion: sourceVersion,
    compatibilityBaseline: qualification.report.baseline,
    source: {
      officialDmgSha256,
      appTree: sourceAppTree,
      rendererAsarSha256: sourceAsarSha256,
      wrapperAsarSha256: generatedWrapper.report.upstreamSha256,
      cliExecutableSha256: generatedCli.report.upstreamSha256,
    },
    patcher: {
      renderer: {
        formatVersion: RENDERER_PATCH_FORMAT_VERSION,
        incisions: RENDERER_INCISION_COUNT,
      },
      wrapper: {
        formatVersion: WRAPPER_PATCH_FORMAT_VERSION,
        incisions: WRAPPER_INCISION_COUNT,
      },
      cli: {
        formatVersion: CLI_BINARY_PATCH_FORMAT_VERSION,
        incisions: CLI_BINARY_INCISION_COUNT,
      },
    },
    endpoints: {
      controlOrigin: reproducedRenderer.report.controlOrigin,
      dataHost: reproducedRenderer.report.dataHost,
    },
    toolingSource,
    renderer: reproducedRenderer.report,
    wrapper: generatedWrapper.report,
    cli: generatedCli.report,
    macOS: publicMacOSArtifact(macOSArtifact),
    reproduction: {
      officialDmgMatchedBaseline: true,
      sourceAppTreeMatchedBaseline: true,
      stagedCopyTreeMatchedSource: true,
      reviewedSourceRenderer: true,
      sourceWrapperMatchesBaseline: true,
      rendererByteIdentical: true,
      packagedRendererByteIdentical: true,
      packagedWrapperIntegrityVerified: true,
      packagedCliSocketVerified: true,
    },
  };
  assertBridgeReleaseManifest(releaseManifest);
  await writeFile(
    stagedManifest,
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  await publishAtomically(stagedApp, outputApp, stagedManifest, manifestPath);

  console.log(
    JSON.stringify(
      {
        version: sourceVersion,
        sourceApp,
        outputApp,
        sourceAsarSha256,
        patchedAsarSha256,
        wrapperUpstreamSha256: generatedWrapper.report.upstreamSha256,
        wrapperPatchedSha256: generatedWrapper.report.patchedSha256,
        wrapperUpstreamHeaderSha256:
          generatedWrapper.report.upstreamHeaderSha256,
        wrapperPatchedHeaderSha256: generatedWrapper.report.patchedHeaderSha256,
        profileDirectory: generatedWrapper.report.profileDirectory,
        profileMode: generatedWrapper.report.profileMode,
        profilePathCanonicalAtSetup:
          generatedWrapper.report.profilePathCanonicalAtSetup,
        explicitUserDataDirHonored:
          generatedWrapper.report.explicitUserDataDirHonored,
        profileHomeEnvironment:
          generatedWrapper.report.profileHomeEnvironment,
        dedicatedHomeValidated:
          generatedWrapper.report.dedicatedHomeValidated,
        nativeHomeFallbackPreserved:
          generatedWrapper.report.nativeHomeFallbackPreserved,
        upstreamUpdatesDisabled:
          generatedWrapper.report.upstreamUpdatesDisabled,
        embeddedRendererOnly: generatedWrapper.report.embeddedRendererOnly,
        cliSocketName: releaseManifest.macOS.cliSocketName,
        cliSocketOccurrences: releaseManifest.macOS.cliSocketOccurrences,
        sourceBundleIdentifier,
        bundleIdentifier: releaseManifest.macOS.bundleIdentifier,
        bundleName: releaseManifest.macOS.bundleName,
        displayName: releaseManifest.macOS.displayName,
        executableName: releaseManifest.macOS.executableName,
        helperBundleIdentifiers,
        registeredUrlSchemes: [],
        signature: "ad-hoc",
        manifestPath,
        releaseManifest,
      },
      null,
      2,
    ),
  );
});

function readVersion(archive: AsarArchive): string {
  const metadata = JSON.parse(
    archive.read("package.json").toString("utf8"),
  ) as {
    version?: string;
  };
  if (!isSupportedStableSemver(metadata.version)) {
    throw new Error("ASAR has no supported semantic package version");
  }
  return metadata.version;
}

function run(arguments_: string[]): void {
  const result = Bun.spawnSync(arguments_, {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${arguments_[0]} failed with exit code ${result.exitCode}`,
    );
  }
}

function runText(arguments_: string[]): string {
  const result = Bun.spawnSync(arguments_);
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

function plistString(infoPlist: string, key: string): string {
  return runText(["plutil", "-extract", key, "raw", "-o", "-", infoPlist]);
}

function hasPlistKey(infoPlist: string, key: string): boolean {
  return Bun.spawnSync(["plutil", "-type", key, infoPlist], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
}

function assertPlistString(
  infoPlist: string,
  key: string,
  expected: string,
): void {
  const actual = plistString(infoPlist, key);
  if (actual !== expected) {
    throw new Error(`Packaged plist ${key} is ${actual}, expected ${expected}`);
  }
}

function electronAsarIntegrityHash(infoPlist: string): string {
  return runText([
    "/usr/libexec/PlistBuddy",
    "-c",
    "Print :ElectronAsarIntegrity:Resources/app.asar:hash",
    infoPlist,
  ]);
}

function setElectronAsarIntegrityHash(infoPlist: string, hash: string): void {
  run([
    "/usr/libexec/PlistBuddy",
    "-c",
    `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`,
    infoPlist,
  ]);
}

async function sha256File(path: string): Promise<string> {
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

function generatedSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBridgeVersion(): Promise<string> {
  const metadata = JSON.parse(
    await readFile(join(import.meta.dir, "../package.json"), "utf8"),
  ) as { version?: unknown };
  if (
    !isSupportedSemver(metadata.version)
  ) {
    throw new Error("Bridge package has no semantic version");
  }
  return metadata.version;
}

async function publishAtomically(
  stagedApp: string,
  outputApp: string,
  stagedManifest: string,
  manifestPath: string,
): Promise<void> {
  await rename(stagedApp, outputApp);
  try {
    await rename(stagedManifest, manifestPath);
  } catch (error) {
    try {
      await rename(outputApp, stagedApp);
    } catch (rollbackError) {
      throw new Error(
        `Release manifest publication failed and app rollback also failed: ${
          String(error)
        }; ${String(rollbackError)}`,
      );
    }
    throw error;
  }
}

function treeIdentityEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function usage(): never {
  console.error(
    "Usage: bun run tools/package-macos.ts <official-Obsidian.app> " +
      "<patched.asar> <output.app> --control-origin <origin> " +
      "--data-host <host[:port]> --manifest <release-manifest.json> " +
      "--official-dmg <official-release.dmg> " +
      "[--baseline <reviewed-baseline.json>]",
  );
  process.exit(2);
}

async function validatePreservedElectronHelpers(
  outputApp: string,
  sourceDisplayName: string,
  sourceBundleIdentifier: string,
): Promise<string[]> {
  const frameworks = join(outputApp, "Contents/Frameworks");
  const helperBundleIdentifiers: string[] = [];
  for (const helper of ELECTRON_HELPER_VARIANTS) {
    const sourceHelperName = `${sourceDisplayName} Helper${helper.nameSuffix}`;
    const sourceHelperApp = join(frameworks, `${sourceHelperName}.app`);
    const helperInfoPlist = join(sourceHelperApp, "Contents/Info.plist");
    const sourceHelperIdentifier =
      `${sourceBundleIdentifier}.helper${helper.identifierSuffix}`;
    const helperExecutable = join(
      sourceHelperApp,
      "Contents/MacOS",
      sourceHelperName,
    );

    try {
      if (!(await lstat(sourceHelperApp)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new Error(
        `Missing expected Electron helper bundle: ${sourceHelperApp}`,
      );
    }
    assertPlistString(
      helperInfoPlist,
      "CFBundleIdentifier",
      sourceHelperIdentifier,
    );
    assertPlistString(helperInfoPlist, "CFBundleDisplayName", sourceHelperName);
    assertPlistString(helperInfoPlist, "CFBundleExecutable", sourceHelperName);
    try {
      if (!(await lstat(helperExecutable)).isFile()) {
        throw new Error("not a file");
      }
    } catch {
      throw new Error(
        `Missing expected Electron helper executable: ${helperExecutable}`,
      );
    }
    helperBundleIdentifiers.push(sourceHelperIdentifier);
  }
  return helperBundleIdentifiers;
}
