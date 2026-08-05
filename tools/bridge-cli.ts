import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import baseline1127 from "../compatibility/obsidian-1.12.7.json" with { type: "text" };
import baseline1134 from "../compatibility/obsidian-1.13.4.json" with { type: "text" };
import { AsarArchive } from "./asar";
import { parseStrictFlags } from "./cli-flags";
import { canonicalExistingPath, canonicalOutputPath } from "./path-safety";
import { computeToolingSourceIdentity } from "./tooling-source";
import { computeTreeIdentity } from "./tree-identity";
import { launchPackagedBridge } from "./launcher-runtime";
import { BRIDGE_BUNDLE_NAME, packagedLauncherArguments } from "./launcher-config";
import {
  STANDALONE_BRIDGE_BUILD_INFO_SCHEMA_VERSION,
  type StandaloneBridgeBuildInfo,
} from "./standalone-bridge";

declare const __BLACKGLASS_BRIDGE_VERSION__: string;
declare const __BLACKGLASS_BRIDGE_REVISION__: string;
declare const __BLACKGLASS_TOOLING_SOURCE_JSON__: string;

const compiled = typeof __BLACKGLASS_BRIDGE_VERSION__ !== "undefined";
const rawArguments = Bun.argv.slice(2);
const [command, ...commandArguments] = rawArguments;

if (isPackagedLauncherInvocation()) {
  const launcher = packagedLauncherArguments(rawArguments);
  process.exitCode = await launchPackagedBridge({
    bundlePath: launcherBundlePath(),
    ...(launcher.profilePath ? { profilePath: launcher.profilePath } : {}),
    ...(launcher.vaultPath ? { vaultPath: launcher.vaultPath } : {}),
    ...(launcher.blackglassHomePath ? { blackglassHomePath: launcher.blackglassHomePath } : {}),
    ...(launcher.receiptPath ? { receiptPath: launcher.receiptPath } : {}),
    runtimeArguments: launcher.runtimeArguments,
  });
} else if (command === "__patch" || command === "__package") {
  Bun.argv.splice(0, Bun.argv.length, process.execPath, "blackglass-bridge", ...commandArguments);
  if (command === "__patch") await import("./patch-client");
  else await import("./package-macos");
} else if (command === "adapt") {
  await adapt(commandArguments);
} else if (command === "--version" || command === "version") {
  console.log(`blackglass-bridge ${await blackglassVersion()} (${sourceRevision()})`);
} else if (command === "build-info") {
  if (!compiled) throw new Error("build-info is available only in a standalone Bridge executable");
  const info: StandaloneBridgeBuildInfo = {
    schemaVersion: STANDALONE_BRIDGE_BUILD_INFO_SCHEMA_VERSION,
    name: "blackglass-bridge",
    version: await blackglassVersion(),
    sourceRevision: sourceRevision(),
    target: { operatingSystem: "macOS", architecture: "arm64" },
    toolingSource: await toolingSourceIdentity() as StandaloneBridgeBuildInfo["toolingSource"],
  };
  console.log(JSON.stringify(info));
} else {
  usage();
}

