import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inspectPatchedMacOSWrapperAsar } from "../packages/client-adapter/src/wrapper";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import { inspectPatchedMainProcess } from "../packages/client-adapter/src/patch";
import { AsarArchive, asarHeaderSha256 } from "./asar";
import {
  BLACKGLASS_CLI_SOCKET_NAME,
  CLI_BINARY_INCISION_COUNT,
  inspectPatchedCliBinary,
} from "./cli-binary";
import {
  inspectPackagedMacOSCodeSigning,
  type MacOSCodeSigningEvidence,
} from "./macos-code-signing";
import {
  inspectMacOSCodeInventory,
  type MacOSCodeInventory,
} from "./macos-code-inventory";
import {
  inspectMacOSRootMetadata,
  type MacOSRootMetadata,
} from "./macos-root-metadata";
import { computeTreeIdentity, type TreeIdentity } from "./tree-identity";
import { isSupportedStableSemver } from "./semver";
import { MACOS_PACKAGING_EXECUTABLES } from "./packaging-toolchain";

export const ELECTRON_HELPER_VARIANTS = [
  { nameSuffix: "", identifierSuffix: "" },
  { nameSuffix: " (GPU)", identifierSuffix: ".GPU" },
  { nameSuffix: " (Plugin)", identifierSuffix: ".Plugin" },
  { nameSuffix: " (Renderer)", identifierSuffix: ".Renderer" },
] as const;

export interface MacOSArtifact {
  schemaVersion: 8;
  appPath: string;
  appBundleName: "Blackglass.app";
  bundleIdentifier: "com.blackglass.app";
  bundleName: "Obsidian";
  displayName: "Blackglass";
  version: string;
  executableName: "Obsidian";
  infoPlistSha256: string;
  executableSha256: string;
  cliExecutableName: "obsidian-cli";
  cliExecutableSha256: string;
  cliSocketName: typeof BLACKGLASS_CLI_SOCKET_NAME;
  cliSocketOccurrences: typeof CLI_BINARY_INCISION_COUNT;
  embeddedAsarSha256: string;
  rendererRuntimeHomeEnvironment: typeof BLACKGLASS_HOME_ENVIRONMENT;
  rendererCliRuntimeRootValidated: true;
  embeddedWrapperAsarSha256: string;
  embeddedWrapperHeaderSha256: string;
  codeDirectoryHash: string;
  applicationTreeSha256: string;
  applicationTreeIdentity: TreeIdentity;
  helperBundleIdentifiers: string[];
  codeSigning: MacOSCodeSigningEvidence;
  codeInventory: MacOSCodeInventory;
  rootMetadata: MacOSRootMetadata;
  profileDirectory: "Blackglass";
  profileMode: 448;
  profilePathCanonicalAtSetup: true;
  explicitUserDataDirHonored: true;
  profileHomeEnvironment: typeof BLACKGLASS_HOME_ENVIRONMENT;
  dedicatedHomeValidated: true;
  nativeHomeFallbackPreserved: true;
  upstreamUpdatesDisabled: true;
  embeddedRendererOnly: true;
  registeredUrlSchemes: [];
  upstreamICloudContainerRegistered: false;
}

