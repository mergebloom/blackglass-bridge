import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import {
  inspectMacOSArtifact,
  publicMacOSArtifact,
  type MacOSArtifact,
} from "./macos-artifact";
import {
  BLACKGLASS_BUNDLE_IDENTIFIER,
  FINDER_LAUNCH_DEBUG_ADDRESS,
  FINDER_LAUNCH_LISTENER_TIMEOUT_MS,
  FINDER_LAUNCH_MINIMUM_HEALTH_MS,
  FINDER_LAUNCH_DEBUG_PORT,
  FINDER_LAUNCH_SMOKE_SCHEMA_VERSION,
  FINDER_LAUNCH_STARTER_TIMEOUT_MS,
  OBSIDIAN_BUNDLE_IDENTIFIER,
  assertMacOSLaunchPreflight,
  assertFinderLaunchSmokeEvidence,
  finderLaunchCommand,
  finderLaunchSmokeLayout,
  formatLaunchSmokeFailureMessage,
  formatStarterTargetDiagnostics,
  formatStarterTargetTimeout,
  isLoopbackTcpListenerEndpoint,
  macOSLaunchPreflightEvidence,
  macOSArtifactBindingSha256,
  parseStarterControlPost,
  parseLsofTcpListeners,
  starterSyncEntryRowIndex,
  waitForStarterSyncEntry,
  type DevToolsListenerDiagnostic,
  type DevToolsTargetDiagnostic,
  type FinderLaunchSmokeEvidence,
} from "./macos-launch-smoke";
import { readPreparedE2ERun } from "./e2e-network";
import { readVerifiedE2ETls } from "./e2e-tls";
import {
  assertNoSymlinkSegments,
  canonicalExistingPath,
  pathExists,
} from "./path-safety";
import { stableJson } from "./stable-json";

const [rootArgument, ...flags] = Bun.argv.slice(2);
if (!rootArgument || flags.length !== 0) {
  console.error("Usage: bun run tools/smoke-macos-launch.ts <prepared-E2E-run>");
  process.exit(2);
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The packaged LaunchServices smoke requires Apple Silicon macOS");
}

const run = await readPreparedE2ERun(rootArgument);
const tls = await readVerifiedE2ETls(run.root);
const layout = finderLaunchSmokeLayout(run.root);
if (await pathExists(layout.evidencePath) || await pathExists(layout.smokeRoot)) {
  throw new Error("Refusing to reuse Finder launch smoke evidence or profile data");
}
for (const identity of ["client-a-launch.json", "client-b-launch.json"]) {
  if (await Bun.file(join(run.root, identity)).exists()) {
    throw new Error("Finder launch smoke must run before packaged E2E clients");
  }
}

const recordedClientPath = await canonicalExistingPath(
  join(run.root, "client-artifact.json"),
  "Prepared client artifact",
  "file",
);
await assertNoSymlinkSegments(run.root, recordedClientPath, "Prepared client artifact");
const recordedClient = JSON.parse(await readFile(recordedClientPath, "utf8")) as MacOSArtifact;
const appPath = await canonicalExistingPath(
  recordedClient.appPath,
  "Prepared Blackglass app",
  "directory",
);
const currentClient = await inspectMacOSArtifact(appPath);
if (
  stableJson(publicMacOSArtifact(currentClient)) !==
    stableJson(publicMacOSArtifact(recordedClient))
) {
  throw new Error("Prepared Blackglass app changed before its LaunchServices smoke");
}
const executablePath = await canonicalExistingPath(
  join(appPath, "Contents/MacOS/Obsidian"),
  "Prepared Blackglass executable",
  "file",
);
const cliExecutablePath = await canonicalExistingPath(
  join(appPath, "Contents/MacOS/obsidian-cli"),
  "Prepared Blackglass CLI executable",
  "file",
);
const launchPreflight = await inspectMacOSLaunchPreflight();
assertMacOSLaunchPreflight(launchPreflight, appPath);
const launchPreflightEvidence = macOSLaunchPreflightEvidence(launchPreflight);

await mkdir(layout.smokeRoot, { recursive: false, mode: 0o700 });
await mkdir(layout.vaultPath, { recursive: true, mode: 0o700 });
await Promise.all([
  writeFile(layout.stdoutPath, "", { flag: "wx", mode: 0o600 }),
  writeFile(layout.stderrPath, "", { flag: "wx", mode: 0o600 }),
]);
const terminationHelperPath = await compileMacOSTerminationHelper(layout.smokeRoot);
if (await pathExists(layout.profilePath)) {
  throw new Error("Finder smoke profile must not exist before the no-vault launch");
}
if (await pathExists(layout.homePath)) {
  throw new Error("Finder smoke archived HOME must not exist before launch");
}
if ((await readdir(layout.vaultPath)).length !== 0) {
  throw new Error("Finder smoke vault must be empty before launch");
}
assertPortAvailable(FINDER_LAUNCH_DEBUG_PORT);
const credentialsPath = await canonicalExistingPath(
  join(run.root, "credentials.json"),
  "Prepared E2E credentials",
  "file",
);
await assertNoSymlinkSegments(run.root, credentialsPath, "Prepared E2E credentials");
const credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as {
  email?: unknown;
  password?: unknown;
};
if (
  typeof credentials.email !== "string" ||
  !credentials.email.includes("@") ||
  typeof credentials.password !== "string" ||
  credentials.password.length < 1
) {
  throw new Error("Prepared E2E credentials are malformed");
}

const realProfiles = [
  join(homedir(), "Library/Application Support/Blackglass"),
  join(homedir(), "Library/Application Support/obsidian"),
];
const realProfileFingerprintsBefore = await Promise.all(
  realProfiles.map(metadataTreeFingerprint),
);
const diagnosticBefore = await diagnosticReportSnapshot();
const baselineProcesses = listProcesses();
const baselineExactAppProcesses = exactAppProcesses(appPath, baselineProcesses);
if (baselineExactAppProcesses.length !== 0) {
  throw new Error(
    "Refusing LaunchServices smoke while the exact generated app is already running: " +
      processSummary(baselineExactAppProcesses),
  );
}
const baselineAppPids = new Set(
  baselineExactAppProcesses.map((process) => process.pid),
);

