import { createHash } from "node:crypto";
import { join } from "node:path";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import type { MacOSArtifact } from "./macos-artifact";
import { assertPathWithin, pathsEqual } from "./path-safety";
import { stableJson } from "./stable-json";

export const FINDER_LAUNCH_SMOKE_SCHEMA_VERSION = 9;
export const FINDER_LAUNCH_MINIMUM_HEALTH_MS = 8_000;
export const FINDER_LAUNCH_DEBUG_PORT = 9_320;
export const FINDER_LAUNCH_DEBUG_ADDRESS = "127.0.0.1" as const;
export const FINDER_LAUNCH_LISTENER_TIMEOUT_MS = 30_000;
export const FINDER_LAUNCH_STARTER_TIMEOUT_MS = 90_000;
export const BLACKGLASS_BUNDLE_IDENTIFIER = "com.blackglass.bridge" as const;
export const OBSIDIAN_BUNDLE_IDENTIFIER = "md.obsidian" as const;
export const MACOS_LAUNCH_REQUIRED_ABSENT_BUNDLE_IDENTIFIERS = [
  BLACKGLASS_BUNDLE_IDENTIFIER,
  OBSIDIAN_BUNDLE_IDENTIFIER,
] as const;

export interface MacOSLaunchPreflightSnapshot {
  screenLocked: boolean;
  applications: Array<{
    pid: number;
    bundleIdentifier: string;
    bundlePath: string;
    executablePath: string;
  }>;
}

export interface MacOSLaunchPreflightEvidence {
  screenLocked: false;
  requiredAbsentBundleIdentifiers: [
    typeof BLACKGLASS_BUNDLE_IDENTIFIER,
    typeof OBSIDIAN_BUNDLE_IDENTIFIER,
  ];
  matchingApplications: 0;
}

export interface DevToolsListenerDiagnostic {
  pid: number;
  endpoint: string;
}

export interface DevToolsTargetDiagnostic {
  id: string | null;
  type: string | null;
  url: string | null;
  hasWebSocketDebuggerUrl: boolean;
}

export interface StarterControlPost {
  method: "POST";
  origin: string;
  path: "/user/signin" | "/vault/list";
}

export interface StarterSyncEntryAttempt {
  opened: boolean;
  href: string;
  readyState: string;
  rows: Array<{
    name: string | null;
    button: string | null;
  }>;
}

type PublicMacOSArtifact = Omit<MacOSArtifact, "appPath">;

export interface FinderLaunchSmokeEvidence {
  schemaVersion: typeof FINDER_LAUNCH_SMOKE_SCHEMA_VERSION;
  passed: true;
  platform: "macOS Apple Silicon";
  mechanism: "LaunchServices open -n -a";
  runManifestSha256: string;
  releaseManifestSha256: string;
  appArtifactSha256: string;
  applicationTreeSha256: string;
  executableSha256: string;
  launcherExecutableSha256: string;
  embeddedAsarSha256: string;
  tlsMetadataSha256: string;
  tlsSpkiSha256Base64: string;
  chromiumHostResolverRules: string;
  appPath: string;
  officialAppPath: string;
  launcherExecutablePath: string;
  executablePath: string;
  launchHomePath: string;
  launchHomeRootMode: 448;
  launchHomeSameDeviceAsArchive: true;
  launchHomeRelocatedToRun: true;
  launchHomeRootRemoved: true;
  cliExecutablePath: string;
  cliExecutableSha256: string;
  cliSocketAddress: string;
  cliSocketName: string;
  homePath: string;
  profilePath: string;
  vaultPath: string;
  launchCommand: string[];
  launcherCommand: string;
  officialCommand: string;
  officialChildOfLauncher: true;
  runtimeReceiptPath: string;
  runtimeReceiptSha256: string;
  debugPort: typeof FINDER_LAUNCH_DEBUG_PORT;
  debugAddress: typeof FINDER_LAUNCH_DEBUG_ADDRESS;
  debugListenerPid: number;
  debugListenerEndpoints: string[];
  debugTargetId: string;
  debugTargetUrl: string;
  startedAt: string;
  healthStartedAt: string;
  healthyAt: string;
  completedAt: string;
  mainPid: number;
  launcherPid: number;
  rendererPid: number;
  rendererStableDuringHealth: true;
  healthyForMs: number;
  defaultProfilePathObserved: true;
  profileMode: 448;
  profileRealDirectoryObserved: true;
  profileActivityObserved: true;
  profileSingletonArtifactsRemoved: true;
  blackglassHomeEnvironment: typeof BLACKGLASS_HOME_ENVIRONMENT;
  blackglassHomeEnvironmentObserved: true;
  nativeHomePath: string;
  nativeHomeEnvironmentPreserved: true;
  cliSocketObserved: true;
  cliSocketRemoved: true;
  upstreamCliSocketAbsent: true;
  cliForwardedCommandSucceeded: true;
  cliForwardedResponse: "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.";
  cliMainProcessReceiptObserved: true;
  explicitUserDataDirUsed: true;
  noLocalVaultAtLaunch: true;
  starterPageObserved: true;
  starterNativeUiExercised: true;
  starterControlOrigin: string;
  starterControlOriginMatched: true;
  starterControlRequests: Array<{
    method: "POST";
    origin: string;
    path: "/user/signin" | "/vault/list";
    status: number;
  }>;
  starterSignInSucceeded: true;
  starterVaultListSucceeded: true;
  noVaultRegisteredAfterLaunch: true;
  disposableVaultStayedEmpty: true;
  launchPreflight: MacOSLaunchPreflightEvidence;
  earlyExit: false;
  diagnosticReportsChecked: true;
  crashReportsCreated: 0;
  realProfilesUnchanged: true;
  terminationMechanism: "NSRunningApplication.terminate";
  nativeTerminationAccepted: true;
  signalFallbackUsed: false;
  forcedTerminationUsed: false;
  terminatedCleanly: true;
}

