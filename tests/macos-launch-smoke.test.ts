import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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
  formatStarterTargetTimeout,
  isLoopbackTcpListenerEndpoint,
  macOSLaunchPreflightEvidence,
  macOSArtifactBindingSha256,
  parseLsofTcpListeners,
  type FinderLaunchSmokeEvidence,
} from "../tools/macos-launch-smoke";
import { APPROVED_MACOS_ENTITLEMENTS } from "../tools/macos-code-signing";

const digest = (character: string): string => character.repeat(64);
const root = "/workspace/blackglass-bridge/.data/e2e/release";
const appPath = "/workspace/blackglass-bridge/.data/build/Blackglass Bridge.app";
const controlOrigin = "https://blackglass.example.com";
const chromiumHostResolverRules = "MAP blackglass.example.com 127.0.0.1:8443";
const tlsSpkiSha256Base64 = `${"A".repeat(43)}=`;
const launchHomePath = "/private/tmp/blackglass-launch-ABC123/h";
const nativeHomePath = "/Users/example";
const artifact = {
  schemaVersion: 8 as const,
  appBundleName: "Blackglass Bridge.app" as const,
  bundleIdentifier: "com.blackglass.bridge" as const,
  bundleName: "Obsidian" as const,
  displayName: "Blackglass Bridge" as const,
  version: "1.12.7",
  executableName: "Obsidian" as const,
  infoPlistSha256: digest("1"),
  executableSha256: digest("2"),
  cliExecutableName: "obsidian-cli" as const,
  cliExecutableSha256: digest("6"),
  cliSocketName: ".blackglass-b.sock" as const,
  cliSocketOccurrences: 2 as const,
  embeddedAsarSha256: digest("3"),
  rendererRuntimeHomeEnvironment: "BLACKGLASS_HOME" as const,
  rendererCliRuntimeRootValidated: true as const,
  embeddedWrapperAsarSha256: digest("4"),
  embeddedWrapperHeaderSha256: digest("5"),
  codeDirectoryHash: "6".repeat(40),
  applicationTreeSha256: digest("7"),
  applicationTreeIdentity: {
    formatVersion: 1 as const,
    sha256: digest("7"),
    entries: 2,
    files: 1,
    directories: 1,
    symlinks: 0,
    fileBytes: 42,
  },
  helperBundleIdentifiers: [
    "md.obsidian.helper",
    "md.obsidian.helper.GPU",
    "md.obsidian.helper.Plugin",
    "md.obsidian.helper.Renderer",
  ],
  codeSigning: {
    formatVersion: 2 as const,
    signature: "ad-hoc" as const,
    allReviewedTargetsHardenedRuntime: true as const,
    allInventoryTargetsStrictlyVerified: true as const,
    allArchitecturesStrictlyVerified: true as const,
    strictInventoryTargets: 1,
    strictMachOTargets: 1,
    inventorySigningSha256: digest("c"),
    approvedEntitlements: [...APPROVED_MACOS_ENTITLEMENTS],
    targets: [
      {
        role: "application" as const,
        identifier: "com.blackglass.bridge",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "cli" as const,
        identifier: "obsidian-cli",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "helper" as const,
        identifier: "md.obsidian.helper",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "helper" as const,
        identifier: "md.obsidian.helper.GPU",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "helper" as const,
        identifier: "md.obsidian.helper.Plugin",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "helper" as const,
        identifier: "md.obsidian.helper.Renderer",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "auxiliary" as const,
        identifier: "ShipIt",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "auxiliary" as const,
        identifier: "chrome_crashpad_handler",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "approved" as const,
      },
      {
        role: "framework" as const,
        identifier: "com.github.Electron.framework",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "none" as const,
      },
      {
        role: "framework" as const,
        identifier: "org.mantle.Mantle",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "none" as const,
      },
      {
        role: "framework" as const,
        identifier: "com.electron.reactive",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "none" as const,
      },
      {
        role: "framework" as const,
        identifier: "com.github.Squirrel",
        runtimeVersion: "26.0.0",
        entitlementPolicy: "none" as const,
      },
    ],
  },
  codeInventory: {
    formatVersion: 1 as const,
    sha256: digest("8"),
    entries: [
      { path: ".", kind: "bundle" as const, architectures: [] as string[] },
    ],
  },
  rootMetadata: {
    formatVersion: 2 as const,
    sha256: digest("9"),
    mode: 493 as const,
    bsdFlags: 0 as const,
    ownerUidMatchesProcess: true as const,
    quarantineAbsent: true as const,
    entriesChecked: 2,
    entriesSha256: digest("a"),
    allEntriesOwnedByProcess: true as const,
    allEntriesBsdFlagsZero: true as const,
    allEntriesAclFree: true as const,
    unsupportedXattrsAbsent: true as const,
    xattrs: [],
    descendantXattrs: {
      allowedNames: ["com.apple.provenance"] as ["com.apple.provenance"],
      entries: 0,
      sha256: digest("b"),
    },
  },
  profileDirectory: "Blackglass Bridge" as const,
  profileMode: 448 as const,
  profilePathCanonicalAtSetup: true as const,
  explicitUserDataDirHonored: true as const,
  profileHomeEnvironment: "BLACKGLASS_HOME" as const,
  dedicatedHomeValidated: true as const,
  nativeHomeFallbackPreserved: true as const,
  upstreamUpdatesDisabled: true as const,
  embeddedRendererOnly: true as const,
  registeredUrlSchemes: [] as [],
  upstreamICloudContainerRegistered: false as const,
};

