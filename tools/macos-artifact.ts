import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inspectMacOSCodeInventory, type MacOSCodeInventory } from "./macos-code-inventory";
import { inspectMacOSRootMetadata, type MacOSRootMetadata } from "./macos-root-metadata";
import {
  assertBridgeLaunchConfig,
  BRIDGE_APPLICATION_NAME,
  BRIDGE_BUNDLE_IDENTIFIER,
  BRIDGE_BUNDLE_NAME,
  BRIDGE_EXECUTABLE_NAME,
  BRIDGE_ICON_FILE,
  BRIDGE_PROFILE_DIRECTORY,
  type BridgeLaunchConfig,
} from "./launcher-config";
import { MACOS_PACKAGING_EXECUTABLES } from "./packaging-toolchain";
import { computeTreeIdentity, type TreeIdentity } from "./tree-identity";
import { BLACKGLASS_CLI_SOCKET_NAME, signedPatchedCliBinarySha256 } from "./cli-binary";

export interface MacOSLauncherSigningEvidence {
  signature: "ad-hoc";
  strictVerification: true;
  allArchitecturesVerified: true;
  bundleIdentifier: typeof BRIDGE_BUNDLE_IDENTIFIER;
  executableIdentifier: typeof BRIDGE_BUNDLE_IDENTIFIER;
  executableArchitectures: ["arm64"];
}

export interface MacOSArtifact {
  schemaVersion: 10;
  appPath: string;
  appBundleName: typeof BRIDGE_BUNDLE_NAME;
  bundleIdentifier: typeof BRIDGE_BUNDLE_IDENTIFIER;
  bundleName: typeof BRIDGE_APPLICATION_NAME;
  displayName: typeof BRIDGE_APPLICATION_NAME;
  blackglassVersion: string;
  rendererVersion: string;
  version: string;
  executableName: typeof BRIDGE_EXECUTABLE_NAME;
  infoPlistSha256: string;
  executableSha256: string;
  cliExecutableName: "blackglass-cli";
  cliExecutableSha256: string;
  cliSocketName: typeof BLACKGLASS_CLI_SOCKET_NAME;
  embeddedAsarSha256: string;
  launchConfigSha256: string;
  officialAppTreeSha256: string;
  officialCodeInventorySha256: string;
  officialExecutableName: "Obsidian";
  officialExecutableSha256: string;
  codeDirectoryHash: string;
  applicationTreeSha256: string;
  applicationTreeIdentity: TreeIdentity;
  codeSigning: MacOSLauncherSigningEvidence;
  codeInventory: MacOSCodeInventory;
  rootMetadata: MacOSRootMetadata;
  profileDirectory: typeof BRIDGE_PROFILE_DIRECTORY;
  profileMode: 448;
  canonicalProfileRequired: true;
  explicitUserDataDir: true;
  explicitUserDataDirRequired: true;
  nativeHomePreserved: true;
  nativeHomeFallbackPreserved: true;
  blackglassHomeEnvironment: "BLACKGLASS_HOME";
  profileHomeEnvironment: "BLACKGLASS_HOME";
  dedicatedRuntimeHomeRequired: true;
  updateDisableSettingRequired: true;
  exactOfficialAppVerifiedAtEveryLaunch: true;
  officialAppUnmodified: true;
  officialChildSupervisionRequired: true;
  registeredUrlSchemes: [];
  upstreamICloudContainerRegistered: false;
}