export function finderLaunchSmokeLayout(root: string): {
  smokeRoot: string;
  homePath: string;
  profilePath: string;
  vaultPath: string;
  stdoutPath: string;
  stderrPath: string;
  runtimeReceiptPath: string;
  evidencePath: string;
} {
  const smokeRoot = join(root, "launch-services-smoke");
  const homePath = join(smokeRoot, "home");
  return {
    smokeRoot,
    homePath,
    profilePath: join(homePath, "Library/Application Support/Blackglass Profile"),
    vaultPath: join(smokeRoot, "vault"),
    stdoutPath: join(smokeRoot, "stdout.log"),
    stderrPath: join(smokeRoot, "stderr.log"),
    runtimeReceiptPath: join(smokeRoot, "runtime-receipt.json"),
    evidencePath: join(root, "finder-launch-smoke.json"),
  };
}

export function parseStarterControlPost(value: unknown): StarterControlPost | undefined {
  if (!isRecord(value) || value.method !== "POST" || typeof value.url !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value.url);
    if (url.pathname !== "/user/signin" && url.pathname !== "/vault/list") {
      return undefined;
    }
    return { method: "POST", origin: url.origin, path: url.pathname };
  } catch {
    return undefined;
  }
}

export async function waitForStarterSyncEntry(
  attempt: () => Promise<unknown>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<StarterSyncEntryAttempt> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > timeoutMs
  ) {
    throw new Error("Invalid native starter Sync entry wait bounds");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const deadline = now() + timeoutMs;
  let lastAttempt: StarterSyncEntryAttempt | undefined;
  while (true) {
    const value = await attempt();
    if (!isStarterSyncEntryAttempt(value)) {
      throw new Error("Native starter Sync entry inspection returned malformed data");
    }
    lastAttempt = value;
    if (value.opened) return value;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs));
  }
  throw new Error(
    "Native starter Sync sign-in entry point is unavailable after bounded readiness wait: " +
      stableJson(lastAttempt),
  );
}

export function starterSyncEntryRowIndex(value: unknown): number | undefined {
  if (
    !isStarterSyncEntryAttempt(value) ||
    !value.href.includes("starter.html") ||
    value.rows.length < 3 ||
    value.rows.slice(0, 3).some((row) => row.button === null)
  ) {
    return undefined;
  }
  // The reviewed 1.12.7 starter renderer has three action rows in a fixed
  // order: create, open, and Sync. Labels are localized from navigator.language,
  // so their text is not a stable selector even within this exact release.
  return 2;
}

