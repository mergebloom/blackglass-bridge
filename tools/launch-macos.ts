import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AsarArchive } from "./asar";
import { parseStrictFlags } from "./cli-flags";
import { MACOS_PACKAGING_EXECUTABLES } from "./packaging-toolchain";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import {
  assertPreparedClientAdapterPath,
  type ClientLaunchIdentity,
  resolvePreparedClientLayout,
  runtimeReceiptPathForClientIdentity,
} from "./e2e-client";
import { readVerifiedE2ETls } from "./e2e-tls";
import {
  acquirePreparedClientLease,
  releasePreparedClientLease,
  sourceLossResetLockPath,
} from "./e2e-run-lock";
import {
  inspectMacOSArtifact,
  publicMacOSArtifact,
  type MacOSArtifact,
} from "./macos-artifact";
import {
  assertNoSymlinkSegments,
  assertNonOverlappingPaths,
  assertPathWithin,
  canonicalExistingPath,
  canonicalOutputPath,
  pathExists,
  pathsEqual,
} from "./path-safety";
import { readBlackglassReleaseManifest } from "./release-manifest";
import { isSupportedStableSemver } from "./semver";
import { stableJson } from "./stable-json";
import {
  BRIDGE_RUNTIME_RECEIPT_SCHEMA_VERSION,
  type BridgeRuntimeReceipt,
  verifyPackagedOfficialRuntime,
} from "./launcher-runtime";
import { BRIDGE_EXECUTABLE_NAME } from "./launcher-config";
import { superviseTerminationSignals } from "./termination-signal-supervisor";

const [asarArgument, profileArgument, vaultArgument, ...flagArguments] = Bun.argv.slice(2);
if (!asarArgument || !profileArgument || !vaultArgument) usage();
if (process.platform !== "darwin") {
  throw new Error("The first client launcher supports macOS only");
}
const flags = parseStrictFlags(flagArguments, {
  valueFlags: [
    "--app",
    "--blackglass-home",
    "--debug-port",
    "--debug-readiness-timeout-ms",
    "--e2e-tls-metadata",
    "--identity-out",
  ],
  booleanFlags: ["--replace-adapter", "--prepare-only"],
});
const debugPortValue = flags.values.get("--debug-port");
const debugReadinessTimeoutValue = flags.values.get("--debug-readiness-timeout-ms");
const tlsMetadataArgument = flags.values.get("--e2e-tls-metadata");
const identityArgument = flags.values.get("--identity-out");
const blackglassHomeArgument = flags.values.get("--blackglass-home");
const prepareOnly = flags.booleans.has("--prepare-only");
const e2eRequested = Boolean(debugPortValue || tlsMetadataArgument || identityArgument);
const debugReadinessTimeoutMs = debugReadinessTimeoutValue
  ? parseDebugReadinessTimeout(debugReadinessTimeoutValue)
  : 30_000;
if (
  e2eRequested &&
  (!debugPortValue || !tlsMetadataArgument || !identityArgument || prepareOnly)
) {
  throw new Error(
    "E2E launches require --debug-port, --e2e-tls-metadata, and --identity-out together",
  );
}
if (e2eRequested && blackglassHomeArgument) {
  throw new Error("Prepared E2E launches allocate BLACKGLASS_HOME automatically");
}
if (debugReadinessTimeoutValue && !e2eRequested) {
  throw new Error("--debug-readiness-timeout-ms is available only for E2E launches");
}

const asar = await canonicalExistingPath(asarArgument, "Compatibility ASAR", "file");
const profile = await canonicalExistingPath(profileArgument, "Client profile", "directory");
const vault = await canonicalExistingPath(vaultArgument, "Client vault", "directory");
const appBundle = await canonicalExistingPath(
  flags.values.get("--app") ?? "/Applications/Blackglass Bridge.app",
  "macOS app bundle",
  "directory",
);
if (!appBundle.endsWith(".app")) throw new Error("macOS app bundle must end in .app");
assertNonOverlappingPaths([
  { label: "Client profile", path: profile },
  { label: "Client vault", path: vault },
  { label: "macOS app bundle", path: appBundle },
]);
if (!e2eRequested) {
  assertNonOverlappingPaths([
    { label: "Client profile", path: profile },
    { label: "Client vault", path: vault },
    { label: "macOS app bundle", path: appBundle },
    { label: "Compatibility ASAR", path: asar },
  ]);
}
assertNonOverlappingPaths([
  { label: "Client profile", path: profile },
  {
    label: "Obsidian normal profile",
    path: resolve(homedir(), "Library/Application Support/obsidian"),
  },
  {
    label: "Blackglass normal profile",
    path: resolve(homedir(), "Library/Application Support/Blackglass Profile"),
  },
]);

