import { createHash } from "node:crypto";
import { copyFile, lstat, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AsarArchive } from "./asar";

const [sourceArgument, asarArgument, outputArgument] = Bun.argv.slice(2);
if (!sourceArgument || !asarArgument || !outputArgument) {
  console.error(
    "Usage: bun run tools/package-macos.ts <official-Obsidian.app> " +
      "<patched.asar> <output.app>",
  );
  process.exit(2);
}

const sourceApp = resolve(sourceArgument);
const patchedAsar = resolve(asarArgument);
const outputApp = resolve(outputArgument);
if (!sourceApp.endsWith(".app") || !outputApp.endsWith(".app")) {
  throw new Error("Source and output must be .app bundles");
}
try {
  await lstat(outputApp);
  throw new Error(`Output already exists: ${outputApp}`);
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

const sourceAsar = join(sourceApp, "Contents/Resources/obsidian.asar");
const sourceInfoPlist = join(sourceApp, "Contents/Info.plist");
const sourceArchive = await AsarArchive.open(sourceAsar);
const patchedArchive = await AsarArchive.open(patchedAsar);
const sourceVersion = readVersion(sourceArchive);
const patchedVersion = readVersion(patchedArchive);
patchedArchive.read("app.js");
const sourceAsarSha256 = await sha256File(sourceAsar);
const patchedAsarSha256 = await sha256File(patchedAsar);
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

run(["ditto", sourceApp, outputApp]);
const packagedAsar = join(outputApp, "Contents/Resources/obsidian.asar");
await copyFile(patchedAsar, packagedAsar);
if ((await sha256File(packagedAsar)) !== patchedAsarSha256) {
  throw new Error("Packaged renderer hash does not match the adapter input");
}
const infoPlist = join(outputApp, "Contents/Info.plist");
const sourceBundleIdentifier = plistString(sourceInfoPlist, "CFBundleIdentifier");
const sourceExecutableName = plistString(sourceInfoPlist, "CFBundleExecutable");
const sourceUrlScheme = plistString(
  sourceInfoPlist,
  "CFBundleURLTypes.0.CFBundleURLSchemes.0",
);
if (sourceUrlScheme !== "obsidian") {
  throw new Error(
    `Expected the upstream wrapper to register obsidian://, found ${sourceUrlScheme}`,
  );
}
run(["plutil", "-replace", "CFBundleDisplayName", "-string", "Blackglass Bridge", infoPlist]);
run(["plutil", "-replace", "CFBundleName", "-string", "Blackglass Bridge", infoPlist]);
run(["plutil", "-replace", "CFBundleIdentifier", "-string", "com.blackglass.bridge", infoPlist]);
await rename(
  join(outputApp, "Contents/MacOS", sourceExecutableName),
  join(outputApp, "Contents/MacOS/Blackglass Bridge"),
);
run([
  "plutil",
  "-replace",
  "CFBundleExecutable",
  "-string",
  "Blackglass Bridge",
  infoPlist,
]);
run(["plutil", "-remove", "CFBundleURLTypes", infoPlist]);
if (hasPlistKey(infoPlist, "NSUbiquitousContainers")) {
  run(["plutil", "-remove", "NSUbiquitousContainers", infoPlist]);
}
for (const key of [
  "NSAppleEventsUsageDescription",
  "NSCalendarsUsageDescription",
  "NSCameraUsageDescription",
  "NSContactsUsageDescription",
  "NSRemindersUsageDescription",
]) {
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
assertPlistString(infoPlist, "CFBundleName", "Blackglass Bridge");
assertPlistString(infoPlist, "CFBundleIdentifier", "com.blackglass.bridge");
assertPlistString(infoPlist, "CFBundleExecutable", "Blackglass Bridge");
if (hasPlistKey(infoPlist, "CFBundleURLTypes")) {
  throw new Error("Packaged app must not claim the upstream obsidian:// URL scheme");
}
run(["codesign", "--force", "--deep", "--sign", "-", outputApp]);
run(["codesign", "--verify", "--deep", "--strict", outputApp]);

console.log(
  JSON.stringify(
    {
      version: sourceVersion,
      sourceApp,
      outputApp,
      sourceAsarSha256,
      patchedAsarSha256,
      sourceBundleIdentifier,
      bundleIdentifier: plistString(infoPlist, "CFBundleIdentifier"),
      bundleName: plistString(infoPlist, "CFBundleName"),
      displayName: plistString(infoPlist, "CFBundleDisplayName"),
      executableName: plistString(infoPlist, "CFBundleExecutable"),
      registeredUrlSchemes: [],
      signature: "ad-hoc",
    },
    null,
    2,
  ),
);

function readVersion(archive: AsarArchive): string {
  const metadata = JSON.parse(archive.read("package.json").toString("utf8")) as {
    version?: string;
  };
  if (!metadata.version) {
    throw new Error("ASAR has no package version");
  }
  return metadata.version;
}

function run(arguments_: string[]): void {
  const result = Bun.spawnSync(arguments_, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${arguments_[0]} failed with exit code ${result.exitCode}`);
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

function assertPlistString(infoPlist: string, key: string, expected: string): void {
  const actual = plistString(infoPlist, key);
  if (actual !== expected) {
    throw new Error(`Packaged plist ${key} is ${actual}, expected ${expected}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}