let mainPid: number | undefined;
let rendererPid: number | undefined;
let debugListenerPid: number | undefined;
let debugListenerEndpoints: string[] | undefined;
let debugTargetId: string | undefined;
let debugTargetUrl: string | undefined;
let starterControlOrigin: string | undefined;
let starterControlRequests: FinderLaunchSmokeEvidence["starterControlRequests"] | undefined;
let runtimeHomeObserved = false;
let launchHomeRoot: string | undefined;
let launchHomePath: string | undefined;
let launchProfilePath: string | undefined;
let launchCommand: string[] | undefined;
let launchAttempted = false;
let cliSocketAddress: string | undefined;
let cliSocketRemoved = false;
let profileSingletonArtifactsRemoved = false;
let launchHomeSameDeviceAsArchive = false;
let launchHomeRelocatedToRun = false;
let launchHomeRootRemoved = false;
let cliForwardedResponse: FinderLaunchSmokeEvidence["cliForwardedResponse"] | undefined;
let healthStartedAt: string | undefined;
let healthyAt: string | undefined;
let healthyForMs: number | undefined;
let rendererStableDuringHealth = false;
let primarySmokeError: unknown;
let smokeFailed = false;
let terminationEvidence:
  | {
      mechanism: "NSRunningApplication.terminate";
      accepted: true;
      signalFallbackUsed: false;
      forcedTerminationUsed: false;
    }
  | undefined;
const startedAt = new Date().toISOString();
try {
  launchHomeRoot = await mkdtemp("/private/tmp/blackglass-launch-");
  const launchHomeRootStat = await lstat(launchHomeRoot);
  if (
    !launchHomeRootStat.isDirectory() ||
    launchHomeRootStat.isSymbolicLink() ||
    (launchHomeRootStat.mode & 0o777) !== 0o700 ||
    launchHomeRootStat.uid !== process.getuid!()
  ) {
    throw new Error("Short LaunchServices HOME root is not a private real directory");
  }
  launchHomePath = join(launchHomeRoot, "h");
  await mkdir(launchHomePath, { recursive: false, mode: 0o700 });
  const launchHomeStat = await lstat(launchHomePath);
  if (
    !launchHomeStat.isDirectory() ||
    launchHomeStat.isSymbolicLink() ||
    (launchHomeStat.mode & 0o777) !== 0o700 ||
    launchHomeStat.uid !== process.getuid!()
  ) {
    throw new Error("Short LaunchServices HOME is not a private real directory");
  }
  const archiveRootStat = await stat(layout.smokeRoot);
  if (launchHomeRootStat.dev !== archiveRootStat.dev) {
    throw new Error("Short LaunchServices HOME cannot be moved into the disposable run");
  }
  launchHomeSameDeviceAsArchive = true;
  launchProfilePath = join(
    launchHomePath,
    "Library/Application Support/Blackglass",
  );
  cliSocketAddress = join(launchHomePath, currentClient.cliSocketName);
  if (Buffer.byteLength(cliSocketAddress, "utf8") > 103) {
    throw new Error("Packaged CLI socket address exceeds the macOS Unix-socket limit");
  }
  launchCommand = finderLaunchCommand({
    appPath,
    blackglassHomePath: launchHomePath,
    stdoutPath: layout.stdoutPath,
    stderrPath: layout.stderrPath,
    debugPort: FINDER_LAUNCH_DEBUG_PORT,
    chromiumHostResolverRules: tls.metadata.chromiumHostResolverRules,
    tlsSpkiSha256Base64: tls.metadata.spkiSha256Base64,
  });
  launchAttempted = true;
  const opened = Bun.spawnSync(launchCommand, { stdout: "pipe", stderr: "pipe" });
  if (opened.exitCode !== 0) {
    throw new Error(
      `LaunchServices refused the exact packaged app: ${opened.stderr.toString().trim()}`,
    );
  }
  mainPid = await waitForMainProcess(
    executablePath,
    baselineAppPids,
    FINDER_LAUNCH_DEBUG_PORT,
    15_000,
  );
  const debugListener = await waitForDebugListener(
    FINDER_LAUNCH_DEBUG_PORT,
    mainPid,
    appPath,
    FINDER_LAUNCH_LISTENER_TIMEOUT_MS,
  );
  debugListenerPid = debugListener.pid;
  debugListenerEndpoints = debugListener.endpoints;
  const target = await waitForStarterTarget(
    FINDER_LAUNCH_DEBUG_PORT,
    mainPid,
    appPath,
    FINDER_LAUNCH_STARTER_TIMEOUT_MS,
  );
  debugTargetId = target.id;
  debugTargetUrl = target.url;
  const starterProof = await exerciseStarterControlFlow({
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    controlOrigin: run.manifest.endpoints.controlOrigin,
    email: credentials.email,
    password: credentials.password,
    blackglassHomePath: launchHomePath,
    nativeHomePath: homedir(),
  });
  starterControlOrigin = starterProof.controlOrigin;
  starterControlRequests = starterProof.requests;
  runtimeHomeObserved = starterProof.runtimeHomeObserved;
  const healthRenderer = rendererDescendant(mainPid, appPath);
  if (!healthRenderer) {
    throw new Error("Starter readiness did not leave a renderer process to observe");
  }
  rendererPid = healthRenderer.pid;
  const healthStartedAtMs = Date.now();
  healthStartedAt = new Date(healthStartedAtMs).toISOString();
  const healthDeadline = healthStartedAtMs + FINDER_LAUNCH_MINIMUM_HEALTH_MS;
  while (Date.now() < healthDeadline) {
    assertProcessAlive(mainPid, "LaunchServices main process");
    const renderer = rendererDescendant(mainPid, appPath);
    if (!renderer || renderer.pid !== rendererPid) {
      throw new Error(
        "LaunchServices starter renderer did not remain stable throughout the health interval",
      );
    }
    await Bun.sleep(200);
  }
  assertProcessAlive(mainPid, "LaunchServices main process");
  const finalRenderer = rendererDescendant(mainPid, appPath);
  if (!finalRenderer || finalRenderer.pid !== rendererPid) {
    throw new Error(
      "LaunchServices starter renderer did not survive the complete health interval",
    );
  }
  rendererStableDuringHealth = true;
  const healthyAtMs = Date.now();
  healthyAt = new Date(healthyAtMs).toISOString();
  healthyForMs = healthyAtMs - healthStartedAtMs;
  for (const marker of ["obsidian.log", "id"]) {
    const path = join(launchProfilePath, marker);
    if (!(await Bun.file(path).exists()) || !(await lstat(path)).isFile()) {
      throw new Error(`LaunchServices default profile did not create ${marker}`);
    }
  }
  const profileStat = await lstat(launchProfilePath);
  if (
    profileStat.isSymbolicLink() ||
    !profileStat.isDirectory() ||
    (profileStat.mode & 0o777) !== 0o700
  ) {
    throw new Error("LaunchServices default profile is not a real mode-0700 directory");
  }
  if (!processUsesPath(mainPid, launchProfilePath)) {
    throw new Error("LaunchServices process tree did not open the disposable default profile");
  }
  if (await registeredVaultCount(launchProfilePath) !== 0) {
    throw new Error("No-vault starter smoke unexpectedly registered a local vault");
  }
  if ((await readdir(layout.vaultPath)).length !== 0) {
    throw new Error("No-vault starter smoke unexpectedly wrote to its disposable vault");
  }
  const cliProof = await exercisePackagedCli({
    cliExecutablePath,
    homePath: launchHomePath,
    socketName: currentClient.cliSocketName,
    mainStdoutPath: layout.stdoutPath,
  });
  if (cliProof.socketAddress !== cliSocketAddress) {
    throw new Error("Packaged CLI used an unexpected socket address");
  }
  cliForwardedResponse = cliProof.response;
} catch (error) {
  smokeFailed = true;
  try {
    const crashReports = await newDiagnosticReports(
      diagnosticBefore,
      appPath,
      launchHomePath,
    );
    primarySmokeError = crashReports.length > 0
      ? new Error(
        `${String(error)}; matching macOS crash reports: ${crashReports.map((path) => basename(path)).join(", ")}`,
      )
      : error;
  } catch (diagnosticError) {
    primarySmokeError = new AggregateError(
      [asError(error), asError(diagnosticError)],
      "LaunchServices smoke failed and crash-report inspection also failed",
    );
  }
} finally {
  const cleanupErrors: Error[] = [];
  try {
    if (launchAttempted) {
      terminationEvidence = await terminateNewAppProcessTree(
        appPath,
        baselineAppPids,
        mainPid,
        terminationHelperPath,
      );
    }
  } catch (cleanupError) {
    cleanupErrors.push(
      new Error(`Native app termination failed: ${asError(cleanupError).message}`, {
        cause: cleanupError,
      }),
    );
  }
  try {
    if (cliSocketAddress) {
      await assertPathsAbsent(
        [cliSocketAddress],
        "Packaged CLI socket remained after graceful shutdown",
      );
      cliSocketRemoved = true;
    }
  } catch (cleanupError) {
    cleanupErrors.push(
      new Error(`CLI socket cleanup check failed: ${asError(cleanupError).message}`, {
        cause: cleanupError,
      }),
    );
  }
  try {
    if (launchProfilePath && await pathExists(launchProfilePath)) {
      await assertPathsAbsent(
        ["SingletonLock", "SingletonSocket", "SingletonCookie"].map((name) =>
          join(launchProfilePath!, name)
        ),
        "Packaged profile singleton artifact remained after graceful shutdown",
      );
      profileSingletonArtifactsRemoved = true;
    }
  } catch (cleanupError) {
    cleanupErrors.push(
      new Error(`Profile singleton cleanup check failed: ${asError(cleanupError).message}`, {
        cause: cleanupError,
      }),
    );
  }
  try {
    if (launchHomeRoot) {
      const survivingProcesses = exactNewAppProcesses(appPath, baselineAppPids);
      if (survivingProcesses.length > 0) {
        throw new Error(
          `Refusing to archive ${launchHomeRoot} while packaged app processes remain: ` +
            processSummary(survivingProcesses),
        );
      }
      await archiveLaunchHome(
        launchHomeRoot,
        launchHomePath,
        layout.smokeRoot,
        layout.homePath,
      );
      launchHomeRelocatedToRun = true;
      launchHomeRootRemoved = true;
    }
  } catch (cleanupError) {
    cleanupErrors.push(
      new Error(`Disposable HOME archival failed: ${asError(cleanupError).message}`, {
        cause: cleanupError,
      }),
    );
  }
  if (smokeFailed) {
    const primaryError = asError(primarySmokeError);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        formatLaunchSmokeFailureMessage(
          primaryError.message,
          cleanupErrors.map((error) => error.message),
        ),
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `LaunchServices smoke cleanup failed: ${cleanupErrors.map((error) => error.message).join(" | ")}`,
    );
  }
}