export async function inspectMacOSArtifact(appArgument: string): Promise<MacOSArtifact> {
  const appPath = resolve(appArgument);
  if (
    basename(appPath) !== "Blackglass.app" ||
    !(await lstat(appPath)).isDirectory()
  ) {
    throw new Error(`macOS artifact is not an app bundle: ${appPath}`);
  }
  const infoPlist = join(appPath, "Contents/Info.plist");
  const bundleIdentifier = plistString(infoPlist, "CFBundleIdentifier");
  const bundleName = plistString(infoPlist, "CFBundleName");
  const displayName = plistString(infoPlist, "CFBundleDisplayName");
  if (
    bundleIdentifier !== "com.blackglass.app" ||
    bundleName !== "Obsidian" ||
    displayName !== "Blackglass"
  ) {
    throw new Error(
      `Unexpected Blackglass identity: ${bundleIdentifier}, ${bundleName}, ${displayName}`,
    );
  }
  if (hasPlistKey(infoPlist, "CFBundleURLTypes")) {
    throw new Error("Blackglass must not register an upstream URL scheme");
  }
  if (hasPlistKey(infoPlist, "NSUbiquitousContainers")) {
    throw new Error("Blackglass must not register an upstream iCloud container");
  }
  run([
    MACOS_PACKAGING_EXECUTABLES.codesign,
    "--verify",
    "--deep",
    "--strict",
    appPath,
  ]);
  const codeInventory = await inspectMacOSCodeInventory(
    appPath,
    "strict-all-architectures",
  );
  const codeSigning = inspectPackagedMacOSCodeSigning(appPath, codeInventory);
  const rootMetadata = await inspectMacOSRootMetadata(appPath);
  const signatureDetails = runText(
    [MACOS_PACKAGING_EXECUTABLES.codesign, "-d", "--verbose=4", appPath],
    true,
  );
  const codeDirectoryHash = /^CDHash=(\S+)$/m.exec(signatureDetails)?.[1];
  if (!codeDirectoryHash) throw new Error("Packaged app signature has no CDHash");

  const executableName = plistString(infoPlist, "CFBundleExecutable");
  if (executableName !== "Obsidian") {
    throw new Error(`Unexpected Blackglass runtime executable: ${executableName}`);
  }
  const version = plistString(infoPlist, "CFBundleShortVersionString");
  if (!isSupportedStableSemver(version)) {
    throw new Error(`Unexpected Blackglass renderer version: ${version}`);
  }
  const helperBundleIdentifiers: string[] = [];
  for (const helper of ELECTRON_HELPER_VARIANTS) {
    const helperName = `Obsidian Helper${helper.nameSuffix}`;
    const helperPlist = join(
      appPath,
      "Contents/Frameworks",
      `${helperName}.app/Contents/Info.plist`,
    );
    const helperIdentifier = `md.obsidian.helper${helper.identifierSuffix}`;
    if (plistString(helperPlist, "CFBundleIdentifier") !== helperIdentifier) {
      throw new Error(`Unexpected Blackglass helper identifier: ${helperName}`);
    }
    if (plistString(helperPlist, "CFBundleDisplayName") !== helperName) {
      throw new Error(`Unexpected Blackglass helper display name: ${helperName}`);
    }
    if (plistString(helperPlist, "CFBundleExecutable") !== helperName) {
      throw new Error(`Unexpected Blackglass helper executable: ${helperName}`);
    }
    helperBundleIdentifiers.push(helperIdentifier);
  }
  const wrapperAsar = join(appPath, "Contents/Resources/app.asar");
  const wrapperBytes = await readFile(wrapperAsar);
  const wrapperSafety = inspectPatchedMacOSWrapperAsar(wrapperBytes);
  const embeddedWrapperAsarSha256 = sha256(wrapperBytes);
  const embeddedWrapperHeaderSha256 = asarHeaderSha256(wrapperBytes);
  if (electronAsarIntegrityHash(infoPlist) !== embeddedWrapperHeaderSha256) {
    throw new Error("Embedded Electron wrapper does not match Info.plist integrity metadata");
  }
  const cliExecutableName = "obsidian-cli";
  const cliExecutable = join(appPath, "Contents/MacOS", cliExecutableName);
  const cliSafety = inspectPatchedCliBinary(await readFile(cliExecutable));
  const rendererAsar = await readFile(
    join(appPath, "Contents/Resources/obsidian.asar"),
  );
  const rendererMainSafety = inspectPatchedMainProcess(
    AsarArchive.fromBuffer(rendererAsar).read("main.js"),
  );
  const applicationTreeIdentity = await computeTreeIdentity(appPath);
  return {
    schemaVersion: 8,
    appPath,
    appBundleName: "Blackglass.app",
    bundleIdentifier: "com.blackglass.app",
    bundleName: "Obsidian",
    displayName: "Blackglass",
    version,
    executableName: "Obsidian",
    infoPlistSha256: await sha256File(infoPlist),
    executableSha256: await sha256File(join(appPath, "Contents/MacOS", executableName)),
    cliExecutableName,
    cliExecutableSha256: cliSafety.sha256,
    cliSocketName: cliSafety.socketName,
    cliSocketOccurrences: cliSafety.socketOccurrences,
    embeddedAsarSha256: sha256(rendererAsar),
    rendererRuntimeHomeEnvironment: rendererMainSafety.runtimeHomeEnvironment,
    rendererCliRuntimeRootValidated: rendererMainSafety.runtimeRootValidated,
    embeddedWrapperAsarSha256,
    embeddedWrapperHeaderSha256,
    codeDirectoryHash,
    applicationTreeSha256: applicationTreeIdentity.sha256,
    applicationTreeIdentity,
    helperBundleIdentifiers,
    codeSigning,
    codeInventory,
    rootMetadata,
    profileDirectory: wrapperSafety.profileDirectory,
    profileMode: wrapperSafety.profileMode,
    profilePathCanonicalAtSetup: wrapperSafety.profilePathCanonicalAtSetup,
    explicitUserDataDirHonored: wrapperSafety.explicitUserDataDirHonored,
    profileHomeEnvironment: wrapperSafety.profileHomeEnvironment,
    dedicatedHomeValidated: wrapperSafety.dedicatedHomeValidated,
    nativeHomeFallbackPreserved: wrapperSafety.nativeHomeFallbackPreserved,
    upstreamUpdatesDisabled: wrapperSafety.upstreamUpdatesDisabled,
    embeddedRendererOnly: wrapperSafety.embeddedRendererOnly,
    registeredUrlSchemes: [],
    upstreamICloudContainerRegistered: false,
  };
}

export function publicMacOSArtifact(
  artifact: MacOSArtifact,
): Omit<MacOSArtifact, "appPath"> {
  const { appPath: _appPath, ...published } = artifact;
  return published;
}

async function sha256File(path: string): Promise<string> {
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function plistString(infoPlist: string, key: string): string {
  return runText([
    MACOS_PACKAGING_EXECUTABLES.plutil,
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
}

function hasPlistKey(infoPlist: string, key: string): boolean {
  return Bun.spawnSync([MACOS_PACKAGING_EXECUTABLES.plutil, "-type", key, infoPlist], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
}

function electronAsarIntegrityHash(infoPlist: string): string {
  return runText([
    MACOS_PACKAGING_EXECUTABLES.PlistBuddy,
    "-c",
    "Print :ElectronAsarIntegrity:Resources/app.asar:hash",
    infoPlist,
  ]);
}

function run(arguments_: string[]): void {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
}

function runText(arguments_: string[], stderr = false): string {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
  return Buffer.from(stderr ? result.stderr : result.stdout).toString("utf8").trim();
}