function evidence(): FinderLaunchSmokeEvidence {
  const layout = finderLaunchSmokeLayout(root);
  return {
    schemaVersion: FINDER_LAUNCH_SMOKE_SCHEMA_VERSION,
    passed: true,
    platform: "macOS Apple Silicon",
    mechanism: "LaunchServices open -n -a",
    runManifestSha256: digest("a"),
    releaseManifestSha256: digest("b"),
    appArtifactSha256: macOSArtifactBindingSha256(artifact),
    applicationTreeSha256: artifact.applicationTreeSha256,
    executableSha256: artifact.executableSha256,
    embeddedAsarSha256: artifact.embeddedAsarSha256,
    tlsMetadataSha256: digest("c"),
    tlsSpkiSha256Base64,
    chromiumHostResolverRules,
    appPath,
    executablePath: join(appPath, "Contents/MacOS/Obsidian"),
    launchHomePath,
    launchHomeRootMode: 448,
    launchHomeSameDeviceAsArchive: true,
    launchHomeRelocatedToRun: true,
    launchHomeRootRemoved: true,
    cliExecutablePath: join(appPath, "Contents/MacOS/obsidian-cli"),
    cliExecutableSha256: artifact.cliExecutableSha256,
    cliSocketAddress: join(launchHomePath, artifact.cliSocketName),
    cliSocketName: artifact.cliSocketName,
    homePath: layout.homePath,
    profilePath: layout.profilePath,
    vaultPath: layout.vaultPath,
    launchCommand: finderLaunchCommand({
      appPath,
      blackglassHomePath: launchHomePath,
      stdoutPath: layout.stdoutPath,
      stderrPath: layout.stderrPath,
      chromiumHostResolverRules,
      tlsSpkiSha256Base64,
    }),
    debugPort: FINDER_LAUNCH_DEBUG_PORT,
    debugAddress: FINDER_LAUNCH_DEBUG_ADDRESS,
    debugListenerPid: 100,
    debugListenerEndpoints: [`${FINDER_LAUNCH_DEBUG_ADDRESS}:${FINDER_LAUNCH_DEBUG_PORT}`],
    debugTargetId: "starter-target",
    debugTargetUrl: "file:///Applications/Blackglass%20Bridge.app/Contents/Resources/starter.html",
    startedAt: "2026-07-28T12:00:00.000Z",
    healthStartedAt: "2026-07-28T12:00:01.000Z",
    healthyAt: "2026-07-28T12:00:09.000Z",
    completedAt: "2026-07-28T12:00:10.000Z",
    mainPid: 100,
    rendererPid: 101,
    rendererStableDuringHealth: true,
    healthyForMs: FINDER_LAUNCH_MINIMUM_HEALTH_MS,
    defaultProfilePathObserved: true,
    profileMode: 448,
    profileRealDirectoryObserved: true,
    profileActivityObserved: true,
    profileSingletonArtifactsRemoved: true,
    blackglassHomeEnvironment: "BLACKGLASS_HOME",
    blackglassHomeEnvironmentObserved: true,
    nativeHomePath,
    nativeHomeEnvironmentPreserved: true,
    cliSocketObserved: true,
    cliSocketRemoved: true,
    upstreamCliSocketAbsent: true,
    cliForwardedCommandSucceeded: true,
    cliForwardedResponse:
      "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.",
    cliMainProcessReceiptObserved: true,
    explicitUserDataDirUsed: false,
    noLocalVaultAtLaunch: true,
    starterPageObserved: true,
    starterNativeUiExercised: true,
    starterControlOrigin: controlOrigin,
    starterControlOriginMatched: true,
    starterControlRequests: [
      { method: "POST", origin: controlOrigin, path: "/user/signin", status: 200 },
      { method: "POST", origin: controlOrigin, path: "/vault/list", status: 200 },
    ],
    starterSignInSucceeded: true,
    starterVaultListSucceeded: true,
    noVaultRegisteredAfterLaunch: true,
    disposableVaultStayedEmpty: true,
    launchPreflight: macOSLaunchPreflightEvidence({
      screenLocked: false,
      applications: [],
    }),
    earlyExit: false,
    diagnosticReportsChecked: true,
    crashReportsCreated: 0,
    realProfilesUnchanged: true,
    terminationMechanism: "NSRunningApplication.terminate",
    nativeTerminationAccepted: true,
    signalFallbackUsed: false,
    forcedTerminationUsed: false,
    terminatedCleanly: true,
  };
}