const archive = await AsarArchive.open(asar);
const packageMetadata = JSON.parse(archive.read("package.json").toString("utf8")) as {
  version?: string;
};
if (!isSupportedStableSemver(packageMetadata.version)) {
  throw new Error("Compatibility ASAR has no semantic package version");
}
const rendererSha256 = sha256(archive.read("app.js"));
const starterSha256 = sha256(archive.read("starter.js"));
const mainSha256 = sha256(archive.read("main.js"));
const adapterSha256 = await fileSha256(asar);
const infoPlist = join(appBundle, "Contents/Info.plist");
const bundleIdentifier = plistString(infoPlist, "CFBundleIdentifier");
if (bundleIdentifier !== "com.blackglass.bridge") {
  throw new Error(`Refusing non-Blackglass Bridge app ${bundleIdentifier}`);
}
const appArtifact = await inspectMacOSArtifact(appBundle);
const launchConfig = await verifyPackagedOfficialRuntime(appBundle);
const runtimeApp = await canonicalExistingPath(launchConfig.officialAppPath, "official Obsidian runtime", "directory");
const executableName = launchConfig.officialExecutableName;
const executable = await canonicalExistingPath(
  join(runtimeApp, "Contents/MacOS", executableName),
  "official Obsidian executable",
  "file",
);
const executableSha256 = await fileSha256(executable);
const launcherExecutable = await canonicalExistingPath(
  join(appBundle, "Contents/MacOS", BRIDGE_EXECUTABLE_NAME),
  "Blackglass Bridge launcher executable",
  "file",
);
const launcherExecutableSha256 = await fileSha256(launcherExecutable);
if (appArtifact.embeddedAsarSha256 !== adapterSha256) {
  throw new Error(
    "Blackglass always loads its embedded renderer; the supplied ASAR must match it",
  );
}
assertProfileNotInUse(runtimeApp, profile);
if (!e2eRequested && !blackglassHomeArgument) {
  assertNoSharedHomeBlackglassProcess(runtimeApp);
  if (await pathExists(join(homedir(), appArtifact?.cliSocketName ?? ".blackglass-c.sock"))) {
    throw new Error("The login-home Blackglass CLI socket is already owned or stale");
  }
}