async function adapt(arguments_: string[]): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Blackglass Bridge currently supports Apple Silicon macOS only");
  }
  const flags = parseStrictFlags(arguments_, {
    valueFlags: ["--dmg", "--app", "--control-origin", "--data-host", "--output"],
  });
  const dmgArgument = flags.values.get("--dmg");
  const appArgument = flags.values.get("--app");
  const controlOrigin = flags.values.get("--control-origin");
  const dataHost = flags.values.get("--data-host");
  const outputArgument = flags.values.get("--output");
  if ((!dmgArgument && !appArgument) || (dmgArgument && appArgument) ||
    !controlOrigin || !dataHost || !outputArgument) usage();

  const output = await prepareOutputDirectory(outputArgument);
  if (!compiled) {
    throw new Error("The adapt command requires the official standalone Blackglass Bridge executable");
  }
  const outputApp = await canonicalOutputPath(join(output, BRIDGE_BUNDLE_NAME), "Blackglass app");
  const manifest = await canonicalOutputPath(join(output, "blackglass-release.json"), "release manifest");
  const receipt = await canonicalOutputPath(
    join(output, "blackglass-package-receipt.json"),
    "package receipt",
  );
  const temporary = await mkdtemp(join(tmpdir(), "blackglass-bridge-"));
  let mountPoint: string | undefined;
  let mounted = false;
  let primaryError: Error | undefined;
  try {
    const sourceIdentity = await toolingSourceIdentity();
    const identityPath = join(temporary, "tooling-source.json");
    await writeFile(identityPath, `${JSON.stringify(sourceIdentity, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    let officialDmg: string | undefined;
    let sourceApp: string;
    let baselineText: string;
    if (dmgArgument) {
      officialDmg = await canonicalExistingPath(dmgArgument, "Official Obsidian DMG", "file");
      baselineText = baselineForDmgSha256(await sha256File(officialDmg));
      mountPoint = join(temporary, "mount");
      await mkdir(mountPoint, { mode: 0o700 });
      run(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, officialDmg]);
      mounted = true;
      sourceApp = await singleOfficialApp(mountPoint);
    } else {
      sourceApp = await canonicalExistingPath(appArgument!, "Official Obsidian app", "directory");
      baselineText = await baselineForApp(sourceApp);
    }
    const baselinePath = join(temporary, "compatibility-baseline.json");
    await writeFile(baselinePath, baselineText, { flag: "wx", mode: 0o600 });
    const sourceTree = await computeTreeIdentity(sourceApp);
    const runtimeApp = await installPrivateRuntime(sourceApp, sourceTree.sha256, temporary);
    const patchedAsar = join(temporary, "blackglass.asar");
    await runSelf([
      "__patch",
      join(runtimeApp, "Contents/Resources/obsidian.asar"),
      patchedAsar,
      "--control-origin", controlOrigin,
      "--data-host", dataHost,
      "--resources", join(runtimeApp, "Contents/Resources"),
      "--baseline", baselinePath,
    ]);
    const packageArguments = [
      "__package", runtimeApp, patchedAsar, outputApp,
      "--control-origin", controlOrigin,
      "--data-host", dataHost,
      "--manifest", manifest,
      "--receipt", receipt,
      "--baseline", baselinePath,
      "--tooling-source", identityPath,
      "--blackglass-version", await blackglassVersion(),
    ];
    if (officialDmg) packageArguments.push("--official-dmg", officialDmg);
    if (compiled) packageArguments.push("--standalone-executable", process.execPath);
    await runSelf(packageArguments);
    console.log(JSON.stringify({
      passed: true,
      sourceInput: officialDmg ? "official-dmg" : "reviewed-application",
      outputApp,
      manifest,
      receipt,
      privateOfficialRuntime: runtimeApp,
    }, null, 2));
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    const cleanupErrors: Error[] = [];
    if (mountPoint && mounted) {
      try { run(["/usr/bin/hdiutil", "detach", mountPoint]); }
      catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    try { await rm(temporary, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [...(primaryError ? [primaryError] : []), ...cleanupErrors],
        "Bridge adaptation cleanup failed",
      );
    }
  }
}

async function installPrivateRuntime(sourceApp: string, treeSha256: string, temporary: string): Promise<string> {
  const runtimeRoot = join(
    homedir(),
    "Library/Application Support/Blackglass Runtimes/Official",
    treeSha256,
  );
  const protectedRoot = join(homedir(), "Library/Application Support/Blackglass Runtimes");
  await mkdir(protectedRoot, { recursive: true, mode: 0o700 });
  await assertOwnerOnlyDirectory(protectedRoot, "Private runtime root");
  await mkdir(dirname(runtimeRoot), { recursive: true, mode: 0o700 });
  await assertOwnerOnlyDirectory(dirname(runtimeRoot), "Private runtime namespace");
  const runtimeApp = join(runtimeRoot, "Obsidian.app");
  if (await Bun.file(join(runtimeApp, "Contents/Info.plist")).exists()) {
    const existing = await computeTreeIdentity(runtimeApp);
    if (existing.sha256 !== treeSha256) {
      throw new Error("Existing private official runtime does not match the reviewed source; remove it manually after inspection");
    }
    return canonicalExistingPath(runtimeApp, "Private official runtime", "directory");
  }
  const stagingRoot = join(temporary, "private-runtime");
  const stagingApp = join(stagingRoot, "Obsidian.app");
  await mkdir(stagingRoot, { mode: 0o700 });
  run(["/usr/bin/ditto", "--norsrc", "--noextattr", "--noqtn", "--noacl", "--nopersistRootless", sourceApp, stagingApp]);
  const copied = await computeTreeIdentity(stagingApp);
  if (copied.sha256 !== treeSha256) throw new Error("Private official runtime copy differs from its reviewed source");
  await rename(stagingRoot, runtimeRoot);
  return canonicalExistingPath(runtimeApp, "Private official runtime", "directory");
}

async function assertOwnerOnlyDirectory(path: string, label: string): Promise<void> {
  const metadata = await Bun.file(path).stat();
  if (!metadata.isDirectory() || metadata.uid !== process.getuid!() ||
    (metadata.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must be an owner-only directory`);
  }
  if (await canonicalExistingPath(path, label, "directory") !== path) {
    throw new Error(`${label} must not contain symbolic-link path segments`);
  }
}