export function finderLaunchCommand(input: {
  appPath: string;
  blackglassHomePath: string;
  stdoutPath: string;
  stderrPath: string;
  profilePath: string;
  runtimeReceiptPath: string;
  chromiumHostResolverRules: string;
  tlsSpkiSha256Base64: string;
  debugPort?: number;
}): string[] {
  return [
    "/usr/bin/open",
    "-n",
    "--env",
    `${BLACKGLASS_HOME_ENVIRONMENT}=${input.blackglassHomePath}`,
    "--stdout",
    input.stdoutPath,
    "--stderr",
    input.stderrPath,
    "-a",
    input.appPath,
    "--args",
    "--blackglass-profile",
    input.profilePath,
    "--blackglass-runtime-receipt",
    input.runtimeReceiptPath,
    `--remote-debugging-port=${input.debugPort ?? FINDER_LAUNCH_DEBUG_PORT}`,
    `--remote-debugging-address=${FINDER_LAUNCH_DEBUG_ADDRESS}`,
    `--host-resolver-rules=${input.chromiumHostResolverRules}`,
    `--ignore-certificate-errors-spki-list=${input.tlsSpkiSha256Base64}`,
  ];
}

export function assertMacOSLaunchPreflight(
  value: unknown,
  expectedAppPath: string,
): asserts value is MacOSLaunchPreflightSnapshot {
  if (
    !isRecord(value) ||
    typeof value.screenLocked !== "boolean" ||
    !Array.isArray(value.applications)
  ) {
    throw new Error("macOS launch preflight snapshot is malformed");
  }
  const seenPids = new Set<number>();
  for (const application of value.applications) {
    if (
      !isRecord(application) ||
      !Number.isSafeInteger(application.pid) ||
      (application.pid as number) < 1 ||
      typeof application.bundleIdentifier !== "string" ||
      typeof application.bundlePath !== "string" ||
      !application.bundlePath.startsWith("/") ||
      typeof application.executablePath !== "string" ||
      !application.executablePath.startsWith("/") ||
      !MACOS_LAUNCH_REQUIRED_ABSENT_BUNDLE_IDENTIFIERS.includes(
        application.bundleIdentifier as
          (typeof MACOS_LAUNCH_REQUIRED_ABSENT_BUNDLE_IDENTIFIERS)[number],
      ) ||
      seenPids.has(application.pid as number)
    ) {
      throw new Error("macOS launch preflight application entry is malformed");
    }
    seenPids.add(application.pid as number);
  }
  if (value.screenLocked) {
    throw new Error(
      "Refusing LaunchServices smoke while the macOS console is locked; unlock it and keep the desktop session active",
    );
  }
  const conflicts = value.applications as MacOSLaunchPreflightSnapshot["applications"];
  if (conflicts.length > 0) {
    const exactRunning = conflicts.some(
      (application) =>
        application.bundleIdentifier === BLACKGLASS_BUNDLE_IDENTIFIER &&
        pathsEqual(application.bundlePath, expectedAppPath),
    );
    const officialRunning = conflicts.some(
      (application) => application.bundleIdentifier === OBSIDIAN_BUNDLE_IDENTIFIER,
    );
    const otherBlackglassRunning = conflicts.some(
      (application) =>
        application.bundleIdentifier === BLACKGLASS_BUNDLE_IDENTIFIER &&
        !pathsEqual(application.bundlePath, expectedAppPath),
    );
    const summary = conflicts
      .map((application) =>
        `${application.pid} ${application.bundleIdentifier} ${application.bundlePath}`
      )
      .join("; ");
    throw new Error(
      `Refusing LaunchServices smoke while ${[
        ...(exactRunning ? ["the exact generated Blackglass app"] : []),
        ...(otherBlackglassRunning ? ["another Blackglass app"] : []),
        ...(officialRunning ? ["Obsidian"] : []),
      ].join(" and ")} is running; quit every Obsidian and Blackglass app: ` +
        summary,
    );
  }
}

export function macOSLaunchPreflightEvidence(
  snapshot: MacOSLaunchPreflightSnapshot,
): MacOSLaunchPreflightEvidence {
  if (snapshot.screenLocked || snapshot.applications.length !== 0) {
    throw new Error("Cannot bind a failed macOS launch preflight into smoke evidence");
  }
  return {
    screenLocked: false,
    requiredAbsentBundleIdentifiers: [
      BLACKGLASS_BUNDLE_IDENTIFIER,
      OBSIDIAN_BUNDLE_IDENTIFIER,
    ],
    matchingApplications: 0,
  };
}

export function assertMacOSLaunchPreflightEvidence(
  value: unknown,
): asserts value is MacOSLaunchPreflightEvidence {
  const expected = macOSLaunchPreflightEvidence({
    screenLocked: false,
    applications: [],
  });
  if (!isRecord(value) || !same(value, expected)) {
    throw new Error("Finder launch smoke does not bind its macOS launch preflight");
  }
}

