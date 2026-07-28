import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectPatchedMacOSWrapperAsar } from "../packages/client-adapter/src/wrapper";
import { asarHeaderSha256 } from "./asar";
import { computeTreeIdentity, type TreeIdentity } from "./tree-identity";

export const ELECTRON_HELPER_VARIANTS = [
  { nameSuffix: "", identifierSuffix: "" },
  { nameSuffix: " (GPU)", identifierSuffix: ".GPU" },
  { nameSuffix: " (Plugin)", identifierSuffix: ".Plugin" },
  { nameSuffix: " (Renderer)", identifierSuffix: ".Renderer" },
] as const;

export interface MacOSArtifact {
  schemaVersion: 2;
  appPath: string;
  bundleIdentifier: "com.blackglass.bridge";
  bundleName: "Obsidian";
  displayName: "Blackglass Bridge";
  version: string;
  executableName: "Obsidian";
  infoPlistSha256: string;
  executableSha256: string;
  embeddedAsarSha256: string;
  embeddedWrapperAsarSha256: string;
  embeddedWrapperHeaderSha256: string;
  codeDirectoryHash: string;
  applicationTreeSha256: string;
  applicationTreeIdentity: TreeIdentity;
  helperBundleIdentifiers: string[];
  profileDirectory: "Blackglass Bridge";
  explicitUserDataDirHonored: true;
  upstreamUpdatesDisabled: true;
  embeddedRendererOnly: true;
  registeredUrlSchemes: [];
  upstreamICloudContainerRegistered: false;
}

export async function inspectMacOSArtifact(appArgument: string): Promise<MacOSArtifact> {
  const appPath = resolve(appArgument);
  if (!appPath.endsWith(".app") || !(await lstat(appPath)).isDirectory()) {
    throw new Error(`macOS artifact is not an app bundle: ${appPath}`);
  }
  const infoPlist = join(appPath, "Contents/Info.plist");
  const bundleIdentifier = plistString(infoPlist, "CFBundleIdentifier");
  const bundleName = plistString(infoPlist, "CFBundleName");
  const displayName = plistString(infoPlist, "CFBundleDisplayName");
  if (
    bundleIdentifier !== "com.blackglass.bridge" ||
    bundleName !== "Obsidian" ||
    displayName !== "Blackglass Bridge"
  ) {
    throw new Error(
      `Unexpected Bridge identity: ${bundleIdentifier}, ${bundleName}, ${displayName}`,
    );
  }
  if (hasPlistKey(infoPlist, "CFBundleURLTypes")) {
    throw new Error("Blackglass Bridge must not register an upstream URL scheme");
  }
  if (hasPlistKey(infoPlist, "NSUbiquitousContainers")) {
    throw new Error("Blackglass Bridge must not register an upstream iCloud container");
  }
  run(["codesign", "--verify", "--deep", "--strict", appPath]);
  const signatureDetails = runText(["codesign", "-d", "--verbose=4", appPath], true);
  const codeDirectoryHash = /^CDHash=(\S+)$/m.exec(signatureDetails)?.[1];
  if (!codeDirectoryHash) throw new Error("Packaged app signature has no CDHash");

  const executableName = plistString(infoPlist, "CFBundleExecutable");
  if (executableName !== "Obsidian") {
    throw new Error(`Unexpected Bridge runtime executable: ${executableName}`);
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
      throw new Error(`Unexpected Bridge helper identifier: ${helperName}`);
    }
    if (plistString(helperPlist, "CFBundleDisplayName") !== helperName) {
      throw new Error(`Unexpected Bridge helper display name: ${helperName}`);
    }
    if (plistString(helperPlist, "CFBundleExecutable") !== helperName) {
      throw new Error(`Unexpected Bridge helper executable: ${helperName}`);
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
  const applicationTreeIdentity = await computeTreeIdentity(appPath);
  return {
    schemaVersion: 2,
    appPath,
    bundleIdentifier: "com.blackglass.bridge",
    bundleName: "Obsidian",
    displayName: "Blackglass Bridge",
    version: plistString(infoPlist, "CFBundleShortVersionString"),
    executableName: "Obsidian",
    infoPlistSha256: await sha256File(infoPlist),
    executableSha256: await sha256File(join(appPath, "Contents/MacOS", executableName)),
    embeddedAsarSha256: await sha256File(
      join(appPath, "Contents/Resources/obsidian.asar"),
    ),
    embeddedWrapperAsarSha256,
    embeddedWrapperHeaderSha256,
    codeDirectoryHash,
    applicationTreeSha256: applicationTreeIdentity.sha256,
    applicationTreeIdentity,
    helperBundleIdentifiers,
    profileDirectory: wrapperSafety.profileDirectory,
    explicitUserDataDirHonored: wrapperSafety.explicitUserDataDirHonored,
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
  return runText(["plutil", "-extract", key, "raw", "-o", "-", infoPlist]);
}

function hasPlistKey(infoPlist: string, key: string): boolean {
  return Bun.spawnSync(["plutil", "-type", key, infoPlist], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
}

function electronAsarIntegrityHash(infoPlist: string): string {
  return runText([
    "/usr/libexec/PlistBuddy",
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