if (
  mainPid === undefined ||
  rendererPid === undefined ||
  debugListenerPid === undefined ||
  debugListenerEndpoints === undefined ||
  debugTargetId === undefined ||
  debugTargetUrl === undefined ||
  starterControlOrigin === undefined ||
  starterControlRequests === undefined ||
  runtimeHomeObserved !== true ||
  launchHomePath === undefined ||
  launchProfilePath === undefined ||
  launchCommand === undefined ||
  cliSocketAddress === undefined ||
  cliSocketRemoved !== true ||
  profileSingletonArtifactsRemoved !== true ||
  launchHomeSameDeviceAsArchive !== true ||
  launchHomeRelocatedToRun !== true ||
  launchHomeRootRemoved !== true ||
  cliForwardedResponse === undefined ||
  healthStartedAt === undefined ||
  healthyAt === undefined ||
  healthyForMs === undefined ||
  rendererStableDuringHealth !== true ||
  terminationEvidence === undefined
) {
  throw new Error("Finder launch smoke did not collect complete no-vault evidence");
}
await Bun.sleep(1_500);
const crashReports = await newDiagnosticReports(diagnosticBefore, appPath);
if (crashReports.length > 0) {
  throw new Error(
    `LaunchServices startup created macOS crash reports: ${crashReports.map((path) => basename(path)).join(", ")}`,
  );
}
const [realProfileFingerprintsAfter, finalClient] = await Promise.all([
  Promise.all(realProfiles.map(metadataTreeFingerprint)),
  inspectMacOSArtifact(appPath),
]);
if (stableJson(realProfileFingerprintsAfter) !== stableJson(realProfileFingerprintsBefore)) {
  throw new Error("LaunchServices smoke changed a real Obsidian or Blackglass profile");
}
if (
  stableJson(publicMacOSArtifact(finalClient)) !==
    stableJson(publicMacOSArtifact(recordedClient))
) {
  throw new Error("Packaged app changed during its LaunchServices smoke");
}