let launchLeasePath: string | undefined;
let terminationSignalSupervisor: ReturnType<typeof superviseTerminationSignals> | undefined;
try {
let targetAsar = join(profile, launchConfig.adapterProfileFileName);
let launchHome = profile;
if (!e2eRequested && process.env[BLACKGLASS_HOME_ENVIRONMENT] && !blackglassHomeArgument) {
  throw new Error(
    "Pass inherited BLACKGLASS_HOME explicitly with --blackglass-home so it can be validated",
  );
}
if (blackglassHomeArgument) {
  launchHome = await validateBlackglassHome(
    blackglassHomeArgument,
    appArtifact?.cliSocketName ?? ".blackglass-c.sock",
  );
  if (pathsEqual(launchHome, homedir())) {
    throw new Error("--blackglass-home must be distinct from the native login home");
  }
  assertNonOverlappingPaths([
    { label: "BLACKGLASS_HOME", path: launchHome },
    { label: "Client profile", path: profile },
    { label: "Client vault", path: vault },
    { label: "macOS app bundle", path: appBundle },
    { label: "Compatibility ASAR", path: asar },
  ]);
  if (await pathExists(join(launchHome, appArtifact?.cliSocketName ?? ".blackglass-c.sock"))) {
    throw new Error("BLACKGLASS_HOME already contains a Blackglass CLI socket");
  }
}
let launchBinding:
  | {
      identityPath: string;
      runManifestSha256: string;
      releaseManifestSha256: string;
      tlsMetadataPath: string;
      tlsMetadataSha256: string;
      tlsSpkiSha256Base64: string;
      resetLockPath: string;
      runtimeReceiptPath: string;
    }
  | undefined;
if (e2eRequested) {
  if (!appArtifact) throw new Error("Prepared E2E app identity is unavailable");
  const layout = await resolvePreparedClientLayout(profile, vault);
  const run = layout.run;
  const resetLockPath = sourceLossResetLockPath(run.root);
  launchLeasePath = await acquirePreparedClientLease(run.root, layout.clientName);
  if (run.manifest.compatibilityAsarSha256 !== adapterSha256) {
    throw new Error("Compatibility ASAR is not bound to the selected prepared run");
  }
  const expectedAdapter = assertPreparedClientAdapterPath(
    profile,
    asar,
    run.manifest.adapterFileName,
  );
  targetAsar = await canonicalExistingPath(
    expectedAdapter,
    "Prepared client adapter",
    "file",
  );
  await assertNoSymlinkSegments(run.root, targetAsar, "Prepared client adapter");
  if ((await fileSha256(targetAsar)) !== adapterSha256) {
    throw new Error("Prepared client adapter no longer matches the run manifest");
  }
  if (flags.booleans.has("--replace-adapter")) {
    throw new Error("Prepared E2E adapters are immutable and cannot be replaced at launch");
  }
  const artifactPath = await canonicalExistingPath(
    join(run.root, "client-artifact.json"),
    "Prepared client artifact identity",
    "file",
  );
  await assertNoSymlinkSegments(run.root, artifactPath, "Prepared client artifact identity");
  const recordedArtifact = JSON.parse(await readFile(artifactPath, "utf8")) as MacOSArtifact;
  if (
    recordedArtifact.appPath !== appBundle ||
    stableJson(publicMacOSArtifact(recordedArtifact)) !==
      stableJson(publicMacOSArtifact(appArtifact))
  ) {
    throw new Error("Launched app does not match the selected prepared run");
  }
  const releaseManifestPath = await canonicalExistingPath(
    join(run.root, run.manifest.releaseManifestFileName),
    "Prepared release manifest",
    "file",
  );
  await assertNoSymlinkSegments(run.root, releaseManifestPath, "Prepared release manifest");
  if ((await fileSha256(releaseManifestPath)) !== run.manifest.releaseManifestSha256) {
    throw new Error("Prepared release manifest no longer matches the run manifest");
  }
  const { manifest: releaseManifest } = await readBlackglassReleaseManifest(releaseManifestPath);
  if (
    stableJson(releaseManifest.macOS) !== stableJson(publicMacOSArtifact(appArtifact)) ||
    releaseManifest.renderer.patchedSha256 !== adapterSha256 ||
    releaseManifest.renderer.rendererAfterSha256 !== rendererSha256 ||
    releaseManifest.renderer.starterAfterSha256 !== starterSha256 ||
    releaseManifest.renderer.mainAfterSha256 !== mainSha256
  ) {
    throw new Error(
      "Prepared release manifest does not bind the launched app and both renderers",
    );
  }
  const tls = await readVerifiedE2ETls(run.root, tlsMetadataArgument);
  const identityPath = await canonicalOutputPath(identityArgument as string, "Client identity");
  assertPathWithin(identityPath, run.root, "Client identity");
  await assertNoSymlinkSegments(run.root, dirname(identityPath), "Client identity parent");
  launchBinding = {
    identityPath,
    runManifestSha256: run.manifestSha256,
    releaseManifestSha256: run.manifest.releaseManifestSha256,
    tlsMetadataPath: tls.metadataPath,
    tlsMetadataSha256: tls.metadataSha256,
    tlsSpkiSha256Base64: tls.metadata.spkiSha256Base64,
    resetLockPath,
    runtimeReceiptPath: runtimeReceiptPathForClientIdentity(
      run.root,
      layout.clientName,
      identityPath,
    ),
  };
} else {
  if (await Bun.file(targetAsar).exists()) {
    const same = (await fileSha256(targetAsar)) === adapterSha256;
    if (!same && !flags.booleans.has("--replace-adapter")) {
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
if (!(await Bun.file(vaultState).exists())) await writeJsonAtomic(vaultState, {});

const debugPort = debugPortValue ? parseDebugPort(debugPortValue) : undefined;
const nativeHomePath = process.env.HOME;
if (!nativeHomePath || !nativeHomePath.startsWith("/")) {
  throw new Error("The native macOS HOME must be an absolute path");
}
const runtimeArguments: string[] = [];
if (debugPort) runtimeArguments.push(`--remote-debugging-port=${debugPort}`);
if (launchBinding) {
  const tls = await readVerifiedE2ETls(dirname(dirname(profile)), launchBinding.tlsMetadataPath);
  runtimeArguments.push(
    `--host-resolver-rules=${tls.metadata.chromiumHostResolverRules}`,
    `--ignore-certificate-errors-spki-list=${tls.metadata.spkiSha256Base64}`,
  );
}
const summary = {
  version: packageMetadata.version,
  profile,
  vault,
  adapter: targetAsar,
  adapterSha256,
  appBundle,
  bundleIdentifier,
  executable,
  executableSha256,
  ...(blackglassHomeArgument ? { blackglassHome: launchHome } : {}),
};
if (prepareOnly) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

assertProfileNotInUse(runtimeApp, profile);
if (!launchBinding && !blackglassHomeArgument) {
  assertNoSharedHomeBlackglassProcess(runtimeApp);
  if (await pathExists(join(homedir(), appArtifact?.cliSocketName ?? ".blackglass-c.sock"))) {
    throw new Error("The login-home Blackglass CLI socket became occupied before launch");
  }
}
if (launchBinding && await pathExists(launchBinding.resetLockPath)) {
  throw new Error("Prepared run became locked for source-loss reset");
}
if (
  blackglassHomeArgument &&
  await pathExists(join(launchHome, appArtifact?.cliSocketName ?? ".blackglass-c.sock"))
) {
  throw new Error("BLACKGLASS_HOME gained a Blackglass CLI socket before launch");
}

let shortHomeRoot: string | undefined;
if (launchBinding) {
  const runtimeHome = await createShortBlackglassHome();
  shortHomeRoot = runtimeHome.root;
  launchHome = runtimeHome.home;
}
const startedAt = new Date().toISOString();
const launchArguments = [
  launcherExecutable,
  "--blackglass-profile", profile,
  "--blackglass-vault", vault,
  "--blackglass-home", launchHome,
  ...(launchBinding
    ? ["--blackglass-runtime-receipt", launchBinding.runtimeReceiptPath]
    : []),
  ...runtimeArguments,
];
let child: ReturnType<typeof Bun.spawn>;
try {
  child = Bun.spawn(launchArguments, {
    cwd: vault,
    env: { ...process.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
} catch (error) {
  if (shortHomeRoot) {
    await removeShortBlackglassHome(
      shortHomeRoot,
      launchHome,
      appArtifact?.cliSocketName ?? ".blackglass-c.sock",
    );
  }
  throw error;
}
terminationSignalSupervisor = superviseTerminationSignals(child);
if (launchBinding && debugPort) {
  if (!appArtifact) throw new Error("Prepared E2E app identity is unavailable");
  const publicArtifact = publicMacOSArtifact(appArtifact);
  let debugBinding: Awaited<ReturnType<typeof waitForDebugBinding>> | undefined;
  let runtimeReceipt: BridgeRuntimeReceipt | undefined;
  try {
    runtimeReceipt = await waitForRuntimeReceipt(
      launchBinding.runtimeReceiptPath,
      child,
      debugReadinessTimeoutMs,
    );
    if (
      runtimeReceipt.launcherPid !== child.pid ||
      runtimeReceipt.bundlePath !== appBundle ||
      runtimeReceipt.officialAppPath !== runtimeApp ||
      runtimeReceipt.officialAppTreeSha256 !== appArtifact.officialAppTreeSha256 ||
      runtimeReceipt.adapterSha256 !== adapterSha256 ||
      runtimeReceipt.profilePath !== profile ||
      runtimeReceipt.blackglassHomePath !== launchHome
    ) {
      throw new Error("Packaged launcher runtime receipt does not match the prepared client");
    }
    debugBinding = await waitForDebugBinding(
      debugPort,
      runtimeReceipt.officialPid,
      child,
      debugReadinessTimeoutMs,
    );
    if (
      debugBinding.nativeHomePath !== nativeHomePath ||
      debugBinding.blackglassHomePath !== launchHome ||
      debugBinding.nativeHomePath === debugBinding.blackglassHomePath
    ) {
      throw new Error(
        "Launched renderer did not preserve native HOME while using BLACKGLASS_HOME",
      );
    }
    await waitForCliSocket(launchHome, appArtifact.cliSocketName, child);
  } catch (error) {
    await rethrowAfterFailedLaunch(
      error,
      child,
      runtimeApp,
      profile,
      shortHomeRoot,
      launchHome,
      appArtifact.cliSocketName,
    );
  }
  if (!debugBinding || !runtimeReceipt) throw new Error("Client launch lost its packaged runtime binding");
  try {
    const identity: ClientLaunchIdentity = {
      schemaVersion: 5,
      runManifestSha256: launchBinding.runManifestSha256,
      releaseManifestSha256: launchBinding.releaseManifestSha256,
      startedAt,
      pid: runtimeReceipt.officialPid,
      launchCommand: processInfo(runtimeReceipt.officialPid).command,
      launcherPid: child.pid,
      launcherCommand: processInfo(child.pid).command,
      launcherExecutablePath: launcherExecutable,
      launcherExecutableSha256,
      officialChildOfLauncher: true,
      runtimeReceiptPath: launchBinding.runtimeReceiptPath,
      runtimeReceiptSha256: await fileSha256(launchBinding.runtimeReceiptPath),
      debugPort,
      debugListenerPid: debugBinding.listenerPid,
      debugListenerCommand: debugBinding.listenerCommand,
      debugTargetId: debugBinding.targetId,
      debugTargetUrl: debugBinding.targetUrl,
      executablePath: executable,
      executableSha256,
      officialAppPath: runtimeApp,
      appBundlePath: appBundle,
      appArtifactSha256: sha256(Buffer.from(stableJson(publicArtifact))),
      appArtifact: publicArtifact,
      adapterPath: targetAsar,
      adapterSha256,
      profilePath: profile,
      blackglassHomePath: launchHome,
      blackglassHomeEnvironment: BLACKGLASS_HOME_ENVIRONMENT,
      blackglassHomeMode: 0o700,
      blackglassHomeCanonical: true,
      cliSocketPath: join(launchHome, appArtifact.cliSocketName),
      nativeHomePath,
      nativeHomeEnvironmentPreserved: true,
      vaultPath: vault,
      tlsMetadataPath: launchBinding.tlsMetadataPath,
      tlsMetadataSha256: launchBinding.tlsMetadataSha256,
      tlsSpkiSha256Base64: launchBinding.tlsSpkiSha256Base64,
    };
    await writeFile(
      launchBinding.identityPath,
      `${JSON.stringify(identity, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(JSON.stringify({
      ...summary,
      identityPath: launchBinding.identityPath,
      identity,
    }, null, 2));
  } catch (error) {
    await rethrowAfterFailedLaunch(
      error,
      child,
      runtimeApp,
      profile,
      shortHomeRoot,
      launchHome,
      appArtifact.cliSocketName,
    );
  }
} else {
  console.log(JSON.stringify(summary, null, 2));
}
const exitCode = await child.exited;
if (shortHomeRoot) {
  if (!await waitForClientProcessesExit(runtimeApp, profile, 5_000)) {
    throw new Error("Client helpers survived after the launched main process exited");
  }
  await removeShortBlackglassHome(
    shortHomeRoot,
    launchHome,
    appArtifact?.cliSocketName ?? ".blackglass-c.sock",
  );
} else if (blackglassHomeArgument) {
  if (!await waitForClientProcessesExit(runtimeApp, profile, 5_000)) {
    throw new Error("Client helpers survived after the launched main process exited");
  }
  if (await pathExists(join(launchHome, appArtifact?.cliSocketName ?? ".blackglass-c.sock"))) {
    throw new Error("Client retained its dedicated CLI socket after shutdown");
  }
}
process.exitCode = exitCode;
} finally {
  terminationSignalSupervisor?.dispose();
  if (launchLeasePath) await releasePreparedClientLease(launchLeasePath);
}

async function waitForRuntimeReceipt(
  path: string,
  launcher: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<BridgeRuntimeReceipt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(path)) {
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<BridgeRuntimeReceipt>;
      if (
        value.schemaVersion !== BRIDGE_RUNTIME_RECEIPT_SCHEMA_VERSION ||
        !Number.isSafeInteger(value.launcherPid) ||
        !Number.isSafeInteger(value.officialPid) ||
        value.officialChildOfLauncher !== true ||
        typeof value.bundlePath !== "string" ||
        typeof value.officialAppPath !== "string" ||
        typeof value.officialAppTreeSha256 !== "string" ||
        typeof value.adapterSha256 !== "string" ||
        typeof value.profilePath !== "string" ||
        typeof value.blackglassHomePath !== "string" ||
        value.explicitUserDataDir !== true ||
        value.exclusiveOfficialInstance !== true
      ) {
        throw new Error("Packaged launcher wrote a malformed runtime receipt");
      }
      return value as BridgeRuntimeReceipt;
    }
    const exited = await Promise.race([
      launcher.exited.then((code) => ({ exited: true as const, code })),
      Bun.sleep(100).then(() => ({ exited: false as const, code: 0 })),
    ]);
    if (exited.exited) {
      throw new Error(`Packaged launcher exited before its runtime receipt (${exited.code})`);
    }
  }
  throw new Error("Timed out waiting for the packaged launcher runtime receipt");
}

async function fileSha256(path: string): Promise<string> {
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  return sha256(bytes);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function createShortBlackglassHome(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp("/private/tmp/blackglass-client-");
  const rootStat = await lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    rootStat.uid !== process.getuid!()
  ) {
    throw new Error("Short BLACKGLASS_HOME root is not a private real directory");
  }
  const home = join(root, "h");
  await mkdir(home, { recursive: false, mode: 0o700 });
  const homeStat = await lstat(home);
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    (homeStat.mode & 0o777) !== 0o700 ||
    homeStat.uid !== process.getuid!() ||
    await realpath(home) !== home
  ) {
    throw new Error("Short BLACKGLASS_HOME is not a private real directory");
  }
  if (Buffer.byteLength(join(home, ".blackglass-c.sock"), "utf8") > 103) {
    throw new Error("Short BLACKGLASS_HOME still exceeds the macOS socket limit");
  }
  return { root, home };
}

async function validateBlackglassHome(homeArgument: string, socketName: string): Promise<string> {
  const home = await canonicalExistingPath(
    homeArgument,
    "BLACKGLASS_HOME",
    "directory",
  );
  const homeStat = await lstat(home);
  if (
    homeStat.isSymbolicLink() ||
    (homeStat.mode & 0o777) !== 0o700 ||
    homeStat.uid !== process.getuid!() ||
    await realpath(home) !== home
  ) {
    throw new Error("BLACKGLASS_HOME must be a canonical owner-only real directory");
  }
  if (Buffer.byteLength(join(home, socketName), "utf8") > 103) {
    throw new Error("BLACKGLASS_HOME exceeds the macOS Unix-socket path limit");
  }
  return home;
}

async function waitForCliSocket(
  home: string,
  socketName: string,
  child: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  const socketPath = join(home, socketName);
  const upstreamSocketPath = join(home, ".obsidian-cli.sock");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("Blackglass exited before creating its CLI socket");
    }
    const socketStat = await lstat(socketPath).catch(() => undefined);
    if (socketStat?.isSocket()) {
      if (await pathExists(upstreamSocketPath)) {
        throw new Error("Launched client created the upstream Obsidian CLI socket");
      }
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error("Launched client did not create its isolated CLI socket");
}

async function removeShortBlackglassHome(
  root: string,
  home: string,
  expectedSocketName: string,
): Promise<void> {
  if (
    !/^\/private\/tmp\/blackglass-client-[A-Za-z0-9]{6}$/u.test(root) ||
    home !== join(root, "h")
  ) {
    throw new Error("Refusing to remove an unrecognized BLACKGLASS_HOME");
  }
  const [rootStat, homeStat] = await Promise.all([lstat(root), lstat(home)]);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    (homeStat.mode & 0o777) !== 0o700 ||
    rootStat.uid !== process.getuid!() ||
    homeStat.uid !== process.getuid!() ||
    await realpath(root) !== root ||
    await realpath(home) !== home ||
    rootStat.dev !== homeStat.dev
  ) {
    throw new Error("Refusing to remove a changed BLACKGLASS_HOME");
  }
  let homeEntries = await readdir(home);
  const cleanupDeadline = Date.now() + 3_000;
  while (homeEntries.length !== 0 && Date.now() < cleanupDeadline) {
    await Bun.sleep(100);
    homeEntries = await readdir(home);
  }
  if (
    homeEntries.length === 1 &&
    homeEntries[0] === expectedSocketName &&
    (await lstat(join(home, expectedSocketName))).isSocket()
  ) {
    await unlink(join(home, expectedSocketName));
    homeEntries = await readdir(home);
  }
  if (homeEntries.length !== 0) {
    throw new Error(
      `BLACKGLASS_HOME retained runtime artifacts after shutdown: ${homeEntries.join(", ")}`,
    );
  }
  await rmdir(home);
  if ((await readdir(root)).length !== 0) {
    throw new Error("BLACKGLASS_HOME root gained unexpected entries");
  }
  await rmdir(root);
}

async function rethrowAfterFailedLaunch(
  primary: unknown,
  child: ReturnType<typeof Bun.spawn>,
  appBundle: string,
  profile: string,
  shortHomeRoot: string | undefined,
  launchHome: string,
  expectedSocketName: string,
): Promise<never> {
  const cleanupErrors: Error[] = [];
  try {
    child.kill("SIGTERM");
    if (!await waitForClientProcessesExit(appBundle, profile, 10_000)) {
      const survivors = listClientProcesses(appBundle, profile);
      for (const survivor of survivors) {
        try {
          process.kill(survivor.pid, "SIGKILL");
        } catch {
          // A scoped process may exit between inspection and the fallback signal.
        }
      }
      if (!await waitForClientProcessesExit(appBundle, profile, 5_000)) {
        throw new Error("Failed client launch left scoped app processes running");
      }
    }
  } catch (error) {
    cleanupErrors.push(asError(error));
  }
  try {
    if (shortHomeRoot) {
      await removeShortBlackglassHome(shortHomeRoot, launchHome, expectedSocketName);
    }
  } catch (error) {
    cleanupErrors.push(asError(error));
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [asError(primary), ...cleanupErrors],
      "Client launch failed and cleanup also reported errors",
    );
  }
  throw primary;
}

async function waitForClientProcessesExit(
  appBundle: string,
  profile: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listClientProcesses(appBundle, profile).length === 0) return true;
    await Bun.sleep(100);
  }
  return listClientProcesses(appBundle, profile).length === 0;
}

function listClientProcesses(
  appBundle: string,
  profile: string,
): Array<{ pid: number; command: string }> {
  const result = Bun.spawnSync(["/bin/ps", "-ww", "-axo", "pid=", "-o", "command="]);
  if (result.exitCode !== 0) throw new Error("Unable to inspect client process cleanup");
  const profileArgument = `--user-data-dir=${profile}`;
  return result.stdout.toString("utf8").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    return match &&
      match[2]!.startsWith(`${appBundle}/Contents/`) &&
      match[2]!.includes(profileArgument)
      ? [{ pid: Number(match[1]), command: match[2]! }]
      : [];
  });
}

function assertProfileNotInUse(appBundle: string, profile: string): void {
  const existing = listClientProcesses(appBundle, profile);
  if (existing.length !== 0) {
    throw new Error(
      "Refusing to access a profile already used by a client: " +
        existing.map((process) => `${process.pid} ${process.command}`).join("; "),
    );
  }
}

function assertNoSharedHomeBlackglassProcess(appBundle: string): void {
  const result = Bun.spawnSync(["/bin/ps", "-ww", "-axo", "pid=", "-o", "command="]);
  if (result.exitCode !== 0) throw new Error("Unable to inspect Blackglass process isolation");
  const existing = result.stdout.toString("utf8").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    return match && match[2]!.startsWith(`${appBundle}/Contents/`)
      ? [`${match[1]} ${match[2]}`]
      : [];
  });
  if (existing.length !== 0) {
    throw new Error(
      "Another Blackglass process already owns the login-home CLI socket; " +
        "use a distinct --blackglass-home: " + existing.join("; "),
    );
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseDebugPort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("--debug-port must be numeric");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("--debug-port must be between 1024 and 65535");
  }
  return port;
}

function parseDebugReadinessTimeout(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error("--debug-readiness-timeout-ms must be numeric");
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 300_000) {
    throw new Error("--debug-readiness-timeout-ms must be between 30000 and 300000");
  }
  return timeoutMs;
}

async function waitForDebugBinding(
  port: number,
  launchedPid: number,
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<{
  listenerPid: number;
  listenerCommand: string;
  targetId: string;
  targetUrl: string;
  nativeHomePath: string;
  blackglassHomePath: string;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  const failureCounts = new Map<string, number>();
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Blackglass exited before DevTools became ready: ${child.exitCode}`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`DevTools returned ${response.status}`);
        return await response.json() as Array<{
          id?: unknown;
          type?: unknown;
          url?: unknown;
          webSocketDebuggerUrl?: unknown;
        }>;
      });
      const renderers = targets.filter(
        (target) =>
          target.type === "page" &&
          typeof target.id === "string" &&
          typeof target.url === "string" &&
          target.url.includes("index.html") &&
          typeof target.webSocketDebuggerUrl === "string",
      ) as Array<{
        id: string;
        type: "page";
        url: string;
        webSocketDebuggerUrl: string;
      }>;
      if (renderers.length !== 1) {
        throw new Error(`Expected one renderer target; found ${renderers.length}`);
      }
      const listenerPid = listenerOwner(port);
      if (!isProcessOrDescendant(listenerPid, launchedPid)) {
        throw new Error(
          `DevTools listener PID ${listenerPid} is unrelated to launched PID ${launchedPid}`,
        );
      }
      const listenerCommand = processInfo(listenerPid).command;
      const runtimeHome = await readRendererRuntimeHome(
        renderers[0]!.webSocketDebuggerUrl,
      );
      return {
        listenerPid,
        listenerCommand,
        targetId: renderers[0]!.id,
        targetUrl: renderers[0]!.url,
        nativeHomePath: runtimeHome.nativeHomePath,
        blackglassHomePath: runtimeHome.blackglassHomePath,
      };
    } catch (error) {
      lastError = asError(error);
      failureCounts.set(lastError.message, (failureCounts.get(lastError.message) ?? 0) + 1);
    }
    await Bun.sleep(100);
  }
  throw new Error(
    "Timed out binding DevTools to the launched Blackglass process" +
      (failureCounts.size > 0
        ? ": " + [...failureCounts.entries()]
          .map(([message, count]) => `${message} (${count})`)
          .join("; ")
        : ""),
    { cause: lastError },
  );
}

async function readRendererRuntimeHome(webSocketDebuggerUrl: string): Promise<{
  nativeHomePath: string;
  blackglassHomePath: string;
}> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  return await new Promise((resolveRuntime, rejectRuntime) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectRuntime(new Error("Timed out reading renderer runtime environment"));
    }, 5_000);
    const finish = (
      value?: { nativeHomePath: string; blackglassHomePath: string },
      error?: Error,
    ) => {
      clearTimeout(timer);
      socket.close();
      if (error) rejectRuntime(error);
      else resolveRuntime(value!);
    };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression:
            "({nativeHomePath:process.env.HOME,blackglassHomePath:process.env.BLACKGLASS_HOME})",
          returnByValue: true,
        },
      }));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as any;
      if (message.id !== 1) return;
      const value = message.result?.result?.value;
      if (
        message.error ||
        message.result?.exceptionDetails ||
        typeof value?.nativeHomePath !== "string" ||
        typeof value?.blackglassHomePath !== "string"
      ) {
        finish(undefined, new Error("Renderer runtime environment is unavailable"));
        return;
      }
      finish({
        nativeHomePath: value.nativeHomePath,
        blackglassHomePath: value.blackglassHomePath,
      });
    });
    socket.addEventListener("error", () => {
      finish(undefined, new Error("Failed to inspect renderer runtime environment"));
    }, { once: true });
  });
}