function isPackagedLauncherInvocation(): boolean {
  return process.execPath.includes(`/${BRIDGE_BUNDLE_NAME}/Contents/MacOS/`);
}

function launcherBundlePath(): string {
  return resolve(dirname(process.execPath), "../..");
}

async function prepareOutputDirectory(argument: string): Promise<string> {
  const requested = resolve(argument);
  const output = await canonicalOutputPath(requested, "output directory");
  await mkdir(output, { mode: 0o700 });
  return canonicalExistingPath(output, "output directory", "directory");
}

async function singleOfficialApp(mountPoint: string): Promise<string> {
  const apps = (await readdir(mountPoint)).filter((entry) => entry.endsWith(".app"));
  if (apps.length !== 1 || apps[0] !== "Obsidian.app") {
    throw new Error(`Expected exactly one Obsidian.app in the official DMG, found ${apps.join(", ")}`);
  }
  return canonicalExistingPath(join(mountPoint, apps[0]), "Mounted official Obsidian app", "directory");
}

function baselineForDmgSha256(sha256: string): string {
  const matches = baselineTexts().filter((text) => JSON.parse(text).officialDmgSha256 === sha256);
  if (matches.length !== 1) throw new Error("Official DMG is not a reviewed supported release");
  return matches[0]!;
}

async function baselineForApp(app: string): Promise<string> {
  if (basename(app) !== "Obsidian.app") throw new Error("Official app must be named Obsidian.app");
  const archive = AsarArchive.fromBuffer(await readFile(join(app, "Contents/Resources/obsidian.asar")));
  const metadata = JSON.parse(archive.read("package.json").toString("utf8")) as { version?: unknown };
  const matches = baselineTexts().filter((text) => JSON.parse(text).rendererVersion === metadata.version);
  if (matches.length !== 1) throw new Error("Official application renderer is not a reviewed supported release");
  return matches[0]!;
}

function baselineTexts(): string[] {
  return [baseline1127 as unknown as string, baseline1134 as unknown as string];
}

async function toolingSourceIdentity(): Promise<unknown> {
  if (compiled) return JSON.parse(__BLACKGLASS_TOOLING_SOURCE_JSON__);
  return computeToolingSourceIdentity();
}

async function blackglassVersion(): Promise<string> {
  if (compiled) return __BLACKGLASS_BRIDGE_VERSION__;
  const metadata = JSON.parse(await readFile(resolve(import.meta.dir, "../package.json"), "utf8"));
  return String(metadata.version);
}

function sourceRevision(): string {
  return compiled ? __BLACKGLASS_BRIDGE_REVISION__ : "development";
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runSelf(arguments_: string[]): Promise<void> {
  const command = compiled
    ? [process.execPath, ...arguments_]
    : [process.execPath, import.meta.path, ...arguments_];
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exit = await child.exited;
  if (exit !== 0) throw new Error(`Bridge subprocess failed with exit code ${exit}`);
}

function run(arguments_: string[]): void {
  const result = Bun.spawnSync(arguments_, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${arguments_[0]} failed with exit code ${result.exitCode}`);
}

function usage(): never {
  console.error(
    "Usage: blackglass-bridge adapt (--dmg <official.dmg> | --app <official Obsidian.app>) " +
      "--control-origin <https-origin> --data-host <host[:port]> --output <new-directory>\n" +
      "       blackglass-bridge --version\n" +
      "       blackglass-bridge build-info",
  );
  process.exit(2);
}
