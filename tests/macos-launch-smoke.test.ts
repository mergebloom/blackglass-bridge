import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
  parseStarterControlPost,
  parseLsofTcpListeners,
  starterSyncEntryRowIndex,
  waitForStarterSyncEntry,
  type FinderLaunchSmokeEvidence,
} from "../tools/macos-launch-smoke";
import type { MacOSArtifact } from "../tools/macos-artifact";

const digest = (character: string): string => character.repeat(64);
const root = "/workspace/blackglass/.data/e2e/release";
const appPath = "/workspace/blackglass/.data/build/Blackglass.app";
const officialAppPath = "/Applications/Obsidian.app";
const launcherExecutablePath = join(appPath, "Contents/MacOS/blackglass-bridge");
const controlOrigin = "https://blackglass.example.com";
const chromiumHostResolverRules = "MAP blackglass.example.com 127.0.0.1:8443";

test("failure cleanup waits for both the supervised launcher and official child", async () => {
  const source = await readFile(
    join(import.meta.dir, "../tools/smoke-macos-launch.ts"),
    "utf8",
  );
  expect(source).toContain("...exactNewAppProcesses(appPath, baselineAppPids)");
  expect(source).toContain("...exactNewAppProcesses(officialAppPath, baselineAppPids)");
  expect(source).toContain("waitForProcessExit(supervisedProcesses, 5_000)");
  expect(source).toContain("Supervised launcher did not exit");
});
const tlsSpkiSha256Base64 = `${"A".repeat(43)}=`;
const launchHomePath = "/private/tmp/blackglass-launch-ABC123/h";
const nativeHomePath = "/Users/example";
const artifact: Omit<MacOSArtifact, "appPath"> = {
  schemaVersion: 10,
  appBundleName: "Blackglass.app",
  bundleIdentifier: "com.blackglass.bridge",
  bundleName: "Blackglass",
  displayName: "Blackglass",
  blackglassVersion: "0.4.0",
  rendererVersion: "1.12.7",
  version: "1.12.7",
  executableName: "blackglass-bridge",
  infoPlistSha256: digest("1"),
  executableSha256: digest("2"),
  officialExecutableSha256: digest("f"),
  cliExecutableName: "blackglass-cli",
  cliExecutableSha256: digest("6"),
  cliSocketName: ".blackglass-c.sock",
  embeddedAsarSha256: digest("3"),
  launchConfigSha256: digest("4"),
  officialAppTreeSha256: digest("7"),
  officialCodeInventorySha256: digest("8"),
  officialExecutableName: "Obsidian",
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
  codeSigning: {
    signature: "ad-hoc",
    strictVerification: true,
    allArchitecturesVerified: true,
    bundleIdentifier: "com.blackglass.bridge",
    executableIdentifier: "com.blackglass.bridge",
    executableArchitectures: ["arm64"],
  },
  codeInventory: {
    formatVersion: 1,
    sha256: digest("8"),
    entries: [
      { path: ".", kind: "bundle", architectures: [] },
    ],
  },
  rootMetadata: {
    formatVersion: 2,
    sha256: digest("9"),
    mode: 493,
    bsdFlags: 0,
    ownerUidMatchesProcess: true,
    quarantineAbsent: true,
    entriesChecked: 2,
    entriesSha256: digest("a"),
    allEntriesOwnedByProcess: true,
    allEntriesBsdFlagsZero: true,
    allEntriesAclFree: true,
    unsupportedXattrsAbsent: true,
    xattrs: [],
    descendantXattrs: {
      allowedNames: ["com.apple.provenance"],
      entries: 0,
      sha256: digest("b"),
    },
  },
  profileDirectory: "Blackglass Profile",
  profileMode: 448,
  canonicalProfileRequired: true,
  explicitUserDataDirRequired: true,
  explicitUserDataDir: true,
  nativeHomePreserved: true,
  nativeHomeFallbackPreserved: true,
  blackglassHomeEnvironment: "BLACKGLASS_HOME",
  profileHomeEnvironment: "BLACKGLASS_HOME",
  dedicatedRuntimeHomeRequired: true,
  updateDisableSettingRequired: true,
  exactOfficialAppVerifiedAtEveryLaunch: true,
  officialAppUnmodified: true,
  officialChildSupervisionRequired: true,
  registeredUrlSchemes: [],
  upstreamICloudContainerRegistered: false,
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
    executableSha256: artifact.officialExecutableSha256,
    launcherExecutableSha256: artifact.executableSha256,
    embeddedAsarSha256: artifact.embeddedAsarSha256,
    tlsMetadataSha256: digest("c"),
    tlsSpkiSha256Base64,
    chromiumHostResolverRules,
    appPath,
    officialAppPath,
    launcherExecutablePath,
    executablePath: join(officialAppPath, "Contents/MacOS/Obsidian"),
    launchHomePath,
    launchHomeRootMode: 448,
    launchHomeSameDeviceAsArchive: true,
    launchHomeRelocatedToRun: true,
    launchHomeRootRemoved: true,
    cliExecutablePath: join(root, "launch-services-smoke/home/Library/Application Support/Blackglass Profile/blackglass-cli"),
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
      profilePath: join(
        launchHomePath,
        "Library/Application Support/Blackglass Profile",
      ),
      runtimeReceiptPath: join(layout.smokeRoot, "runtime-receipt.json"),
      chromiumHostResolverRules,
      tlsSpkiSha256Base64,
    }),
    launcherCommand: `${launcherExecutablePath} --blackglass-profile ${layout.profilePath}`,
    officialCommand: `${officialAppPath}/Contents/MacOS/Obsidian --user-data-dir=${layout.profilePath}`,
    officialChildOfLauncher: true,
    runtimeReceiptPath: join(layout.smokeRoot, "runtime-receipt.json"),
    runtimeReceiptSha256: digest("d"),
    debugPort: FINDER_LAUNCH_DEBUG_PORT,
    debugAddress: FINDER_LAUNCH_DEBUG_ADDRESS,
    debugListenerPid: 100,
    debugListenerEndpoints: [`${FINDER_LAUNCH_DEBUG_ADDRESS}:${FINDER_LAUNCH_DEBUG_PORT}`],
    debugTargetId: "starter-target",
    debugTargetUrl: "file:///Applications/Blackglass.app/Contents/Resources/starter.html",
    startedAt: "2026-07-28T12:00:00.000Z",
    healthStartedAt: "2026-07-28T12:00:01.000Z",
    healthyAt: "2026-07-28T12:00:09.000Z",
    completedAt: "2026-07-28T12:00:10.000Z",
    mainPid: 100,
    launcherPid: 99,
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
    explicitUserDataDirUsed: true,
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
  officialAppPath,
  launcherExecutablePath,
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

    const installedBlackglass = {
      pid: 11,
      bundleIdentifier: BLACKGLASS_BUNDLE_IDENTIFIER,
      bundlePath: "/Applications/Blackglass.app",
      executablePath: "/Applications/Blackglass.app/Contents/MacOS/Obsidian",
    };
    expect(() =>
      assertMacOSLaunchPreflight(
        { screenLocked: false, applications: [officialObsidian, installedBlackglass] },
        appPath,
      )
    ).toThrow("another Blackglass app");

    expect(() =>
      assertMacOSLaunchPreflight(
        {
          screenLocked: false,
          applications: [{ ...installedBlackglass, bundlePath: appPath }],
        },
        appPath,
      )
    ).toThrow("exact generated Blackglass app");
  });

  test("counts starter control POSTs without treating CORS preflights as duplicates", () => {
    expect(parseStarterControlPost({
      method: "OPTIONS",
      url: `${controlOrigin}/user/signin`,
    })).toBeUndefined();
    expect(parseStarterControlPost({
      method: "POST",
      url: `${controlOrigin}/user/signin`,
    })).toEqual({
      method: "POST",
      origin: controlOrigin,
      path: "/user/signin",
    });
    expect(parseStarterControlPost({
      method: "POST",
      url: `${controlOrigin}/vault/list`,
    })).toEqual({
      method: "POST",
      origin: controlOrigin,
      path: "/vault/list",
    });
    expect(parseStarterControlPost({
      method: "POST",
      url: `${controlOrigin}/subscription/list`,
    })).toBeUndefined();
    expect(parseStarterControlPost({ method: "POST", url: "not a URL" })).toBeUndefined();
  });

  test("waits for the native starter Sync entry instead of racing renderer hydration", async () => {
    let currentTime = 0;
    let attempts = 0;
    const result = await waitForStarterSyncEntry(
      async () => ({
        opened: ++attempts === 3,
        href: "app://obsidian.md/starter.html",
        readyState: attempts === 1 ? "loading" : "complete",
        rows: attempts < 3
          ? []
          : [{ name: "Open vault from Obsidian Sync", button: "Sign in" }],
      }),
      {
        timeoutMs: 10,
        intervalMs: 2,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      },
    );
    expect(attempts).toBe(3);
    expect(result).toEqual({
      opened: true,
      href: "app://obsidian.md/starter.html",
      readyState: "complete",
      rows: [{ name: "Open vault from Obsidian Sync", button: "Sign in" }],
    });
  });

  test("selects the reviewed third starter row independently of localized labels", () => {
    for (const name of [
      "Open vault from Obsidian Sync",
      "Obsidian سینک",
      "同步远程仓库",
      "ከ Obsidian ማመሳሰል",
    ]) {
      expect(starterSyncEntryRowIndex({
        opened: false,
        href: "app://obsidian.md/starter.html",
        readyState: "complete",
        rows: [
          { name: "localized create", button: "localized button" },
          { name: "localized open", button: "localized button" },
          { name, button: "localized button" },
        ],
      })).toBe(2);
    }
    for (const rows of [
      [],
      [{ name: "create", button: "button" }],
      [
        { name: "create", button: "button" },
        { name: "open", button: "button" },
        { name: "sync", button: null },
      ],
    ]) {
      expect(starterSyncEntryRowIndex({
        opened: false,
        href: "app://obsidian.md/starter.html",
        readyState: "complete",
        rows,
      })).toBeUndefined();
    }
  });

  test("reports bounded starter DOM diagnostics when the Sync entry never appears", async () => {
    let currentTime = 0;
    const waiting = waitForStarterSyncEntry(
      async () => ({
        opened: false,
        href: "app://obsidian.md/starter.html",
        readyState: "complete",
        rows: [{ name: "Create new vault", button: "Create" }],
      }),
      {
        timeoutMs: 4,
        intervalMs: 2,
        now: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      },
    );
    await expect(waiting).rejects.toThrow(
      '"rows":[{"button":"Create","name":"Create new vault"}]',
    );
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
      (value: any) => (value.profilePath = "/Users/example/Library/Application Support/Blackglass Profile"),
      (value: any) => (value.explicitUserDataDirUsed = false),
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
      (value: any) => {
        const profileArgument = value.launchCommand.indexOf("--blackglass-profile") + 1;
        value.launchCommand[profileArgument] = value.profilePath;
      },
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