export function parseLsofTcpListeners(value: string): DevToolsListenerDiagnostic[] {
  let currentPid: number | undefined;
  const listeners = new Map<string, DevToolsListenerDiagnostic>();
  for (const line of value.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (!Number.isSafeInteger(pid) || pid < 1) {
        throw new Error("lsof returned a malformed listener PID");
      }
      currentPid = pid;
      continue;
    }
    if (line.startsWith("f")) continue;
    if (line.startsWith("n")) {
      const endpoint = line.slice(1);
      if (currentPid === undefined || endpoint.length === 0) {
        throw new Error("lsof returned a listener endpoint without a process");
      }
      listeners.set(`${currentPid}\0${endpoint}`, { pid: currentPid, endpoint });
      continue;
    }
    throw new Error("lsof returned an unexpected listener field");
  }
  return [...listeners.values()].sort(
    (left, right) => left.pid - right.pid || compareStrings(left.endpoint, right.endpoint),
  );
}

export function isLoopbackTcpListenerEndpoint(endpoint: string, port: number): boolean {
  return endpoint === `${FINDER_LAUNCH_DEBUG_ADDRESS}:${port}` ||
    endpoint === `[::1]:${port}`;
}

export function formatStarterTargetTimeout(input: {
  timeoutMs: number;
  port: number;
  mainPid: number;
  lastCdpError: string | undefined;
  lastTargets: DevToolsTargetDiagnostic[];
  processes: string[];
}): string {
  return (
    `Fresh default profile never opened the native starter.html renderer within ` +
    `${input.timeoutMs}ms after DevTools listener readiness; ` +
    formatStarterTargetDiagnostics(input)
  );
}

export function formatStarterTargetDiagnostics(input: {
  port: number;
  mainPid: number;
  lastCdpError: string | undefined;
  lastTargets: DevToolsTargetDiagnostic[];
  processes: string[];
}): string {
  return (
    `port=${input.port}; mainPid=${input.mainPid}; ` +
    `lastCdpError=${input.lastCdpError ?? "none"}; ` +
    `lastTargets=${stableJson(input.lastTargets)}; ` +
    `launchedProcesses=${stableJson(input.processes)}`
  );
}

export function formatLaunchSmokeFailureMessage(
  primaryError: string,
  cleanupErrors: string[],
): string {
  if (cleanupErrors.length === 0) return `LaunchServices smoke failed: ${primaryError}`;
  return (
    `LaunchServices smoke failed: ${primaryError}; cleanup failures: ` +
    cleanupErrors.join(" | ")
  );
}

export function macOSArtifactBindingSha256(artifact: PublicMacOSArtifact): string {
  return sha256(Buffer.from(stableJson(artifact)));
}

