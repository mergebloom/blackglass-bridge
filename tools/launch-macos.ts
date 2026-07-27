import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { AsarArchive } from "./asar";

const [asarArgument, profileArgument, vaultArgument, ...flags] = Bun.argv.slice(2);
if (!asarArgument || !profileArgument || !vaultArgument) {
  usage();
}
if (process.platform !== "darwin") {
  throw new Error("The first client launcher supports macOS only");
}

const asar = resolve(asarArgument);
const profile = resolve(profileArgument);
const vault = resolve(vaultArgument);
const realProfile = resolve(homedir(), "Library/Application Support/obsidian");
if (profile === realProfile || profile.startsWith(`${realProfile}/`)) {
  throw new Error("Refusing to use Obsidian's normal profile; choose a dedicated profile directory");
}

const archive = await AsarArchive.open(asar);
const packageMetadata = JSON.parse(archive.read("package.json").toString("utf8")) as {
  version?: string;
};
if (!packageMetadata.version) {
  throw new Error("Compatibility ASAR has no package version");
}

await mkdir(profile, { recursive: true });
await mkdir(vault, { recursive: true });
const targetAsar = join(profile, `obsidian-${packageMetadata.version}.asar`);
if (await Bun.file(targetAsar).exists()) {
  const same = (await fileSha256(targetAsar)) === (await fileSha256(asar));
  if (!same && !flags.includes("--replace-adapter")) {
    throw new Error(
      `A different adapter already exists at ${targetAsar}; pass --replace-adapter to replace it`,
    );
  }
  if (!same) {
    const temporary = `${targetAsar}.next`;
    await copyFile(asar, temporary);
    await rename(temporary, targetAsar);
  }
} else {
  await copyFile(asar, targetAsar);
}

const vaultId = createHash("sha256").update(vault).digest("hex").slice(0, 16);
const profileConfigPath = join(profile, "obsidian.json");
let profileConfig: Record<string, any> = {};
if (await Bun.file(profileConfigPath).exists()) {
  profileConfig = JSON.parse(await readFile(profileConfigPath, "utf8"));
}
profileConfig.updateDisabled = true;
profileConfig.vaults = {
  ...(profileConfig.vaults ?? {}),
  [vaultId]: { path: vault, ts: Date.now(), open: true },
};
await writeJsonAtomic(profileConfigPath, profileConfig);
const vaultState = join(profile, `${vaultId}.json`);
if (!(await Bun.file(vaultState).exists())) {
  await writeJsonAtomic(vaultState, {});
}

const debugPort = readFlag(flags, "--debug-port");
const appBundle = resolve(
  readFlag(flags, "--app") ?? "/Applications/Blackglass Bridge.app",
);
const infoPlist = join(appBundle, "Contents/Info.plist");
const bundleIdentifier = plistString(infoPlist, "CFBundleIdentifier");
if (
  bundleIdentifier !== "com.blackglass.bridge" &&
  !flags.includes("--allow-upstream-wrapper")
) {
  throw new Error(
    `Refusing non-Blackglass app ${bundleIdentifier}; pass --allow-upstream-wrapper only for isolated compatibility testing`,
  );
}
const executableName = plistString(infoPlist, "CFBundleExecutable");
const executable = join(appBundle, "Contents/MacOS", executableName);
if (!(await Bun.file(executable).exists())) {
  throw new Error(`Obsidian executable not found: ${executable}`);
}
const arguments_ = [executable, `--user-data-dir=${profile}`];
if (debugPort) {
  if (!/^\d+$/.test(debugPort)) {
    throw new Error("--debug-port must be numeric");
  }
  arguments_.push(`--remote-debugging-port=${debugPort}`);
}
console.log(
  JSON.stringify({
    version: packageMetadata.version,
    profile,
    vault,
    adapter: targetAsar,
    appBundle,
    bundleIdentifier,
  }, null, 2),
);
if (flags.includes("--prepare-only")) {
  process.exit(0);
}
const child = Bun.spawn(arguments_, { cwd: vault, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;

async function fileSha256(path: string): Promise<string> {
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function readFlag(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

function plistString(infoPlist: string, key: string): string {
  const result = Bun.spawnSync([
    "plutil",
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlist,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

function usage(): never {
  console.error(
    "Usage: bun run tools/launch-macos.ts <patched.asar> <dedicated-profile> <vault> " +
      "[--app <Obsidian.app>] [--replace-adapter] [--prepare-only] " +
      "[--debug-port <port>] [--allow-upstream-wrapper]",
  );
  process.exit(2);
}