const artifact = publicMacOSArtifact(recordedClient);
const evidence: FinderLaunchSmokeEvidence = {
  schemaVersion: FINDER_LAUNCH_SMOKE_SCHEMA_VERSION,
  passed: true,
  platform: "macOS Apple Silicon",
  mechanism: "LaunchServices open -n -a",
  runManifestSha256: run.manifestSha256,
  releaseManifestSha256: run.manifest.releaseManifestSha256,
  appArtifactSha256: macOSArtifactBindingSha256(artifact),
  applicationTreeSha256: artifact.applicationTreeSha256,
  executableSha256: artifact.executableSha256,
  embeddedAsarSha256: artifact.embeddedAsarSha256,
  tlsMetadataSha256: tls.metadataSha256,
  tlsSpkiSha256Base64: tls.metadata.spkiSha256Base64,
  chromiumHostResolverRules: tls.metadata.chromiumHostResolverRules,
  appPath,
  executablePath,
  launchHomePath,
  launchHomeRootMode: 0o700,
  launchHomeSameDeviceAsArchive: true,
  launchHomeRelocatedToRun: true,
  launchHomeRootRemoved: true,
  cliExecutablePath,
  cliExecutableSha256: artifact.cliExecutableSha256,
  cliSocketAddress,
  cliSocketName: artifact.cliSocketName,
  homePath: layout.homePath,
  profilePath: layout.profilePath,
  vaultPath: layout.vaultPath,
  launchCommand,
  debugPort: FINDER_LAUNCH_DEBUG_PORT,
  debugAddress: FINDER_LAUNCH_DEBUG_ADDRESS,
  debugListenerPid,
  debugListenerEndpoints,
  debugTargetId,
  debugTargetUrl,
  startedAt,
  healthStartedAt,
  healthyAt,
  completedAt: new Date().toISOString(),
  mainPid,
  rendererPid,
  rendererStableDuringHealth: true,
  healthyForMs,
  defaultProfilePathObserved: true,
  profileMode: 0o700,
  profileRealDirectoryObserved: true,
  profileActivityObserved: true,
  profileSingletonArtifactsRemoved: true,
  blackglassHomeEnvironment: BLACKGLASS_HOME_ENVIRONMENT,
  blackglassHomeEnvironmentObserved: true,
  nativeHomePath: homedir(),
  nativeHomeEnvironmentPreserved: true,
  cliSocketObserved: true,
  cliSocketRemoved: true,
  upstreamCliSocketAbsent: true,
  cliForwardedCommandSucceeded: true,
  cliForwardedResponse,
  cliMainProcessReceiptObserved: true,
  explicitUserDataDirUsed: false,
  noLocalVaultAtLaunch: true,
  starterPageObserved: true,
  starterNativeUiExercised: true,
  starterControlOrigin,
  starterControlOriginMatched: true,
  starterControlRequests,
  starterSignInSucceeded: true,
  starterVaultListSucceeded: true,
  noVaultRegisteredAfterLaunch: true,
  disposableVaultStayedEmpty: true,
  launchPreflight: launchPreflightEvidence,
  earlyExit: false,
  diagnosticReportsChecked: true,
  crashReportsCreated: 0,
  realProfilesUnchanged: true,
  terminationMechanism: terminationEvidence.mechanism,
  nativeTerminationAccepted: terminationEvidence.accepted,
  signalFallbackUsed: terminationEvidence.signalFallbackUsed,
  forcedTerminationUsed: terminationEvidence.forcedTerminationUsed,
  terminatedCleanly: true,
};
assertFinderLaunchSmokeEvidence(evidence, {
  root: run.root,
  runManifestSha256: run.manifestSha256,
  releaseManifestSha256: run.manifest.releaseManifestSha256,
  appPath,
  artifact,
  controlOrigin: run.manifest.endpoints.controlOrigin,
  tlsMetadataSha256: tls.metadataSha256,
  chromiumHostResolverRules: tls.metadata.chromiumHostResolverRules,
  tlsSpkiSha256Base64: tls.metadata.spkiSha256Base64,
  nativeHomePath: homedir(),
});
await writeFile(layout.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify(evidence, null, 2));