export function assertFinderLaunchSmokeEvidence(
  value: unknown,
  options: {
    root: string;
    runManifestSha256: string;
    releaseManifestSha256: string;
    appPath: string;
    officialAppPath: string;
    launcherExecutablePath: string;
    artifact: PublicMacOSArtifact;
    controlOrigin: string;
    tlsMetadataSha256: string;
    chromiumHostResolverRules: string;
    tlsSpkiSha256Base64: string;
    nativeHomePath: string;
  },
): asserts value is FinderLaunchSmokeEvidence {
  if (!isRecord(value)) throw new Error("Finder launch smoke evidence is malformed");
  assertMacOSLaunchPreflightEvidence(value.launchPreflight);
  const layout = finderLaunchSmokeLayout(options.root);
  const executablePath = join(options.officialAppPath, "Contents/MacOS/Obsidian");
  const cliExecutablePath = join(layout.profilePath, "blackglass-cli");
  if (
    typeof value.launchHomePath !== "string" ||
    !/^\/private\/tmp\/blackglass-launch-[A-Za-z0-9]{6}\/h$/u.test(
      value.launchHomePath,
    ) ||
    Buffer.byteLength(join(value.launchHomePath, options.artifact.cliSocketName), "utf8") >
      103 ||
    value.launchHomeRootMode !== 448 ||
    value.launchHomeSameDeviceAsArchive !== true ||
    value.launchHomeRelocatedToRun !== true ||
    value.launchHomeRootRemoved !== true ||
    typeof value.nativeHomePath !== "string" ||
    !value.nativeHomePath.startsWith("/") ||
    pathsEqual(value.nativeHomePath, value.launchHomePath)
  ) {
    throw new Error("Finder launch smoke has an invalid short canonical HOME");
  }
  const expectedCommand = finderLaunchCommand({
    appPath: options.appPath,
    blackglassHomePath: value.launchHomePath,
    stdoutPath: layout.stdoutPath,
    stderrPath: layout.stderrPath,
    profilePath: join(
      value.launchHomePath,
      "Library/Application Support/Blackglass Profile",
    ),
    runtimeReceiptPath: join(layout.smokeRoot, "runtime-receipt.json"),
    chromiumHostResolverRules: options.chromiumHostResolverRules,
    tlsSpkiSha256Base64: options.tlsSpkiSha256Base64,
    debugPort: FINDER_LAUNCH_DEBUG_PORT,
  });
  if (
    value.schemaVersion !== FINDER_LAUNCH_SMOKE_SCHEMA_VERSION ||
    value.passed !== true ||
    value.platform !== "macOS Apple Silicon" ||
    value.mechanism !== "LaunchServices open -n -a" ||
    value.runManifestSha256 !== options.runManifestSha256 ||
    value.releaseManifestSha256 !== options.releaseManifestSha256 ||
    value.appArtifactSha256 !== macOSArtifactBindingSha256(options.artifact) ||
    value.applicationTreeSha256 !== options.artifact.applicationTreeSha256 ||
    value.executableSha256 !== options.artifact.officialExecutableSha256 ||
    value.launcherExecutableSha256 !== options.artifact.executableSha256 ||
    !isSha256(value.runtimeReceiptSha256) ||
    value.runtimeReceiptPath !== join(layout.smokeRoot, "runtime-receipt.json") ||
    typeof value.launcherCommand !== "string" || value.launcherCommand.length === 0 ||
    typeof value.officialCommand !== "string" || value.officialCommand.length === 0 ||
    value.officialChildOfLauncher !== true ||
    value.embeddedAsarSha256 !== options.artifact.embeddedAsarSha256 ||
    value.tlsMetadataSha256 !== options.tlsMetadataSha256 ||
    value.tlsSpkiSha256Base64 !== options.tlsSpkiSha256Base64 ||
    value.chromiumHostResolverRules !== options.chromiumHostResolverRules ||
    !Array.isArray(value.launchCommand) ||
    !same(value.launchCommand, expectedCommand) ||
    value.launchCommand.some(
      (argument: unknown) =>
        typeof argument === "string" && argument.startsWith("HOME="),
    ) ||
    typeof value.appPath !== "string" ||
    !pathsEqual(value.appPath, options.appPath) ||
    typeof value.officialAppPath !== "string" ||
    !pathsEqual(value.officialAppPath, options.officialAppPath) ||
    typeof value.launcherExecutablePath !== "string" ||
    !pathsEqual(value.launcherExecutablePath, options.launcherExecutablePath) ||
    typeof value.executablePath !== "string" ||
    !pathsEqual(value.executablePath, executablePath) ||
    typeof value.cliExecutablePath !== "string" ||
    !pathsEqual(value.cliExecutablePath, cliExecutablePath) ||
    value.cliExecutableSha256 !== options.artifact.cliExecutableSha256 ||
    value.cliSocketAddress !== join(value.launchHomePath, options.artifact.cliSocketName) ||
    value.cliSocketName !== options.artifact.cliSocketName ||
    typeof value.homePath !== "string" ||
    !pathsEqual(value.homePath, layout.homePath) ||
    typeof value.profilePath !== "string" ||
    !pathsEqual(value.profilePath, layout.profilePath) ||
    typeof value.vaultPath !== "string" ||
    !pathsEqual(value.vaultPath, layout.vaultPath)
  ) {
    throw new Error("Finder launch smoke is not bound to the exact prepared app and run");
  }
  for (const [label, path] of [
    ["Finder smoke home", value.homePath],
    ["Finder smoke profile", value.profilePath],
    ["Finder smoke vault", value.vaultPath],
  ] as const) {
    assertPathWithin(path, options.root, label);
  }
  const startedAt = Date.parse(String(value.startedAt));
  const healthStartedAt = Date.parse(String(value.healthStartedAt));
  const healthyAt = Date.parse(String(value.healthyAt));
  const completedAt = Date.parse(String(value.completedAt));
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(healthStartedAt) ||
    !Number.isFinite(healthyAt) ||
    !Number.isFinite(completedAt) ||
    startedAt >= healthStartedAt ||
    healthStartedAt >= healthyAt ||
    healthyAt > completedAt ||
    !Number.isSafeInteger(value.mainPid) ||
    (value.mainPid as number) < 1 ||
    !Number.isSafeInteger(value.launcherPid) ||
    (value.launcherPid as number) < 1 ||
    value.launcherPid === value.mainPid ||
    !Number.isSafeInteger(value.rendererPid) ||
    (value.rendererPid as number) < 1 ||
    value.rendererPid === value.mainPid ||
    value.rendererStableDuringHealth !== true ||
    value.debugPort !== FINDER_LAUNCH_DEBUG_PORT ||
    value.debugAddress !== FINDER_LAUNCH_DEBUG_ADDRESS ||
    !Number.isSafeInteger(value.debugListenerPid) ||
    (value.debugListenerPid as number) < 1 ||
    !validLoopbackListenerEndpoints(
      value.debugListenerEndpoints,
      FINDER_LAUNCH_DEBUG_PORT,
    ) ||
    typeof value.debugTargetId !== "string" ||
    value.debugTargetId.length === 0 ||
    typeof value.debugTargetUrl !== "string" ||
    !value.debugTargetUrl.includes("starter.html") ||
    !Number.isSafeInteger(value.healthyForMs) ||
    (value.healthyForMs as number) < FINDER_LAUNCH_MINIMUM_HEALTH_MS ||
    healthyAt - healthStartedAt !== value.healthyForMs ||
    value.defaultProfilePathObserved !== true ||
    value.profileMode !== 448 ||
    value.profileRealDirectoryObserved !== true ||
    value.profileActivityObserved !== true ||
    value.profileSingletonArtifactsRemoved !== true ||
    value.blackglassHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    value.blackglassHomeEnvironmentObserved !== true ||
    value.nativeHomePath !== options.nativeHomePath ||
    value.nativeHomeEnvironmentPreserved !== true ||
    value.cliSocketObserved !== true ||
    value.cliSocketRemoved !== true ||
    value.upstreamCliSocketAbsent !== true ||
    value.cliForwardedCommandSucceeded !== true ||
    value.cliForwardedResponse !==
      "Command line interface is not enabled. Please turn it on in Settings > General > Advanced." ||
    value.cliMainProcessReceiptObserved !== true ||
    value.explicitUserDataDirUsed !== true ||
    value.noLocalVaultAtLaunch !== true ||
    value.starterPageObserved !== true ||
    value.starterNativeUiExercised !== true ||
    value.starterControlOrigin !== options.controlOrigin ||
    value.starterControlOriginMatched !== true ||
    !validStarterRequests(value.starterControlRequests, options.controlOrigin) ||
    value.starterSignInSucceeded !== true ||
    value.starterVaultListSucceeded !== true ||
    value.noVaultRegisteredAfterLaunch !== true ||
    value.disposableVaultStayedEmpty !== true ||
    value.earlyExit !== false ||
    value.diagnosticReportsChecked !== true ||
    value.crashReportsCreated !== 0 ||
    value.realProfilesUnchanged !== true ||
    value.terminationMechanism !== "NSRunningApplication.terminate" ||
    value.nativeTerminationAccepted !== true ||
    value.signalFallbackUsed !== false ||
    value.forcedTerminationUsed !== false ||
    value.terminatedCleanly !== true
  ) {
    throw new Error("Finder launch smoke does not prove a healthy crash-free default launch");
  }
}

