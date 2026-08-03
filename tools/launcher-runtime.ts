import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import { AsarArchive } from "./asar";
import {
  assertBridgeLaunchConfig,
  type BridgeLaunchConfig,
  BRIDGE_BUNDLE_NAME,
  BRIDGE_PROFILE_DIRECTORY,
} from "./launcher-config";
import { inspectMacOSCodeInventory, macOSCodeInventoriesEqual } from "./macos-code-inventory";
import { assertNonOverlappingPaths, canonicalExistingPath, canonicalOutputPath, pathExists } from "./path-safety";
import { computeTreeIdentity } from "./tree-identity";
import { stableJson } from "./stable-json";
import { writeSignedPatchedCliBinary } from "./cli-binary";
import { BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT } from "../packages/client-adapter/src/patch";

export const BRIDGE_RUNTIME_RECEIPT_SCHEMA_VERSION = 1;

export interface BridgeRuntimeReceipt {
  schemaVersion: typeof BRIDGE_RUNTIME_RECEIPT_SCHEMA_VERSION;
  startedAt: string;
  launcherPid: number;
  officialPid: number;
  officialChildOfLauncher: true;
  bundlePath: string;
  officialAppPath: string;
  officialAppTreeSha256: string;
  adapterSha256: string;
  profilePath: string;
  blackglassHomePath: string;
  explicitUserDataDir: true;
  exclusiveOfficialInstance: true;
}

export interface BridgeRuntimeOptions {
  bundlePath: string;
  profilePath?: string;
  vaultPath?: string;
  blackglassHomePath?: string;
  runtimeArguments?: string[];
  receiptPath?: string;
}

