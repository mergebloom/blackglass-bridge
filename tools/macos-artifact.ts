import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface MacOSArtifact {
  schemaVersion: 1;
  appPath: string;
  bundleIdentifier: "com.blackglass.bridge";
  bundleName: "Blackglass Bridge";
  displayName: "Blackglass Bridge";
  version: string;
  executableName: string;
  infoPlistSha256: string;
  executableSha256: string;
  embeddedAsarSha256: string;
  codeDirectoryHash: string;
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
    bundleName !== "Blackglass Bridge" ||
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
  return {
    schemaVersion: 1,
    appPath,
    bundleIdentifier: "com.blackglass.bridge",
    bundleName: "Blackglass Bridge",
    displayName: "Blackglass Bridge",
    version: plistString(infoPlist, "CFBundleShortVersionString"),
    executableName,
    infoPlistSha256: await sha256File(infoPlist),
    executableSha256: await sha256File(join(appPath, "Contents/MacOS", executableName)),
    embeddedAsarSha256: await sha256File(
      join(appPath, "Contents/Resources/obsidian.asar"),
    ),
    codeDirectoryHash,
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

function plistString(infoPlist: string, key: string): string {
  return runText(["plutil", "-extract", key, "raw", "-o", "-", infoPlist]);
}

function hasPlistKey(infoPlist: string, key: string): boolean {
  return Bun.spawnSync(["plutil", "-type", key, infoPlist], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
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
