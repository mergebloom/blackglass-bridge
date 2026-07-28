import { createHash } from "node:crypto";
import { join } from "node:path";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import type { MacOSArtifact } from "./macos-artifact";
import { assertPathWithin, pathsEqual } from "./path-safety";

export const FINDER_LAUNCH_SMOKE_SCHEMA_VERSION = 6;
export const FINDER_LAUNCH_MINIMUM_HEALTH_MS = 8_000;
export const FINDER_LAUNCH_DEBUG_PORT = 9_320;

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
  embeddedAsarSha256: string;
  tlsMetadataSha256: string;
  tlsSpkiSha256Base64: string;
  chromiumHostResolverRules: string;
  appPath: string;
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
  debugPort: typeof FINDER_LAUNCH_DEBUG_PORT;
  debugListenerPid: number;
  debugTargetId: string;
  debugTargetUrl: string;
  startedAt: string;
  healthyAt: string;
  completedAt: string;
  mainPid: number;
  rendererPid: number;
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
  explicitUserDataDirUsed: false;
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
  evidencePath: string;
} {
  const smokeRoot = join(root, "launch-services-smoke");
  const homePath = join(smokeRoot, "home");
  return {
    smokeRoot,
    homePath,
    profilePath: join(homePath, "Library/Application Support/Blackglass Bridge"),
    vaultPath: join(smokeRoot, "vault"),
    stdoutPath: join(smokeRoot, "stdout.log"),
    stderrPath: join(smokeRoot, "stderr.log"),
    evidencePath: join(root, "finder-launch-smoke.json"),
  };
}

export function finderLaunchCommand(input: {
  appPath: string;
  blackglassHomePath: string;
  stdoutPath: string;
  stderrPath: string;
  chromiumHostResolverRules: string;
  tlsSpkiSha256Base64: string;
  debugPort?: number;
}): string[] {
  return [
    "/usr/bin/open",
    "-n",
    "-g",
    "--env",
    `${BLACKGLASS_HOME_ENVIRONMENT}=${input.blackglassHomePath}`,
    "--stdout",
    input.stdoutPath,
    "--stderr",
    input.stderrPath,
    "-a",
    input.appPath,
    "--args",
    `--remote-debugging-port=${input.debugPort ?? FINDER_LAUNCH_DEBUG_PORT}`,
    `--host-resolver-rules=${input.chromiumHostResolverRules}`,
    `--ignore-certificate-errors-spki-list=${input.tlsSpkiSha256Base64}`,
  ];
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
    artifact: PublicMacOSArtifact;
    controlOrigin: string;
    tlsMetadataSha256: string;
    chromiumHostResolverRules: string;
    tlsSpkiSha256Base64: string;
    nativeHomePath: string;
  },
): asserts value is FinderLaunchSmokeEvidence {
  if (!isRecord(value)) throw new Error("Finder launch smoke evidence is malformed");
  const layout = finderLaunchSmokeLayout(options.root);
  const executablePath = join(options.appPath, "Contents/MacOS/Obsidian");
  const cliExecutablePath = join(options.appPath, "Contents/MacOS/obsidian-cli");
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
    value.executableSha256 !== options.artifact.executableSha256 ||
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
  const healthyAt = Date.parse(String(value.healthyAt));
  const completedAt = Date.parse(String(value.completedAt));
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(healthyAt) ||
    !Number.isFinite(completedAt) ||
    startedAt >= healthyAt ||
    healthyAt > completedAt ||
    !Number.isSafeInteger(value.mainPid) ||
    (value.mainPid as number) < 1 ||
    !Number.isSafeInteger(value.rendererPid) ||
    (value.rendererPid as number) < 1 ||
    value.rendererPid === value.mainPid ||
    value.debugPort !== FINDER_LAUNCH_DEBUG_PORT ||
    !Number.isSafeInteger(value.debugListenerPid) ||
    (value.debugListenerPid as number) < 1 ||
    typeof value.debugTargetId !== "string" ||
    value.debugTargetId.length === 0 ||
    typeof value.debugTargetUrl !== "string" ||
    !value.debugTargetUrl.includes("starter.html") ||
    !Number.isSafeInteger(value.healthyForMs) ||
    (value.healthyForMs as number) < FINDER_LAUNCH_MINIMUM_HEALTH_MS ||
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
    value.explicitUserDataDirUsed !== false ||
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function same(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