export async function launchPackagedBridge(options: BridgeRuntimeOptions): Promise<number> {
  const bundlePath = await canonicalExistingPath(options.bundlePath, "Blackglass Bridge app", "directory");
  const configPath = join(bundlePath, "Contents/Resources/bridge-launch.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  assertBridgeLaunchConfig(config);
  const adapterPath = await canonicalExistingPath(
    join(bundlePath, "Contents/Resources", config.adapterFileName),
    "embedded compatibility renderer",
    "file",
  );
  if (await sha256File(adapterPath) !== config.adapterSha256) {
    throw new Error("Embedded compatibility renderer no longer matches the signed launch contract");
  }
  await assertOfficialApp(config);
  assertNoUnmanagedOfficialProcesses();
  assertSafeRuntimeArguments(options.runtimeArguments ?? []);

  const runtimeHome = await prepareRuntimeHome(
    options.blackglassHomePath ?? process.env[BLACKGLASS_HOME_ENVIRONMENT],
  );
  const blackglassHome = runtimeHome.path;
  const profile = resolve(options.profilePath ?? join(homedir(), "Library/Application Support", BRIDGE_PROFILE_DIRECTORY));
  const vault = options.vaultPath ? await canonicalExistingPath(options.vaultPath, "client vault", "directory") : undefined;
  const receiptPath = options.receiptPath
    ? await canonicalOutputPath(options.receiptPath, "Bridge runtime receipt")
    : undefined;
  assertSafeRuntimePathLayout({
    bundlePath,
    officialAppPath: config.officialAppPath,
    profilePath: profile,
    blackglassHomePath: blackglassHome,
    normalObsidianProfilePath: join(homedir(), "Library/Application Support/Obsidian"),
    ...(vault ? { vaultPath: vault } : {}),
  });
  await prepareProfileDirectory(profile);
  const launchLease = await acquireRuntimeLaunchLease(profile, bundlePath, profile);
  let primaryLaunchError: Error | undefined;
  try {
    await prepareProfile(config, adapterPath, profile, vault);
    const localCli = await prepareLocalCli(config, profile);
    await clearStaleRendererLeases(blackglassHome);

    const executable = join(config.officialAppPath, "Contents/MacOS", config.officialExecutableName);
    const launchArguments = [
      executable,
      `--user-data-dir=${profile}`,
      ...(options.runtimeArguments ?? []),
    ];
    const startedAt = new Date().toISOString();
    const child = Bun.spawn(launchArguments, {
      cwd: vault ?? dirname(profile),
      env: {
        ...process.env,
        [BLACKGLASS_HOME_ENVIRONMENT]: blackglassHome,
        [BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT]: localCli,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const ownedProcesses = new Map<number, string>();
    trackOfficialProcessTree(child.pid, ownedProcesses);
    const forwardSignal = (signal: NodeJS.Signals): void => {
      try { child.kill(signal); } catch { /* Child may already be gone. */ }
    };
    const onSigint = (): void => forwardSignal("SIGINT");
    const onSigterm = (): void => forwardSignal("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    try {
      await waitForRendererHandshake(blackglassHome, child, ownedProcesses);
      await assertRuntimeProfile(config, profile);
      if (receiptPath) {
        const receipt: BridgeRuntimeReceipt = {
          schemaVersion: BRIDGE_RUNTIME_RECEIPT_SCHEMA_VERSION,
          startedAt,
          launcherPid: process.pid,
          officialPid: child.pid,
          officialChildOfLauncher: true,
          bundlePath,
          officialAppPath: config.officialAppPath,
          officialAppTreeSha256: config.officialAppTree.sha256,
          adapterSha256: config.adapterSha256,
          profilePath: profile,
          blackglassHomePath: blackglassHome,
          explicitUserDataDir: true,
          exclusiveOfficialInstance: true,
        };
        await writeFile(
          receiptPath,
          `${JSON.stringify(receipt, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
      }
      while (true) {
        const state = await Promise.race([
          child.exited.then((code) => ({ exited: true as const, code })),
          Bun.sleep(1_000).then(() => ({ exited: false as const, code: 0 })),
        ]);
        if (state.exited) {
          await waitForRuntimeShutdown(ownedProcesses, blackglassHome);
          return await verifyOfficialRuntimeAfterSession(config, state.code);
        }
        trackOfficialProcessTree(child.pid, ownedProcesses);
        assertNoUnmanagedOfficialProcesses();
        await assertRuntimeProfile(config, profile);
      }
    } catch (error) {
      const primary = asError(error);
      const cleanupErrors: Error[] = [];
      for (const action of [
        () => terminateChild(child, ownedProcesses),
        () => waitForRuntimeShutdown(ownedProcesses, blackglassHome),
        () => verifyOfficialRuntimeAfterSession(config, 0).then(() => undefined),
      ]) {
        try { await action(); } catch (cleanupError) { cleanupErrors.push(asError(cleanupError)); }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([primary, ...cleanupErrors], "Blackglass launch and cleanup failed");
      }
      throw primary;
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  } catch (error) {
    primaryLaunchError = asError(error);
    throw error;
  } finally {
    const finalizationErrors: Error[] = [];
    try {
      await releaseRuntimeLaunchLease(launchLease);
    } catch (error) {
      finalizationErrors.push(asError(error));
    }
    if (runtimeHome.temporaryRoot) {
      try { await rm(runtimeHome.temporaryRoot, { recursive: true, force: false }); }
      catch (error) { finalizationErrors.push(asError(error)); }
    }
    if (finalizationErrors.length > 0) {
      throw new AggregateError(
        [...(primaryLaunchError ? [primaryLaunchError] : []), ...finalizationErrors],
        "Blackglass launch finalization failed",
      );
    }
  }
}

export function assertSafeRuntimePathLayout(paths: {
  bundlePath: string;
  officialAppPath: string;
  profilePath: string;
  blackglassHomePath: string;
  normalObsidianProfilePath: string;
  vaultPath?: string;
}): void {
  const protectedPaths = [
    { label: "Bridge bundle", path: paths.bundlePath },
    { label: "Official application", path: paths.officialAppPath },
    { label: "Normal Obsidian profile", path: paths.normalObsidianProfilePath },
    ...(paths.vaultPath ? [{ label: "Vault", path: paths.vaultPath }] : []),
  ];
  assertNonOverlappingPaths(protectedPaths);
  assertNonOverlappingPaths([
    ...protectedPaths,
    { label: "Blackglass profile", path: paths.profilePath },
  ]);
  assertNonOverlappingPaths([
    ...protectedPaths,
    { label: "Blackglass runtime home", path: paths.blackglassHomePath },
  ]);

  const profile = resolve(paths.profilePath);
  const runtimeHome = resolve(paths.blackglassHomePath);
  if (profile === runtimeHome) {
    throw new Error("Blackglass profile and runtime home must be distinct");
  }
  const profileRelativeToHome = relative(runtimeHome, profile);
  const profileInsideRuntimeHome =
    profileRelativeToHome !== "" &&
    profileRelativeToHome !== ".." &&
    !profileRelativeToHome.startsWith(`..${sep}`) &&
    !isAbsolute(profileRelativeToHome);
  const runtimeRelativeToProfile = relative(profile, runtimeHome);
  const runtimeInsideProfile =
    runtimeRelativeToProfile !== "" &&
    runtimeRelativeToProfile !== ".." &&
    !runtimeRelativeToProfile.startsWith(`..${sep}`) &&
    !isAbsolute(runtimeRelativeToProfile);
  if (!profileInsideRuntimeHome && runtimeInsideProfile) {
    throw new Error("Blackglass runtime home must not be inside the Blackglass profile");
  }
}

async function verifyOfficialRuntimeAfterSession(config: BridgeLaunchConfig, exitCode: number): Promise<number> {
  const finalTree = await computeTreeIdentity(config.officialAppPath);
  if (stableJson(finalTree) !== stableJson(config.officialAppTree)) {
    throw new Error("Official Obsidian runtime changed during the Blackglass session");
  }
  return exitCode;
}

async function terminateChild(
  child: ReturnType<typeof Bun.spawn>,
  tracked: Map<number, string>,
): Promise<void> {
  trackOfficialProcessTree(child.pid, tracked);
  const alreadyExited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1).then(() => false),
  ]);
  if (!alreadyExited) {
    try { child.kill("SIGTERM"); } catch { /* Child may already be gone. */ }
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (!exited) {
      try { child.kill("SIGKILL"); } catch { /* Child may already be gone. */ }
      await child.exited;
    }
  }
  for (const [pid, identity] of tracked) {
    if (!processIsAlive(pid) || launcherProcessStartIdentity(pid) !== identity) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* Process may have exited. */ }
  }
}

export interface ProcessEntry { pid: number; ppid: number; command: string }

function processSnapshot(): ProcessEntry[] {
  const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Cannot inspect running processes");
  return result.stdout.toString("utf8").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

function descendantPids(mainPid: number, processes: ProcessEntry[]): number[] {
  const parent = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  return processes.filter((entry) => {
    if (entry.pid === mainPid) return true;
    for (let current = entry.pid, depth = 0; current > 1 && depth < 32; depth += 1) {
      current = parent.get(current) ?? 0;
      if (current === mainPid) return true;
    }
    return false;
  }).map((entry) => entry.pid);
}

function trackOfficialProcessTree(mainPid: number, tracked: Map<number, string>): void {
  const processes = processSnapshot();
  for (const pid of descendantPids(mainPid, processes)) {
    tracked.set(pid, launcherProcessStartIdentity(pid));
  }
}

async function waitForRuntimeShutdown(
  tracked: Map<number, string>,
  blackglassHome: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ownedProcessAlive = [...tracked].some(([pid, identity]) =>
      processIsAlive(pid) && launcherProcessStartIdentity(pid) === identity
    );
    const socketPresent = await pathExists(join(blackglassHome, ".blackglass-c.sock"));
    if (!ownedProcessAlive && !socketPresent) return;
    await Bun.sleep(100);
  }
  throw new Error("Official Obsidian helpers or the Blackglass CLI socket survived shutdown");
}

export async function readPackagedBridgeConfig(bundlePath: string): Promise<BridgeLaunchConfig> {
  const value = JSON.parse(
    await readFile(join(bundlePath, "Contents/Resources/bridge-launch.json"), "utf8"),
  ) as unknown;
  assertBridgeLaunchConfig(value);
  return value;
}

export async function verifyPackagedOfficialRuntime(bundlePath: string): Promise<BridgeLaunchConfig> {
  const config = await readPackagedBridgeConfig(bundlePath);
  await assertOfficialApp(config);
  return config;
}

async function assertOfficialApp(config: BridgeLaunchConfig): Promise<void> {
  const official = await canonicalExistingPath(config.officialAppPath, "official Obsidian app", "directory");
  if (basename(official) !== "Obsidian.app") throw new Error("Official application must be Obsidian.app");
  const actualTree = await computeTreeIdentity(official);
  if (stableJson(actualTree) !== stableJson(config.officialAppTree)) {
    throw new Error("Official Obsidian application no longer matches the reviewed source tree");
  }
  const inventory = await inspectMacOSCodeInventory(official, "source-contract");
  if (!macOSCodeInventoriesEqual(inventory, config.officialCodeInventory)) {
    throw new Error("Official Obsidian code inventory no longer matches the reviewed source");
  }
}

function assertNoUnmanagedOfficialProcesses(): void {
  const processes = processSnapshot();
  const unmanaged = unmanagedOfficialProcesses(processes);
  if (unmanaged.length > 0) {
    throw new Error(
      "An unmanaged Obsidian process is running: " +
        unmanaged.map((entry) => `${entry.pid} ${entry.command}`).join("; "),
    );
  }
}

export function unmanagedOfficialProcesses(processes: ProcessEntry[]): ProcessEntry[] {
  const parent = new Map(processes.map((entry) => [entry.pid, entry.ppid]));
  const managedByBridge = (pid: number): boolean => {
    const seen = new Set<number>();
    for (let current = pid; current > 1 && !seen.has(current); current = parent.get(current) ?? 0) {
      seen.add(current);
      const process = processes.find((entry) => entry.pid === current);
      if (process?.command.includes(`/${BRIDGE_BUNDLE_NAME}/Contents/MacOS/blackglass-bridge`)) {
        return true;
      }
    }
    return false;
  };
  return processes.filter((entry) =>
    (entry.command.includes("/Obsidian.app/Contents/MacOS/Obsidian") ||
      entry.command.includes("/Obsidian Helper") ||
      entry.command.includes("/Obsidian.app/Contents/Frameworks/")) &&
    !managedByBridge(entry.pid)
  );
}

async function prepareProfile(
  config: BridgeLaunchConfig,
  adapterPath: string,
  profile: string,
  vault: string | undefined,
): Promise<void> {
  await prepareProfileDirectory(profile);
  const target = join(profile, config.adapterProfileFileName);
  const aliases = (await readdir(profile)).filter((entry) => /^obsidian-\d+\.\d+\.\d+\.asar$/u.test(entry));
  const unexpected = aliases.filter((entry) => entry !== config.adapterProfileFileName);
  if (unexpected.length > 0) {
    throw new Error(`Blackglass profile contains competing renderer aliases: ${unexpected.join(", ")}`);
  }
  if (await pathExists(target)) await assertOwnedRegularFile(target, "Blackglass profile renderer");
  if (!(await pathExists(target)) || await sha256File(target) !== config.adapterSha256) {
    const temporary = `${target}.next-${process.pid}-${randomUUID()}`;
    await copyFile(adapterPath, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  }
  const archive = await AsarArchive.open(target);
  const metadata = JSON.parse(archive.read("package.json").toString("utf8")) as { version?: unknown };
  if (metadata.version !== config.rendererVersion) {
    throw new Error("Installed compatibility renderer version does not match its launch contract");
  }
  const configPath = join(profile, "obsidian.json");
  let settings: Record<string, unknown> = {};
  if (await pathExists(configPath)) {
    await assertOwnedRegularFile(configPath, "Blackglass profile configuration");
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Blackglass profile configuration is malformed");
    }
    settings = parsed as Record<string, unknown>;
  }
  settings.updateDisabled = true;
  if (vault) {
    const vaultId = createHash("sha256").update(vault).digest("hex").slice(0, 16);
    const vaults = settings.vaults && typeof settings.vaults === "object" && !Array.isArray(settings.vaults)
      ? settings.vaults as Record<string, unknown>
      : {};
    settings.vaults = { ...vaults, [vaultId]: { path: vault, ts: Date.now(), open: true } };
    const vaultState = join(profile, `${vaultId}.json`);
    if (await pathExists(vaultState)) await assertOwnedRegularFile(vaultState, "Blackglass vault state");
    else await writeFile(vaultState, "{}\n", { flag: "wx", mode: 0o600 });
  }
  const temporaryConfig = `${configPath}.next-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryConfig, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporaryConfig, configPath);
}

async function prepareProfileDirectory(profile: string): Promise<void> {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const profileStat = await lstat(profile);
  if (
    !profileStat.isDirectory() || profileStat.isSymbolicLink() ||
    profileStat.uid !== process.getuid!() || await realpath(profile) !== profile ||
    profile.toLocaleLowerCase("en-US") ===
      join(homedir(), "Library/Application Support/obsidian").toLocaleLowerCase("en-US")
  ) {
    throw new Error("Blackglass profile must be a canonical owner-controlled directory distinct from Obsidian");
  }
  await chmod(profile, 0o700);
}

export async function assertRuntimeProfile(config: BridgeLaunchConfig, profile: string): Promise<void> {
  const aliases = (await readdir(profile)).filter((entry) => /^obsidian-\d+\.\d+\.\d+\.asar$/u.test(entry));
  if (aliases.length !== 1 || aliases[0] !== config.adapterProfileFileName) {
    throw new Error("Blackglass profile renderer selection changed during the session");
  }
  if (await sha256File(join(profile, config.adapterProfileFileName)) !== config.adapterSha256) {
    throw new Error("Blackglass profile renderer changed during the session");
  }
  const settings = JSON.parse(await readFile(join(profile, "obsidian.json"), "utf8")) as unknown;
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      (settings as Record<string, unknown>).updateDisabled !== true) {
    throw new Error("Blackglass profile update protection changed during the session");
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function prepareLocalCli(config: BridgeLaunchConfig, profile: string): Promise<string> {
  const upstream = join(config.officialAppPath, "Contents/MacOS/obsidian-cli");
  const target = join(profile, "blackglass-cli");
  if (await pathExists(target)) await assertOwnedRegularFile(target, "Blackglass local CLI");
  const temporary = `${target}.next-${process.pid}-${randomUUID()}`;
  try {
    const generated = await writeSignedPatchedCliBinary(await readFile(upstream), temporary);
    if (!(await pathExists(target)) || await sha256File(target) !== generated.executableSha256) {
      if (await pathExists(target)) await unlink(target);
      await rename(temporary, target);
    } else {
      await unlink(temporary);
    }
  } catch (error) {
    if (await pathExists(temporary)) await unlink(temporary);
    throw error;
  }
  await chmod(target, 0o700);
  return target;
}

async function waitForRendererHandshake(
  blackglassHome: string,
  child: ReturnType<typeof Bun.spawn>,
  tracked: Map<number, string>,
): Promise<void> {
  const socket = join(blackglassHome, ".blackglass-c.sock");
  const upstreamSocket = join(blackglassHome, ".obsidian-cli.sock");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    trackOfficialProcessTree(child.pid, tracked);
    if (await pathExists(upstreamSocket)) {
      throw new Error("Official renderer socket appeared; the reviewed Blackglass renderer was not selected");
    }
    if (await pathExists(socket)) {
      const stat = await lstat(socket);
      if (!stat.isSocket()) throw new Error("Blackglass renderer handshake path is not a Unix socket");
      const owners = socketOwnerPids(socket);
      if (owners.length !== 1 || !isProcessDescendant(owners[0]!, child.pid)) {
        throw new Error("Blackglass renderer handshake socket is not owned by the supervised official process tree");
      }
      return;
    }
    const exit = await Promise.race([
      child.exited.then((code) => ({ exited: true as const, code })),
      Bun.sleep(100).then(() => ({ exited: false as const, code: undefined })),
    ]);
    if (exit.exited) throw new Error(`Official Obsidian exited before the Blackglass renderer handshake (${exit.code})`);
  }
  throw new Error("Timed out waiting for the reviewed Blackglass renderer handshake");
}

function socketOwnerPids(path: string): number[] {
  const result = Bun.spawnSync([
    "/usr/sbin/lsof", "-nP", "-Fp", "-a", "-U", "--", path,
  ], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return [];
  return [...new Set(result.stdout.toString("utf8").split("\n").flatMap((line) =>
    /^p\d+$/u.test(line) ? [Number(line.slice(1))] : []
  ))];
}

function isProcessDescendant(candidatePid: number, ancestorPid: number): boolean {
  let current = candidatePid;
  for (let depth = 0; depth < 32; depth += 1) {
    if (current === ancestorPid) return true;
    const result = Bun.spawnSync(["/bin/ps", "-p", String(current), "-o", "ppid="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return false;
    const parent = Number(result.stdout.toString("utf8").trim());
    if (!Number.isSafeInteger(parent) || parent <= 1 || parent === current) return false;
    current = parent;
  }
  return false;
}

export async function clearStaleRendererLeases(blackglassHome: string): Promise<void> {
  for (const name of [".blackglass-c.sock", ".obsidian-cli.sock"]) {
    const path = join(blackglassHome, name);
    if (!(await pathExists(path))) continue;
    const stat = await lstat(path);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to replace non-socket renderer lease: ${path}`);
    }
    if (await unixSocketAcceptsConnections(path)) {
      throw new Error(`Refusing to replace active renderer lease: ${path}`);
    }
    await unlink(path);
  }
}

export function assertSafeRuntimeArguments(arguments_: readonly string[]): void {
  const allowedSwitches = [
    /^--remote-debugging-port=\d+$/u,
    /^--remote-debugging-address=127\.0\.0\.1$/u,
    /^--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]{43}=$/u,
  ];
  for (const argument of arguments_) {
    if (argument.startsWith("--host-resolver-rules=")) {
      assertSafeHostResolverRules(argument.slice("--host-resolver-rules=".length));
      continue;
    }
    if (!argument.startsWith("-") || allowedSwitches.some((pattern) => pattern.test(argument))) continue;
    throw new Error(`Unsupported packaged runtime argument: ${argument}`);
  }
}

function assertSafeHostResolverRules(value: string): void {
  const rules = value.split(",");
  if (rules.length < 1 || rules.length > 2) {
    throw new Error("Packaged host resolver rules must contain one or two exact MAP entries");
  }
  const hosts = new Set<string>();
  let commonPort: number | undefined;
  for (const rule of rules) {
    const match = /^MAP ([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?) 127\.0\.0\.1:(\d+)$/u.exec(rule);
    const port = Number(match?.[2]);
    const host = match?.[1]?.toLowerCase();
    if (!host || !Number.isSafeInteger(port) || port < 1024 || port > 65_535 ||
      host === "localhost" || host.startsWith("localhost.") || hosts.has(host) ||
      (commonPort !== undefined && commonPort !== port)) {
      throw new Error("Unsafe packaged host resolver rules");
    }
    hosts.add(host);
    commonPort = port;
  }
}

async function assertOwnedRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid!()
  ) {
    throw new Error(`${label} must be an owner-controlled regular file`);
  }
}

async function unixSocketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveConnection, rejectConnection) => {
    const socket = createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectConnection(new Error(`Timed out validating renderer lease: ${path}`));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolveConnection(false);
      else rejectConnection(error);
    });
  });
}

async function prepareRuntimeHome(argument: string | undefined): Promise<{
  path: string;
  temporaryRoot?: string;
}> {
  const temporaryRoot = argument
    ? undefined
    : await mkdtemp(join("/private/tmp", "blackglass-bridge-"));
  if (temporaryRoot) await chmod(temporaryRoot, 0o700);
  const requested = argument ? resolve(argument) : join(temporaryRoot!, "h");
  if (!argument) {
    await mkdir(requested, { recursive: true, mode: 0o700 });
  }
  const canonical = await canonicalExistingPath(requested, "Blackglass runtime home", "directory");
  const metadata = await lstat(canonical);
  if (
    canonical !== resolve(requested) ||
    await realpath(canonical) !== canonical ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid!() ||
    (metadata.mode & 0o777) !== 0o700 ||
    Buffer.byteLength(join(canonical, ".blackglass-c.sock"), "utf8") > 103
  ) {
    throw new Error("Blackglass runtime home must be canonical, owner-only, and short enough for a Unix socket");
  }
  const parent = await lstat(dirname(canonical));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid!() ||
    (parent.mode & 0o777) !== 0o700 || await realpath(dirname(canonical)) !== dirname(canonical)) {
    throw new Error("Blackglass runtime home parent must be canonical and owner-only");
  }
  return { path: canonical, ...(temporaryRoot ? { temporaryRoot } : {}) };
}

export interface RuntimeLaunchLease {
  path: string;
  bytes: Buffer;
}

export async function acquireRuntimeLaunchLease(
  profileDirectory: string,
  bundlePath: string,
  profilePath: string,
): Promise<RuntimeLaunchLease> {
  const path = join(profileDirectory, ".blackglass-launch.lock");
  if (await pathExists(path)) {
    const existing = await readFile(path);
    const metadata = await lstat(path);
    let value: Record<string, unknown>;
    try { value = JSON.parse(existing.toString("utf8")) as Record<string, unknown>; }
    catch { throw new Error(`Refusing malformed Blackglass launch lease: ${path}`); }
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid!() ||
      (metadata.mode & 0o777) !== 0o600 || value.schemaVersion !== 2 ||
      !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 ||
      typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt)) ||
      typeof value.nonce !== "string" || value.nonce.length < 16 ||
      typeof value.bundlePath !== "string" || typeof value.profilePath !== "string" ||
      typeof value.processStartIdentity !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.processStartIdentity)
    ) {
      throw new Error(`Refusing unsafe Blackglass launch lease: ${path}`);
    }
    if (
      processIsAlive(Number(value.pid)) &&
      launcherProcessStartIdentity(Number(value.pid)) === value.processStartIdentity
    ) {
      throw new Error(`Another Blackglass Bridge launcher owns ${path}`);
    }
    if (!(await readFile(path)).equals(existing)) {
      throw new Error(`Blackglass launch lease changed during stale-owner recovery: ${path}`);
    }
    await unlink(path);
  }
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    processStartIdentity: launcherProcessStartIdentity(process.pid),
    acquiredAt: new Date().toISOString(),
    nonce: randomUUID(),
    bundlePath,
    profilePath,
  })}\n`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, bytes };
}

export async function releaseRuntimeLaunchLease(lease: RuntimeLaunchLease): Promise<void> {
  const current = await readFile(lease.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Blackglass launch lease disappeared during the session");
    throw error;
  });
  if (!current.equals(lease.bytes)) {
    throw new Error("Refusing to remove a changed Blackglass launch lease");
  }
  await unlink(lease.path);
}

function launcherProcessStartIdentity(pid: number): string {
  try {
    const result = Bun.spawnSync([
      "/bin/ps", "-ww", "-p", String(pid), "-o", "lstart=", "-o", "command=",
    ], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      return createHash("sha256").update(result.stdout).digest("hex");
    }
  } catch { /* Restricted unit-test sandboxes can deny process inspection. */ }
  return createHash("sha256").update(`unavailable:${pid}`).digest("hex");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