function listenerOwner(port: number): number {
  const result = Bun.spawnSync([
    "/usr/sbin/lsof",
    "-nP",
    "-a",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-Fp",
  ]);
  if (result.exitCode !== 0) throw new Error("Unable to resolve DevTools listener owner");
  const pids = Buffer.from(result.stdout)
    .toString("utf8")
    .split("\n")
    .filter((line) => /^p\d+$/u.test(line))
    .map((line) => Number(line.slice(1)));
  if (new Set(pids).size !== 1) {
    throw new Error(`Expected one DevTools listener owner; found ${new Set(pids).size}`);
  }
  return pids[0]!;
}

function isProcessOrDescendant(candidatePid: number, ancestorPid: number): boolean {
  let current = candidatePid;
  for (let depth = 0; depth < 16; depth += 1) {
    if (current === ancestorPid) return true;
    const { parentPid } = processInfo(current);
    if (parentPid <= 1 || parentPid === current) return false;
    current = parentPid;
  }
  return false;
}

function processInfo(pid: number): { parentPid: number; command: string } {
  const result = Bun.spawnSync([
    "/bin/ps",
    "-ww",
    "-p",
    String(pid),
    "-o",
    "ppid=",
    "-o",
    "command=",
  ]);
  if (result.exitCode !== 0) throw new Error(`Unable to inspect process ${pid}`);
  const output = Buffer.from(result.stdout).toString("utf8").trim();
  const match = /^(\d+)\s+(.+)$/su.exec(output);
  if (!match) throw new Error(`Malformed process identity for ${pid}`);
  return { parentPid: Number(match[1]), command: match[2]! };
}

function plistString(infoPlist: string, key: string): string {
  const result = Bun.spawnSync([
    MACOS_PACKAGING_EXECUTABLES.plutil,
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
    "Usage: bun run tools/launch-macos.ts <patched.asar> <existing-profile> <existing-vault> " +
      "[--app <Blackglass Bridge.app>] [--replace-adapter] [--prepare-only] " +
      "[--debug-port <port> " +
      "--debug-readiness-timeout-ms <30000..300000> " +
      "--e2e-tls-metadata <metadata.json> " +
      "--identity-out <identity.json>]",
  );
  process.exit(2);
}