export async function inspectMacOSArtifact(appArgument: string): Promise<MacOSArtifact> {
  const appPath = resolve(appArgument);
  if (basename(appPath) !== BRIDGE_BUNDLE_NAME || !(await lstat(appPath)).isDirectory()) {
    throw new Error(`macOS launcher is not ${BRIDGE_BUNDLE_NAME}: ${appPath}`);
  }
  const infoPlist = join(appPath, "Contents/Info.plist");
  if (
    plistString(infoPlist, "CFBundleIdentifier") !== BRIDGE_BUNDLE_IDENTIFIER ||
    plistString(infoPlist, "CFBundleName") !== BRIDGE_APPLICATION_NAME ||
    plistString(infoPlist, "CFBundleDisplayName") !== BRIDGE_APPLICATION_NAME ||
    plistString(infoPlist, "CFBundleExecutable") !== BRIDGE_EXECUTABLE_NAME ||
    plistString(infoPlist, "CFBundleIconFile") !== BRIDGE_ICON_FILE
  ) {
    throw new Error("Unexpected Blackglass application identity");
  }
  if (hasPlistKey(infoPlist, "CFBundleURLTypes") || hasPlistKey(infoPlist, "NSUbiquitousContainers")) {
    throw new Error("Blackglass must not claim upstream URL or iCloud identities");
  }
  run([MACOS_PACKAGING_EXECUTABLES.codesign, "--verify", "--deep", "--strict", "--all-architectures", appPath]);
  const executable = join(appPath, "Contents/MacOS", BRIDGE_EXECUTABLE_NAME);
  const architectures = runText([MACOS_PACKAGING_EXECUTABLES.lipo, "-archs", executable]).split(/\s+/u);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error("Blackglass launcher must contain exactly one arm64 executable");
  }
  const executableSignature = signatureDetails(executable);
  const appSignature = signatureDetails(appPath);
  if (
    executableSignature.identifier !== BRIDGE_BUNDLE_IDENTIFIER ||
    appSignature.identifier !== BRIDGE_BUNDLE_IDENTIFIER ||
    !executableSignature.adHoc || !appSignature.adHoc
  ) {
    throw new Error(
      `Blackglass launcher has an unexpected code signature: executable=${executableSignature.identifier}/${executableSignature.adHoc}, app=${appSignature.identifier}/${appSignature.adHoc}`,
    );
  }
  const configBytes = await readFile(join(appPath, "Contents/Resources/bridge-launch.json"));
  const iconBytes = await readFile(join(appPath, "Contents/Resources", BRIDGE_ICON_FILE));
  if (iconBytes.length < 100_000 || iconBytes.subarray(0, 4).toString("ascii") !== "icns") {
    throw new Error("Blackglass has no valid application icon");
  }
  const config = JSON.parse(configBytes.toString("utf8")) as unknown;
  assertBridgeLaunchConfig(config);
  if (
    config.blackglassVersion !== plistString(infoPlist, "CFBundleShortVersionString") ||
    config.rendererVersion !== plistString(infoPlist, "BlackglassRendererVersion")
  ) {
    throw new Error("Blackglass plist and launch contract versions differ");
  }
  const adapterSha256 = await sha256File(join(appPath, "Contents/Resources", config.adapterFileName));
  if (adapterSha256 !== config.adapterSha256) throw new Error("Embedded adapter does not match launch contract");
  const generatedCliSha256 = await signedPatchedCliBinarySha256(
    await readFile(join(config.officialAppPath, "Contents/MacOS/obsidian-cli")),
  );
  const codeInventory = await inspectMacOSCodeInventory(appPath, "strict-all-architectures");
  const rootMetadata = await inspectMacOSRootMetadata(appPath);
  const applicationTreeIdentity = await computeTreeIdentity(appPath);
  return {
    schemaVersion: 10,
    appPath,
    appBundleName: BRIDGE_BUNDLE_NAME,
    bundleIdentifier: BRIDGE_BUNDLE_IDENTIFIER,
    bundleName: BRIDGE_APPLICATION_NAME,
    displayName: BRIDGE_APPLICATION_NAME,
    blackglassVersion: config.blackglassVersion,
    rendererVersion: config.rendererVersion,
    version: config.rendererVersion,
    executableName: BRIDGE_EXECUTABLE_NAME,
    infoPlistSha256: await sha256File(infoPlist),
    executableSha256: await sha256File(executable),
    cliExecutableName: "blackglass-cli",
    cliExecutableSha256: generatedCliSha256,
    cliSocketName: BLACKGLASS_CLI_SOCKET_NAME,
    embeddedAsarSha256: adapterSha256,
    launchConfigSha256: sha256(configBytes),
    officialAppTreeSha256: config.officialAppTree.sha256,
    officialCodeInventorySha256: config.officialCodeInventory.sha256,
    officialExecutableName: config.officialExecutableName,
    officialExecutableSha256: await sha256File(
      join(config.officialAppPath, "Contents/MacOS", config.officialExecutableName),
    ),
    codeDirectoryHash: appSignature.cdHash,
    applicationTreeSha256: applicationTreeIdentity.sha256,
    applicationTreeIdentity,
    codeSigning: {
      signature: "ad-hoc",
      strictVerification: true,
      allArchitecturesVerified: true,
      bundleIdentifier: BRIDGE_BUNDLE_IDENTIFIER,
      executableIdentifier: BRIDGE_BUNDLE_IDENTIFIER,
      executableArchitectures: ["arm64"],
    },
    codeInventory,
    rootMetadata,
    profileDirectory: config.profileDirectory,
    profileMode: config.profileMode,
    canonicalProfileRequired: true,
    explicitUserDataDir: true,
    explicitUserDataDirRequired: true,
    nativeHomePreserved: true,
    nativeHomeFallbackPreserved: true,
    blackglassHomeEnvironment: "BLACKGLASS_HOME",
    profileHomeEnvironment: "BLACKGLASS_HOME",
    dedicatedRuntimeHomeRequired: true,
    updateDisableSettingRequired: config.updateDisabled,
    exactOfficialAppVerifiedAtEveryLaunch: true,
    officialAppUnmodified: true,
    officialChildSupervisionRequired: true,
    registeredUrlSchemes: [],
    upstreamICloudContainerRegistered: false,
  };
}

export function publicMacOSArtifact(artifact: MacOSArtifact): Omit<MacOSArtifact, "appPath"> {
  const { appPath: _path, ...result } = artifact;
  return result;
}

function signatureDetails(path: string): { identifier: string; cdHash: string; adHoc: boolean } {
  const details = runText([MACOS_PACKAGING_EXECUTABLES.codesign, "-d", "--verbose=4", path], true);
  const identifier = /^Identifier=(.+)$/mu.exec(details)?.[1];
  const cdHash = /^CDHash=([a-f0-9]+)$/mu.exec(details)?.[1];
  if (!identifier || !cdHash) throw new Error("Incomplete launcher code-signing identity");
  return { identifier, cdHash, adHoc: /^Signature=adhoc$/mu.test(details) };
}

function plistString(path: string, key: string): string {
  return runText([MACOS_PACKAGING_EXECUTABLES.plutil, "-extract", key, "raw", "-o", "-", path]);
}
function hasPlistKey(path: string, key: string): boolean {
  return Bun.spawnSync([MACOS_PACKAGING_EXECUTABLES.plutil, "-type", key, path], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}
function run(args: string[]): void {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
}
function runText(args: string[], stderr = false): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8").trim());
  return (stderr ? result.stderr : result.stdout).toString("utf8").trim();
}
async function sha256File(path: string): Promise<string> { return sha256(await readFile(path)); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