function validStarterRequests(value: unknown, controlOrigin: string): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const expectedPaths = ["/user/signin", "/vault/list"];
  return value.every((item, index) =>
    isRecord(item) &&
    item.method === "POST" &&
    item.origin === controlOrigin &&
    item.path === expectedPaths[index] &&
    Number.isSafeInteger(item.status) &&
    (item.status as number) >= 200 &&
    (item.status as number) < 300
  );
}

function validLoopbackListenerEndpoints(value: unknown, port: number): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (endpoint) =>
        typeof endpoint !== "string" ||
        !isLoopbackTcpListenerEndpoint(endpoint, port),
    )
  ) {
    return false;
  }
  const canonical = [...new Set(value as string[])].sort(compareStrings);
  return same(value, canonical);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isStarterSyncEntryAttempt(value: unknown): value is StarterSyncEntryAttempt {
  return Boolean(
    isRecord(value) &&
      typeof value.opened === "boolean" &&
      typeof value.href === "string" &&
      typeof value.readyState === "string" &&
      Array.isArray(value.rows) &&
      value.rows.length <= 16 &&
      value.rows.every((row) =>
        isRecord(row) &&
        (row.name === null || typeof row.name === "string") &&
        (row.button === null || typeof row.button === "string")
      ),
  );
}

function same(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