async function exercisePackagedCli(input: {
  cliExecutablePath: string;
  homePath: string;
  socketName: string;
  mainStdoutPath: string;
}): Promise<{
  socketAddress: string;
  response: "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.";
}> {
  const socketAddress = join(input.homePath, input.socketName);
  const socketStat = await lstat(socketAddress).catch(() => undefined);
  if (!socketStat?.isSocket()) {
    throw new Error(`Packaged main process did not create CLI socket ${socketAddress}`);
  }
  const upstreamSocketPath = join(input.homePath, ".obsidian-cli.sock");
  if (await pathExists(upstreamSocketPath)) {
    throw new Error("Packaged main process created the upstream Obsidian CLI socket");
  }

  const forwardedCommand = "blackglass-smoke-probe";
  const cliEnvironment: Record<string, string | undefined> = {
    ...process.env,
    HOME: input.homePath,
  };
  delete cliEnvironment[BLACKGLASS_HOME_ENVIRONMENT];
  const child = Bun.spawn([input.cliExecutablePath, forwardedCommand], {
    env: cliEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("cli-timeout");
  const result = await Promise.race([
    child.exited,
    new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => resolve(timedOut), 5_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (result === timedOut) {
    child.kill();
    await child.exited;
    throw new Error("Packaged CLI forwarded-command handshake timed out");
  }
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (result !== 0) {
    throw new Error(
      `Packaged CLI forwarded command failed with exit ${result}: ${stderr.trim()}`,
    );
  }
  const response =
    "Command line interface is not enabled. Please turn it on in Settings > General > Advanced." as const;
  if (stdout.trim() !== response) {
    throw new Error("Packaged CLI forwarded command returned unexpected output");
  }
  const receiptDeadline = Date.now() + 2_000;
  while (Date.now() < receiptDeadline) {
    const mainOutput = await readFile(input.mainStdoutPath, "utf8");
    if (
      mainOutput.includes("Received command line") &&
      mainOutput.includes(forwardedCommand)
    ) {
      return { socketAddress, response };
    }
    await Bun.sleep(50);
  }
  throw new Error("Packaged main process did not log the forwarded CLI command");
}

async function archiveLaunchHome(
  launchHomeRoot: string,
  launchHomePath: string | undefined,
  archiveRoot: string,
  archiveHomePath: string,
): Promise<void> {
  if (
    !/^\/private\/tmp\/blackglass-launch-[A-Za-z0-9]{6}$/u.test(launchHomeRoot) ||
    launchHomePath !== join(launchHomeRoot, "h") ||
    archiveHomePath !== join(archiveRoot, "home")
  ) {
    throw new Error("Refusing to archive an unrecognized LaunchServices HOME");
  }
  const rootStat = await lstat(launchHomeRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    rootStat.uid !== process.getuid!()
  ) {
    throw new Error("Refusing to archive a changed LaunchServices HOME root");
  }
  const archiveRootStat = await lstat(archiveRoot);
  if (
    !archiveRootStat.isDirectory() ||
    archiveRootStat.isSymbolicLink() ||
    archiveRootStat.uid !== process.getuid!() ||
    rootStat.dev !== archiveRootStat.dev
  ) {
    throw new Error("Refusing to move LaunchServices HOME across filesystems");
  }
  const entries = await readdir(launchHomeRoot);
  if (entries.length !== 1 || entries[0] !== "h") {
    throw new Error("Refusing to archive a LaunchServices HOME root with unexpected entries");
  }
  const homeStat = await lstat(launchHomePath);
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    (homeStat.mode & 0o777) !== 0o700 ||
    homeStat.uid !== process.getuid!()
  ) {
    throw new Error("Refusing to archive a changed LaunchServices HOME");
  }
  if (await pathExists(archiveHomePath)) {
    throw new Error("Refusing to overwrite archived LaunchServices HOME evidence");
  }
  await rename(launchHomePath, archiveHomePath);
  const archivedHomeStat = await lstat(archiveHomePath);
  if (
    !archivedHomeStat.isDirectory() ||
    archivedHomeStat.isSymbolicLink() ||
    (archivedHomeStat.mode & 0o777) !== 0o700 ||
    archivedHomeStat.uid !== process.getuid!()
  ) {
    throw new Error("Archived LaunchServices HOME is not a private real directory");
  }
  if ((await readdir(launchHomeRoot)).length !== 0) {
    throw new Error("LaunchServices HOME root was not empty after archival");
  }
  await rmdir(launchHomeRoot);
  if (await pathExists(launchHomeRoot)) {
    throw new Error("Short LaunchServices HOME root was not removed");
  }
}

async function assertPathsAbsent(paths: string[], message: string): Promise<void> {
  for (const path of new Set(paths)) {
    if (await pathExists(path)) throw new Error(`${message}: ${path}`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertPortAvailable(port: number): void {
  const result = Bun.spawnSync([
    "/usr/sbin/lsof",
    "-nP",
    "-a",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-Fp",
  ]);
  const listeners = result.stdout.toString().split("\n").filter((line) => /^p\d+$/u.test(line));
  if (listeners.length > 0) {
    throw new Error(`Finder launch debugging port ${port} is already in use`);
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`Unable to prove debugging port ${port} is available`);
  }
}

interface StarterTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function waitForStarterTarget(
  port: number,
  mainPid: number,
  appPath: string,
  timeoutMs: number,
): Promise<StarterTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastCdpError: string | undefined;
  let lastTargets: DevToolsTargetDiagnostic[] = [];
  while (Date.now() < deadline) {
    assertProcessAlive(mainPid, "LaunchServices main process");
    try {
      const value = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`DevTools returned ${response.status}`);
        return await response.json() as unknown;
      });
      if (!Array.isArray(value)) throw new Error("DevTools target list is not an array");
      if (value.some((target) => !target || typeof target !== "object" || Array.isArray(target))) {
        throw new Error("DevTools target list contains a malformed entry");
      }
      const targets = value as Array<Record<string, unknown>>;
      lastCdpError = undefined;
      lastTargets = targets.map((target) => ({
        id: typeof target.id === "string" ? target.id : null,
        type: typeof target.type === "string" ? target.type : null,
        url: typeof target.url === "string" ? target.url : null,
        hasWebSocketDebuggerUrl: typeof target.webSocketDebuggerUrl === "string",
      }));
      const starterTargets = targets.filter(
        (target) =>
          target.type === "page" &&
          typeof target.url === "string" &&
          target.url.includes("starter.html") &&
          typeof target.id === "string" &&
          typeof target.webSocketDebuggerUrl === "string",
      );
      if (starterTargets.length > 1) {
        throw new Error("No-vault launch created more than one starter renderer");
      }
      const target = starterTargets[0];
      if (target) {
        const processes = listProcesses();
        if (!processes.some(
          (process) =>
            process.command.includes(appPath) &&
            process.command.includes("--type=renderer") &&
            isDescendant(process.pid, mainPid, processes),
        )) {
          throw new Error("Starter DevTools target is not backed by the launched app");
        }
        return {
          id: target.id as string,
          url: target.url as string,
          webSocketDebuggerUrl: target.webSocketDebuggerUrl as string,
        };
      }
    } catch (error) {
      const cdpError = asError(error);
      if (
        cdpError.message.includes("more than one") ||
        cdpError.message.includes("not backed")
      ) {
        throw new Error(
          `${cdpError.message}; diagnostics: ` +
            formatStarterTargetDiagnostics({
              port,
              mainPid,
              lastCdpError: cdpError.message,
              lastTargets,
              processes: launchedAppProcessDiagnostics(mainPid, appPath),
            }),
          { cause: cdpError },
        );
      }
      lastCdpError = cdpError.message;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    formatStarterTargetTimeout({
      timeoutMs,
      port,
      mainPid,
      lastCdpError,
      lastTargets,
      processes: launchedAppProcessDiagnostics(mainPid, appPath),
    }),
  );
}

async function waitForDebugListener(
  port: number,
  mainPid: number,
  appPath: string,
  timeoutMs: number,
): Promise<{ pid: number; endpoints: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let lastListeners: DevToolsListenerDiagnostic[] = [];
  while (Date.now() < deadline) {
    assertProcessAlive(mainPid, "LaunchServices main process");
    const result = Bun.spawnSync([
      "/usr/sbin/lsof",
      "-nP",
      "-a",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fpn",
    ]);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(
        `Unable to inspect Finder launch debugging port ${port}: ` +
          result.stderr.toString("utf8").trim(),
      );
    }
    lastListeners = parseLsofTcpListeners(result.stdout.toString());
    const processes = listProcesses();
    const ownedListeners = lastListeners.filter((listener) => {
      const process = processes.find((candidate) => candidate.pid === listener.pid);
      return Boolean(
        process &&
        process.command.includes(appPath) &&
        isDescendant(listener.pid, mainPid, processes),
      );
    });
    const unsafeEndpoints = ownedListeners.filter(
      (listener) => !isLoopbackTcpListenerEndpoint(listener.endpoint, port),
    );
    if (unsafeEndpoints.length > 0) {
      throw new Error(
        `The exact launched app exposed its DevTools listener beyond loopback: ` +
          stableJson(unsafeEndpoints),
      );
    }
    const boundPids = [...new Set(ownedListeners.map((listener) => listener.pid))];
    if (boundPids.length === 1 && ownedListeners.length > 0) {
      return {
        pid: boundPids[0]!,
        endpoints: [...new Set(ownedListeners.map((listener) => listener.endpoint))]
          .sort(compareStrings),
      };
    }
    if (boundPids.length > 1) {
      throw new Error("More than one launched app process owns the smoke debugging port");
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `The exact launched app did not own its DevTools listener within ${timeoutMs}ms; ` +
      `port=${port}; mainPid=${mainPid}; observedListeners=${stableJson(lastListeners)}; ` +
      `launchedProcesses=${stableJson(launchedAppProcessDiagnostics(mainPid, appPath))}`,
  );
}

function launchedAppProcessDiagnostics(mainPid: number, appPath: string): string[] {
  try {
    const processes = listProcesses();
    return processes
      .filter((process) =>
        process.command.includes(appPath) &&
        (process.pid === mainPid || isDescendant(process.pid, mainPid, processes))
      )
      .map((process) => `${process.pid} ppid=${process.parentPid} ${process.command}`);
  } catch (error) {
    return [`process inspection failed: ${asError(error).message}`];
  }
}

async function exerciseStarterControlFlow(input: {
  webSocketDebuggerUrl: string;
  controlOrigin: string;
  email: string;
  password: string;
  blackglassHomePath: string;
  nativeHomePath: string;
}): Promise<{
  controlOrigin: string;
  requests: FinderLaunchSmokeEvidence["starterControlRequests"];
  runtimeHomeObserved: true;
}> {
  const socket = new WebSocket(input.webSocketDebuggerUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(
      () => rejectOpen(new Error("Timed out opening starter DevTools target")),
      5_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectOpen(new Error("Failed to open starter DevTools target"));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: Timer }
  >();
  const requests = new Map<
    string,
    { method: string; origin: string; path: string; status?: number }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as any;
    if (Number.isSafeInteger(message.id)) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error("DevTools command failed"));
      else request.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (message.method === "Network.requestWillBeSent") {
      // Chromium may emit a CORS OPTIONS preflight for these JSON requests.
      // The release claim is bound to the starter renderer's two control
      // operations, so count their POSTs without treating preflights as
      // duplicated application requests.
      const request = parseStarterControlPost(params.request);
      if (request) requests.set(String(params.requestId), request);
    } else if (message.method === "Network.responseReceived") {
      const request = requests.get(String(params.requestId));
      if (request) request.status = Number(params.response?.status);
    }
  });

  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCommand(new Error(`Timed out waiting for DevTools ${method}`));
      }, 10_000);
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  try {
    await send("Network.enable");
    const evaluate = async (expression: string): Promise<unknown> => {
      const evaluated = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (evaluated?.exceptionDetails) {
        throw new Error("Native starter UI evaluation failed");
      }
      return evaluated?.result?.value;
    };
    const runtimeHome = await evaluate(
      "({nativeHomePath:process.env.HOME,blackglassHomePath:process.env.BLACKGLASS_HOME})",
    );
    if (
      !runtimeHome ||
      typeof runtimeHome !== "object" ||
      (runtimeHome as any).nativeHomePath !== input.nativeHomePath ||
      (runtimeHome as any).blackglassHomePath !== input.blackglassHomePath ||
      (runtimeHome as any).nativeHomePath === (runtimeHome as any).blackglassHomePath
    ) {
      throw new Error(
        "Native starter did not preserve HOME while using the isolated BLACKGLASS_HOME",
      );
    }
    await waitForStarterSyncEntry(async () => {
      const snapshot = await evaluate(`(()=>{
      const rows=[...document.querySelectorAll(".open-vault-options.mod-open-vault .setting-item")];
      return {
        opened:false,
        href:location.href,
        readyState:document.readyState,
        rows:rows.slice(0,16).map((row)=>({
          name:row.querySelector(".setting-item-name")?.textContent?.trim()??null,
          button:row.querySelector("button")?.textContent?.trim()??null,
        })),
      };
      })()`);
      const rowIndex = starterSyncEntryRowIndex(snapshot);
      if (rowIndex === undefined) return snapshot;
      const opened = await evaluate(`(()=>{
        const rows=[...document.querySelectorAll(".open-vault-options.mod-open-vault .setting-item")];
        const button=rows[${rowIndex}]?.querySelector("button");
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      return { ...(snapshot as object), opened: opened === true };
    });

    const loginDeadline = Date.now() + 5_000;
    while (Date.now() < loginDeadline) {
      const ready = await evaluate(`(()=>{
        const panel=document.querySelector(".open-vault-options.mod-login");
        if (!(panel instanceof HTMLElement) || panel.offsetParent===null) return false;
        return Boolean(panel.querySelector('input[type="password"]'));
      })()`);
      if (ready === true) break;
      await Bun.sleep(100);
    }
    const submitted = await evaluate(`(()=>{
      const panel=document.querySelector(".open-vault-options.mod-login");
      if (!(panel instanceof HTMLElement) || panel.offsetParent===null) return false;
      const email=panel.querySelector('input[type="text"]:not([maxlength="6"])');
      const password=panel.querySelector('input[type="password"]');
      const submit=panel.querySelector("button.mod-cta");
      if (!(email instanceof HTMLInputElement) || !(password instanceof HTMLInputElement) || !(submit instanceof HTMLButtonElement)) return false;
      const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
      if (!setValue) return false;
      setValue.call(email,${JSON.stringify(input.email)});
      email.dispatchEvent(new Event("input",{bubbles:true}));
      email.dispatchEvent(new Event("change",{bubbles:true}));
      setValue.call(password,${JSON.stringify(input.password)});
      password.dispatchEvent(new Event("input",{bubbles:true}));
      password.dispatchEvent(new Event("change",{bubbles:true}));
      submit.click();
      return true;
    })()`);
    if (submitted !== true) {
      throw new Error("Native starter Sync credentials could not be submitted");
    }

    const responseDeadline = Date.now() + 15_000;
    while (Date.now() < responseDeadline) {
      const observed = ["/user/signin", "/vault/list"].every((path) => {
        const matches = [...requests.values()].filter((request) => request.path === path);
        return matches.length === 1 && Number.isSafeInteger(matches[0]?.status);
      });
      if (observed) break;
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Starter renderer closed before its control responses arrived");
      }
      await Bun.sleep(100);
    }
    const ordered = ["/user/signin", "/vault/list"].map((path) =>
      [...requests.values()].filter((request) => request.path === path)
    );
    if (ordered.some((matches) => matches.length !== 1)) {
      const uiState = await evaluate(`({
        href:location.href,
        text:document.body?.innerText?.slice(0,1000)??"",
      })`);
      throw new Error(
        "Native starter control requests were missing or duplicated: " +
          JSON.stringify({ requests: [...requests.values()], uiState }),
      );
    }
    const evidenceRequests = ordered.map(([request], index) => {
      const status = request?.status;
      if (
        !request ||
        request.method !== "POST" ||
        request.origin !== input.controlOrigin ||
        !Number.isSafeInteger(status) ||
        status! < 200 ||
        status! >= 300
      ) {
        throw new Error("Native starter control request did not succeed at the configured origin");
      }
      return {
        method: "POST" as const,
        origin: request.origin,
        path: (["/user/signin", "/vault/list"] as const)[index]!,
        status: status!,
      };
    });
    return {
      controlOrigin: evidenceRequests[0]!.origin,
      requests: evidenceRequests,
      runtimeHomeObserved: true,
    };
  } finally {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Starter DevTools target closed"));
    }
    pending.clear();
    socket.close();
  }
}

async function registeredVaultCount(profilePath: string): Promise<number> {
  const configPath = join(profilePath, "obsidian.json");
  if (!(await Bun.file(configPath).exists())) return 0;
  const value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("No-vault profile configuration is malformed");
  }
  const vaults = (value as Record<string, unknown>).vaults;
  if (vaults === undefined) return 0;
  if (!vaults || typeof vaults !== "object" || Array.isArray(vaults)) {
    throw new Error("No-vault profile vault registry is malformed");
  }
  return Object.keys(vaults).length;
}

interface ProcessRow {
  pid: number;
  parentPid: number;
  command: string;
}

function listProcesses(): ProcessRow[] {
  const result = Bun.spawnSync([
    "/bin/ps",
    "-ww",
    "-axo",
    "pid=",
    "-o",
    "ppid=",
    "-o",
    "command=",
  ]);
  if (result.exitCode !== 0) throw new Error("Unable to inspect macOS process table");
  return result.stdout.toString().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match
      ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }]
      : [];
  });
}

async function waitForMainProcess(
  executablePath: string,
  baselinePids: Set<number>,
  debugPort: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = listProcesses().filter(
      (process) =>
        !baselinePids.has(process.pid) &&
        process.command.startsWith(`${executablePath} `) &&
        process.command.includes(`--remote-debugging-port=${debugPort}`),
    );
    if (candidates.length === 1) return candidates[0]!.pid;
    if (candidates.length > 1) {
      throw new Error("LaunchServices created more than one new packaged-app main process");
    }
    await Bun.sleep(100);
  }
  throw new Error("LaunchServices did not create the packaged-app main process");
}

function rendererDescendant(mainPid: number, appPath: string): ProcessRow | undefined {
  const processes = listProcesses();
  return processes.find(
    (process) =>
      process.command.includes(appPath) &&
      process.command.includes("--type=renderer") &&
      isDescendant(process.pid, mainPid, processes),
  );
}

function isDescendant(pid: number, ancestorPid: number, processes: ProcessRow[]): boolean {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  let current = pid;
  for (let depth = 0; depth < 32; depth += 1) {
    if (current === ancestorPid) return true;
    const process = byPid.get(current);
    if (!process || process.parentPid <= 1 || process.parentPid === current) return false;
    current = process.parentPid;
  }
  return false;
}

function assertProcessAlive(pid: number, label: string): void {
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`${label} ${pid} exited during the startup health interval`);
  }
}

function processUsesPath(mainPid: number, path: string): boolean {
  const processes = listProcesses();
  const pids = processes
    .filter((process) => isDescendant(process.pid, mainPid, processes))
    .map((process) => String(process.pid));
  if (pids.length === 0) return false;
  const result = Bun.spawnSync(["/usr/sbin/lsof", "-Fn", "-p", pids.join(",")]);
  if (result.exitCode !== 0) return false;
  const prefix = `n${path}/`;
  return result.stdout.toString().split("\n").some((line) => line.startsWith(prefix));
}

async function inspectMacOSLaunchPreflight(): Promise<unknown> {
  const helperRoot = await mkdtemp("/private/tmp/blackglass-preflight-");
  const helperPath = join(helperRoot, "macos-launch-preflight");
  let snapshot: unknown;
  let primaryError: Error | undefined;
  try {
    const helperRootStat = await lstat(helperRoot);
    if (
      !helperRootStat.isDirectory() ||
      helperRootStat.isSymbolicLink() ||
      (helperRootStat.mode & 0o777) !== 0o700 ||
      helperRootStat.uid !== process.getuid!()
    ) {
      throw new Error("Disposable macOS launch preflight directory is not private");
    }
    const source = resolve(import.meta.dir, "macos-launch-preflight.m");
    const compiled = Bun.spawnSync([
      "/usr/bin/xcrun",
      "clang",
      "-fobjc-arc",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-framework",
      "AppKit",
      "-framework",
      "CoreGraphics",
      source,
      "-o",
      helperPath,
    ], { stdout: "pipe", stderr: "pipe" });
    if (compiled.exitCode !== 0) {
      throw new Error(
        `Unable to compile macOS launch preflight helper: ${compiled.stderr.toString("utf8").trim()}`,
      );
    }
    const helperStat = await lstat(helperPath);
    if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
      throw new Error("Compiled macOS launch preflight helper is not a real file");
    }
    const inspected = Bun.spawnSync(
      [
        helperPath,
        BLACKGLASS_BUNDLE_IDENTIFIER,
        OBSIDIAN_BUNDLE_IDENTIFIER,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (inspected.exitCode !== 0) {
      throw new Error(
        `Unable to inspect macOS launch preflight state (exit ${inspected.exitCode}): ` +
          inspected.stderr.toString("utf8").trim(),
      );
    }
    try {
      snapshot = JSON.parse(inspected.stdout.toString("utf8")) as unknown;
    } catch (error) {
      throw new Error(`macOS launch preflight returned malformed JSON: ${asError(error).message}`);
    }
  } catch (error) {
    primaryError = asError(error);
  }

  const cleanupErrors: Error[] = [];
  try {
    if (await pathExists(helperPath)) await unlink(helperPath);
  } catch (error) {
    cleanupErrors.push(new Error(`Unable to remove launch preflight helper: ${asError(error).message}`));
  }
  try {
    await rmdir(helperRoot);
  } catch (error) {
    cleanupErrors.push(
      new Error(`Unable to remove launch preflight directory: ${asError(error).message}`),
    );
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `macOS launch preflight failed: ${primaryError.message}; cleanup failures: ` +
        cleanupErrors.map((error) => error.message).join(" | "),
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `macOS launch preflight cleanup failed: ` +
        cleanupErrors.map((error) => error.message).join(" | "),
    );
  }
  return snapshot;
}

async function compileMacOSTerminationHelper(smokeRoot: string): Promise<string> {
  const source = resolve(import.meta.dir, "macos-terminate.m");
  const output = join(smokeRoot, "terminate-macos-application");
  const compiled = Bun.spawnSync([
    "/usr/bin/xcrun",
    "clang",
    "-fobjc-arc",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-framework",
    "AppKit",
    source,
    "-o",
    output,
  ], { stdout: "pipe", stderr: "pipe" });
  if (compiled.exitCode !== 0) {
    throw new Error(
      `Unable to compile PID-scoped macOS termination helper: ${compiled.stderr.toString("utf8").trim()}`,
    );
  }
  const outputStat = await lstat(output);
  if (!outputStat.isFile() || outputStat.isSymbolicLink()) {
    throw new Error("Compiled macOS termination helper is not a real file");
  }
  return output;
}

async function terminateNewAppProcessTree(
  appPath: string,
  baselinePids: Set<number>,
  mainPid: number | undefined,
  terminationHelperPath: string,
): Promise<{
  mechanism: "NSRunningApplication.terminate";
  accepted: true;
  signalFallbackUsed: false;
  forcedTerminationUsed: false;
}> {
  if (mainPid === undefined) {
    const unbound = exactNewAppProcesses(appPath, baselinePids);
    if (unbound.length !== 0) {
      throw new Error(
        "Refusing to signal unbound post-snapshot app processes: " +
          processSummary(unbound),
      );
    }
    return {
      mechanism: "NSRunningApplication.terminate",
      accepted: true,
      signalFallbackUsed: false,
      forcedTerminationUsed: false,
    };
  }
  const ownedPids = new Set<number>([mainPid]);
  const scopedProcesses = (): ProcessRow[] => {
    const processes = listProcesses();
    const exact = exactAppProcesses(appPath, processes);
    for (const process of exact) {
      if (
        process.pid === mainPid ||
        ownedPids.has(process.pid) ||
        isDescendant(process.pid, mainPid, processes)
      ) {
        ownedPids.add(process.pid);
      }
    }
    return exact.filter((process) => ownedPids.has(process.pid));
  };

  if (scopedProcesses().length === 0) {
    throw new Error("Packaged app exited before native termination was requested");
  }
  let nativeFailure: Error | undefined;
  const request = Bun.spawnSync(
    [terminationHelperPath, String(mainPid), appPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (
    request.exitCode === 0 &&
    request.stdout.toString("utf8").trim() === "termination-requested"
  ) {
    if (await waitForProcessExit(scopedProcesses, 10_000)) {
      return {
        mechanism: "NSRunningApplication.terminate",
        accepted: true,
        signalFallbackUsed: false,
        forcedTerminationUsed: false,
      };
    }
    nativeFailure = new Error(
      "Packaged app accepted native termination but did not exit within 10 seconds",
    );
  } else {
    nativeFailure = new Error(
      `PID-scoped native termination was rejected with exit ${request.exitCode}: ` +
        request.stderr.toString("utf8").trim(),
    );
  }

  const termProcesses = scopedProcesses().sort((left, right) => right.pid - left.pid);
  for (const process of termProcesses) {
    try {
      globalThis.process.kill(process.pid, "SIGTERM");
    } catch {
      // The process may have exited between the process-table read and signal.
    }
  }
  if (await waitForProcessExit(scopedProcesses, 10_000)) {
    throw new Error(
      `${nativeFailure.message}; exact-path SIGTERM cleanup was required: ` +
        processSummary(termProcesses),
    );
  }

  const forcedProcesses = scopedProcesses().sort((left, right) => right.pid - left.pid);
  for (const process of forcedProcesses) {
    try {
      globalThis.process.kill(process.pid, "SIGKILL");
    } catch {
      // The process may have exited between the process-table read and cleanup.
    }
  }
  const forcedExited = await waitForProcessExit(scopedProcesses, 5_000);
  const survivors = scopedProcesses();
  throw new Error(
    `${nativeFailure.message}; packaged app required forced termination after its launch smoke: ` +
      processSummary(forcedProcesses) +
      (forcedExited
        ? ""
        : `; processes remained after SIGKILL: ${processSummary(survivors)}`),
  );
}

function exactNewAppProcesses(
  appPath: string,
  baselinePids: Set<number>,
): ProcessRow[] {
  return exactAppProcesses(appPath).filter(
    (process) =>
      !baselinePids.has(process.pid),
  );
}

function exactAppProcesses(
  appPath: string,
  processes: ProcessRow[] = listProcesses(),
): ProcessRow[] {
  return processes.filter((process) => process.command.startsWith(`${appPath}/Contents/`));
}

function processSummary(processes: ProcessRow[]): string {
  return processes
    .map((process) => `${process.pid} ${process.command}`)
    .join("; ");
}

async function waitForProcessExit(
  processes: () => ProcessRow[],
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processes().length === 0) return true;
    await Bun.sleep(100);
  }
  return processes().length === 0;
}

async function diagnosticReportSnapshot(
  additionalHomePath?: string,
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const directory of diagnosticReportDirectories(additionalHomePath)) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissingOrDenied(error)) continue;
      throw error;
    }
    for (const name of names) {
      const path = join(directory, name);
      try {
        const file = await stat(path);
        if (!file.isFile()) continue;
        snapshot.set(path, `${file.size}:${file.mtimeMs}`);
      } catch (error) {
        if (!isMissingOrDenied(error)) throw error;
      }
    }
  }
  return snapshot;
}

async function newDiagnosticReports(
  before: Map<string, string>,
  appPath: string,
  additionalHomePath?: string,
): Promise<string[]> {
  const after = await diagnosticReportSnapshot(additionalHomePath);
  const candidates: string[] = [];
  for (const [path, identity] of after) {
    if (before.get(path) === identity || !/\.(?:crash|diag|ips)$/iu.test(path)) continue;
    const name = basename(path).toLowerCase();
    let body = "";
    try {
      body = (await readFile(path, "utf8")).slice(0, 2_000_000);
    } catch (error) {
      if (!isMissingOrDenied(error)) throw error;
    }
    if (
      body.includes(appPath) ||
      body.includes("com.blackglass.app") ||
      name.includes("blackglass bridge") ||
      name.includes("blackglass_bridge")
    ) {
      candidates.push(path);
    }
  }
  return candidates.sort();
}

function diagnosticReportDirectories(additionalHomePath?: string): string[] {
  return [
    ...(additionalHomePath
      ? [join(additionalHomePath, "Library/Logs/DiagnosticReports")]
      : []),
    join(layout.homePath, "Library/Logs/DiagnosticReports"),
    join(homedir(), "Library/Logs/DiagnosticReports"),
    "/Library/Logs/DiagnosticReports",
  ];
}

async function metadataTreeFingerprint(root: string): Promise<string> {
  const digest = createHash("sha256");
  try {
    await appendMetadata(root, root, digest);
  } catch (error) {
    if (isMissingOrDenied(error) && "code" in (error as object) && (error as any).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  return digest.digest("hex");
}

async function appendMetadata(
  root: string,
  path: string,
  digest: ReturnType<typeof createHash>,
): Promise<void> {
  const file = await lstat(path, { bigint: true });
  const entry = {
    path: relative(root, path).normalize("NFC"),
    type: file.isDirectory() ? "directory" : file.isFile() ? "file" : file.isSymbolicLink() ? "symlink" : "other",
    mode: Number(file.mode & 0o777n),
    size: file.size.toString(),
    mtimeNs: file.mtimeNs.toString(),
    ctimeNs: file.ctimeNs.toString(),
    ...(file.isSymbolicLink() ? { target: await readlink(path) } : {}),
  };
  digest.update(JSON.stringify(entry));
  digest.update("\n");
  if (!file.isDirectory()) return;
  const names = await readdir(path);
  names.sort();
  for (const name of names) await appendMetadata(root, join(path, name), digest);
}

function isMissingOrDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