const options = {
  root,
  runManifestSha256: digest("a"),
  releaseManifestSha256: digest("b"),
  appPath,
  artifact,
  controlOrigin,
  tlsMetadataSha256: digest("c"),
  chromiumHostResolverRules,
  tlsSpkiSha256Base64,
  nativeHomePath,
};

describe("packaged macOS LaunchServices smoke", () => {
  test("uses LaunchServices with BLACKGLASS_HOME while preserving native HOME", () => {
    const command = evidence().launchCommand;
    expect(command).toContain("-a");
    expect(command).toContain(appPath);
    expect(command).not.toContain("-g");
    expect(command).toContain(
      `--remote-debugging-address=${FINDER_LAUNCH_DEBUG_ADDRESS}`,
    );
    expect(command).toContain(`BLACKGLASS_HOME=${launchHomePath}`);
    expect(command.some((argument) => argument.startsWith("HOME="))).toBe(false);
    expect(
      Buffer.byteLength(join(launchHomePath, artifact.cliSocketName), "utf8"),
    ).toBeLessThanOrEqual(103);
    expect(command.some((argument) => argument.includes("--user-data-dir"))).toBe(false);
    expect(FINDER_LAUNCH_LISTENER_TIMEOUT_MS).toBe(30_000);
    expect(FINDER_LAUNCH_STARTER_TIMEOUT_MS).toBe(90_000);
    expect(() => assertFinderLaunchSmokeEvidence(evidence(), options)).not.toThrow();
  });

  test("requires an unlocked console without Obsidian or another Blackglass bundle", () => {
    const officialObsidian = {
      pid: 10,
      bundleIdentifier: OBSIDIAN_BUNDLE_IDENTIFIER,
      bundlePath: "/Applications/Obsidian.app",
      executablePath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    };
    expect(() =>
      assertMacOSLaunchPreflight(
        { screenLocked: false, applications: [officialObsidian] },
        appPath,
      )
    ).toThrow("Obsidian");

    expect(() =>
      assertMacOSLaunchPreflight(
        { screenLocked: false, applications: [] },
        appPath,
      )
    ).not.toThrow();

    expect(() =>
      assertMacOSLaunchPreflight(
        {
          screenLocked: false,
          applications: [{ ...officialObsidian, bundleIdentifier: "unexpected.bundle" }],
        },
        appPath,
      )
    ).toThrow("malformed");

    expect(() =>
      assertMacOSLaunchPreflight(
        { screenLocked: true, applications: [] },
        appPath,
      )
    ).toThrow("console is locked");

    const installedBridge = {
      pid: 11,
      bundleIdentifier: BLACKGLASS_BUNDLE_IDENTIFIER,
      bundlePath: "/Applications/Blackglass Bridge.app",
      executablePath: "/Applications/Blackglass Bridge.app/Contents/MacOS/Obsidian",
    };
    expect(() =>
      assertMacOSLaunchPreflight(
        { screenLocked: false, applications: [officialObsidian, installedBridge] },
        appPath,
      )
    ).toThrow("another Blackglass Bridge app");

    expect(() =>
      assertMacOSLaunchPreflight(
        {
          screenLocked: false,
          applications: [{ ...installedBridge, bundlePath: appPath }],
        },
        appPath,
      )
    ).toThrow("exact generated Blackglass Bridge app");
  });

  test("parses listener ownership and accepts loopback endpoints only", () => {
    expect(
      parseLsofTcpListeners(
        `p100\nf12\nn127.0.0.1:${FINDER_LAUNCH_DEBUG_PORT}\n` +
          `p101\nf13\nn[::1]:${FINDER_LAUNCH_DEBUG_PORT}\n`,
      ),
    ).toEqual([
      { pid: 100, endpoint: `127.0.0.1:${FINDER_LAUNCH_DEBUG_PORT}` },
      { pid: 101, endpoint: `[::1]:${FINDER_LAUNCH_DEBUG_PORT}` },
    ]);
    expect(
      isLoopbackTcpListenerEndpoint(
        `127.0.0.1:${FINDER_LAUNCH_DEBUG_PORT}`,
        FINDER_LAUNCH_DEBUG_PORT,
      ),
    ).toBe(true);
    expect(
      isLoopbackTcpListenerEndpoint(
        `*:${FINDER_LAUNCH_DEBUG_PORT}`,
        FINDER_LAUNCH_DEBUG_PORT,
      ),
    ).toBe(false);
    expect(() => parseLsofTcpListeners("n127.0.0.1:9320\n")).toThrow();
  });

  test("keeps target, CDP, process, and cleanup diagnostics in failures", () => {
    const timeout = formatStarterTargetTimeout({
      timeoutMs: FINDER_LAUNCH_STARTER_TIMEOUT_MS,
      port: FINDER_LAUNCH_DEBUG_PORT,
      mainPid: 42,
      lastCdpError: "DevTools returned 503",
      lastTargets: [
        {
          id: "target-1",
          type: "page",
          url: "about:blank",
          hasWebSocketDebuggerUrl: true,
        },
      ],
      processes: ["42 ppid=1 /exact/app/Contents/MacOS/Obsidian"],
    });
    expect(timeout).toContain("within 90000ms after DevTools listener readiness");
    expect(timeout).toContain("DevTools returned 503");
    expect(timeout).toContain("target-1");
    expect(timeout).toContain("pid=1");

    expect(
      formatLaunchSmokeFailureMessage("starter failed", [
        "native termination failed",
        "socket remained",
      ]),
    ).toBe(
      "LaunchServices smoke failed: starter failed; cleanup failures: " +
        "native termination failed | socket remained",
    );
  });

  test("rejects early exit, crash reports, weak health, and profile escape", () => {
    for (const mutate of [
      (value: any) => (value.earlyExit = true),
      (value: any) => (value.crashReportsCreated = 1),
      (value: any) => (value.healthyForMs = FINDER_LAUNCH_MINIMUM_HEALTH_MS - 1),
      (value: any) => (value.rendererStableDuringHealth = false),
      (value: any) => (value.healthStartedAt = value.startedAt),
      (value: any) => (value.debugAddress = "0.0.0.0"),
      (value: any) => (value.debugListenerEndpoints = [`*:${FINDER_LAUNCH_DEBUG_PORT}`]),
      (value: any) => value.debugListenerEndpoints.push(value.debugListenerEndpoints[0]),
      (value: any) => (value.launchPreflight.screenLocked = true),
      (value: any) => (value.launchPreflight.matchingApplications = 1),
      (value: any) => value.launchPreflight.requiredAbsentBundleIdentifiers.pop(),
      (value: any) => (value.profilePath = "/Users/example/Library/Application Support/Blackglass Bridge"),
      (value: any) => (value.explicitUserDataDirUsed = true),
      (value: any) => (value.profileMode = 0o755),
      (value: any) => (value.profileRealDirectoryObserved = false),
      (value: any) => (value.profileSingletonArtifactsRemoved = false),
      (value: any) => (value.noLocalVaultAtLaunch = false),
      (value: any) => (value.starterNativeUiExercised = false),
      (value: any) => (value.starterControlRequests[1].status = 500),
      (value: any) => (value.starterControlOrigin = "https://api.obsidian.md"),
      (value: any) => (value.noVaultRegisteredAfterLaunch = false),
      (value: any) => (value.cliSocketObserved = false),
      (value: any) => (value.cliSocketRemoved = false),
      (value: any) => (value.upstreamCliSocketAbsent = false),
      (value: any) => (value.cliForwardedCommandSucceeded = false),
      (value: any) => (value.cliMainProcessReceiptObserved = false),
      (value: any) => (value.cliForwardedResponse = "unexpected"),
      (value: any) => (value.cliSocketName = ".obsidian-cli.sock"),
      (value: any) => (value.launchHomeSameDeviceAsArchive = false),
      (value: any) => (value.launchHomeRelocatedToRun = false),
      (value: any) => (value.launchHomeRootRemoved = false),
      (value: any) => (value.launchHomeRootMode = 0o755),
      (value: any) => (value.launchHomePath = "/Users/example/home"),
      (value: any) => (value.blackglassHomeEnvironment = "HOME"),
      (value: any) => (value.blackglassHomeEnvironmentObserved = false),
      (value: any) => (value.nativeHomeEnvironmentPreserved = false),
      (value: any) => (value.nativeHomePath = value.launchHomePath),
      (value: any) => (value.nativeTerminationAccepted = false),
      (value: any) => (value.signalFallbackUsed = true),
      (value: any) => (value.forcedTerminationUsed = true),
    ]) {
      const candidate = structuredClone(evidence()) as any;
      mutate(candidate);
      expect(() => assertFinderLaunchSmokeEvidence(candidate, options)).toThrow();
    }
  });

  test("rejects evidence copied to another artifact or run", () => {
    const wrongRun = structuredClone(evidence()) as any;
    wrongRun.runManifestSha256 = digest("c");
    expect(() => assertFinderLaunchSmokeEvidence(wrongRun, options)).toThrow(
      "not bound",
    );

    const wrongApp = structuredClone(evidence()) as any;
    wrongApp.applicationTreeSha256 = digest("d");
    expect(() => assertFinderLaunchSmokeEvidence(wrongApp, options)).toThrow(
      "not bound",
    );
  });
});
