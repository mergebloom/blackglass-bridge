import { describe, expect, test } from "bun:test";
import type { ClientLaunchIdentity } from "../tools/e2e-client";
import {
  assertNetworkCaptureFinalize,
  assertNetworkEvidence,
  buildNetworkRequirements,
  requiredControlRoutes,
  sanitizeNetworkUrl,
  type E2ENetworkEvent,
  type E2ENetworkEvidence,
  type E2ENetworkCaptureFinalize,
} from "../tools/e2e-network-evidence";
import {
  deriveE2ENetworkPlan,
  type PreparedE2ERunManifest,
} from "../tools/e2e-network";

const endpoints = {
  controlOrigin: "https://blackglass.example.com",
  dataHost: "blackglass-data.example.com",
};
const run: PreparedE2ERunManifest = {
  schemaVersion: 4,
  endpoints,
  network: deriveE2ENetworkPlan(endpoints),
  compatibilityAsarSha256: "a".repeat(64),
  releaseManifestSha256: "b".repeat(64),
  adapterFileName: "obsidian-1.12.7.asar",
  releaseManifestFileName: "blackglass-release-manifest.json",
  reproducibilityEvidenceFileName: "client-reproducibility.json",
  reproducibilityEvidenceSha256: "c".repeat(64),
};
const identity = {
  schemaVersion: 4,
  runManifestSha256: "c".repeat(64),
  releaseManifestSha256: run.releaseManifestSha256,
  startedAt: "2026-07-28T10:00:00.000Z",
  pid: 100,
  launchCommand: "launch",
  debugPort: 9222,
  debugListenerPid: 101,
  debugListenerCommand: "listener",
  debugTargetId: "renderer-1",
  debugTargetUrl: "file:///app/index.html",
  executablePath: "/app/Obsidian",
  executableSha256: "d".repeat(64),
  appBundlePath: "/app/Blackglass.app",
  appArtifactSha256: "e".repeat(64),
  appArtifact: {},
  adapterPath: "/run/client-a/user-data/obsidian-1.12.7.asar",
  adapterSha256: run.compatibilityAsarSha256,
  profilePath: "/run/client-a/user-data",
  blackglassHomePath: "/private/tmp/blackglass-client-ABC123/h",
  blackglassHomeEnvironment: "BLACKGLASS_HOME",
  blackglassHomeMode: 0o700,
  blackglassHomeCanonical: true,
  cliSocketPath: "/private/tmp/blackglass-client-ABC123/h/.blackglass-c.sock",
  nativeHomePath: "/Users/example",
  nativeHomeEnvironmentPreserved: true,
  vaultPath: "/run/client-a/vault",
  tlsMetadataPath: "/run/tls-metadata.json",
  tlsMetadataSha256: "f".repeat(64),
  tlsSpkiSha256Base64: `${"A".repeat(43)}=`,
} as ClientLaunchIdentity;
const finalize: E2ENetworkCaptureFinalize = {
  schemaVersion: 1,
  role: "client-a",
  phase: "post-restart",
  requestedAt: "2026-07-28T10:00:01.800Z",
  handshakeNotBefore: "2026-07-28T10:00:01.500Z",
  runManifestSha256: identity.runManifestSha256,
  context: {
    serverRestartIdentitySha256: "7".repeat(64),
    observationsSha256: {
      one: "8".repeat(64),
      two: "9".repeat(64),
      three: "a".repeat(64),
      four: "b".repeat(64),
    },
  },
};
const finalizePath = "/run/evidence/network-client-a.finalize.json";
const finalizeSha256 = "2".repeat(64);

const assertionOptions = {
  role: "client-a" as const,
  run,
  runManifestSha256: identity.runManifestSha256,
  identityPath: "/run/client-a-launch.json",
  identitySha256: "1".repeat(64),
  identity,
  finalizePath,
  finalizeSha256,
  finalize,
};

describe("E2E network evidence", () => {
  test("redacts query and fragment material from captured URLs", () => {
    expect(
      sanitizeNetworkUrl(
        "https://blackglass.example.com/vault/list?token=secret#fragment",
      ),
    ).toEqual({
      scheme: "https:",
      authority: "blackglass.example.com",
      hostname: "blackglass.example.com",
      port: "",
      pathname: "/vault/list",
    });
  });

  test("requires successful exact control routes and WSS handshake", () => {
    const events = validEvents("client-a");
    const requirements = buildNetworkRequirements(
      "client-a",
      run,
      events,
      finalize.handshakeNotBefore,
    );
    const evidence: E2ENetworkEvidence = {
      schemaVersion: 2,
      role: "client-a",
      startedAt: "2026-07-28T10:00:01.000Z",
      completedAt: "2026-07-28T10:00:02.000Z",
      passed: true,
      finalize: {
        path: finalizePath,
        sha256: finalizeSha256,
        phase: finalize.phase,
        requestedAt: finalize.requestedAt,
        handshakeNotBefore: finalize.handshakeNotBefore,
      },
      launch: {
        identityPath: "/run/client-a-launch.json",
        identitySha256: "1".repeat(64),
        runManifestSha256: identity.runManifestSha256,
        releaseManifestSha256: identity.releaseManifestSha256,
        launchedPid: identity.pid,
        debugPort: identity.debugPort,
        debugListenerPid: identity.debugListenerPid,
        debugTargetId: identity.debugTargetId,
        debugTargetUrl: identity.debugTargetUrl,
        profilePath: identity.profilePath,
        vaultPath: identity.vaultPath,
      },
      requirements,
      events,
    };
    expect(() =>
      assertNetworkEvidence(evidence, assertionOptions),
    ).not.toThrow();

    const loopback = structuredClone(evidence);
    loopback.events.push({
      sequence: loopback.events.length + 1,
      observedAt: "2026-07-28T10:00:01.900Z",
      kind: "request",
      requestId: "fallback",
      method: "POST",
      url: {
        scheme: "http:",
        authority: "127.0.0.1:3000",
        hostname: "127.0.0.1",
        port: "3000",
        pathname: "/user/signin",
      },
    });
    loopback.requirements = buildNetworkRequirements(
      "client-a",
      run,
      loopback.events,
      finalize.handshakeNotBefore,
    );
    expect(() =>
      assertNetworkEvidence(loopback, assertionOptions),
    ).toThrow("unexpected control-plane authority");

    const upstream = structuredClone(evidence);
    upstream.events.push({
      sequence: upstream.events.length + 1,
      observedAt: "2026-07-28T10:00:01.950Z",
      kind: "request",
      requestId: "upstream",
      method: "POST",
      url: {
        scheme: "https:",
        authority: "api.obsidian.md",
        hostname: "api.obsidian.md",
        port: "",
        pathname: "/user/info",
      },
    });
    upstream.requirements = buildNetworkRequirements(
      "client-a",
      run,
      upstream.events,
      finalize.handshakeNotBefore,
    );
    expect(() =>
      assertNetworkEvidence(upstream, assertionOptions),
    ).toThrow("unexpected control-plane authority");

    const initialOnly = structuredClone(evidence);
    initialOnly.events = initialOnly.events.filter(
      (event) => Date.parse(event.observedAt) < Date.parse(finalize.handshakeNotBefore),
    );
    initialOnly.events.forEach((event, index) => (event.sequence = index + 1));
    initialOnly.requirements = buildNetworkRequirements(
      "client-a",
      run,
      initialOnly.events,
      finalize.handshakeNotBefore,
    );
    expect(() => assertNetworkEvidence(initialOnly, assertionOptions)).toThrow(
      "did not exercise every required endpoint",
    );

    const unpaired = structuredClone(evidence);
    unpaired.events = unpaired.events.filter(
      (event) => !(event.kind === "webSocketCreated" && event.requestId === "socket-2"),
    );
    unpaired.events.forEach((event, index) => (event.sequence = index + 1));
    unpaired.requirements = buildNetworkRequirements(
      "client-a",
      run,
      unpaired.events,
      finalize.handshakeNotBefore,
    );
    expect(() => assertNetworkEvidence(unpaired, assertionOptions)).toThrow(
      "did not exercise every required endpoint",
    );

    const responseFirst = structuredClone(evidence);
    [responseFirst.events[0], responseFirst.events[1]] = [
      responseFirst.events[1]!,
      responseFirst.events[0]!,
    ];
    responseFirst.events.forEach((event, index) => (event.sequence = index + 1));
    responseFirst.requirements = buildNetworkRequirements(
      "client-a",
      run,
      responseFirst.events,
      finalize.handshakeNotBefore,
    );
    expect(() => assertNetworkEvidence(responseFirst, assertionOptions)).toThrow(
      "did not exercise every required endpoint",
    );
  });

  test("uses a distinct cold-recovery finalizer and route set", () => {
    expect(requiredControlRoutes("client-b-recovery")).toEqual([
      "/user/signin",
      "/vault/list",
      "/vault/access",
    ]);
    const recoveryFinalize: E2ENetworkCaptureFinalize = {
      schemaVersion: 1,
      role: "client-b-recovery",
      phase: "cold-recovery",
      requestedAt: "2026-07-28T10:01:00.000Z",
      handshakeNotBefore: "2026-07-28T10:00:30.000Z",
      runManifestSha256: identity.runManifestSha256,
      context: {
        sourceLossResetSha256: "1".repeat(64),
        recoveryLaunchSha256: "2".repeat(64),
        recoveryReportSha256: "3".repeat(64),
        recoveryUiStateSha256: "4".repeat(64),
        recoveryScreenshotSha256: "5".repeat(64),
      },
    };
    expect(() =>
      assertNetworkCaptureFinalize(recoveryFinalize, {
        role: "client-b-recovery",
        runManifestSha256: identity.runManifestSha256,
      }),
    ).not.toThrow();
    expect(() =>
      assertNetworkCaptureFinalize(
        { ...recoveryFinalize, phase: "post-restart" },
        {
          role: "client-b-recovery",
          runManifestSha256: identity.runManifestSha256,
        },
      ),
    ).toThrow();
  });
});

function validEvents(role: "client-a" | "client-b"): E2ENetworkEvent[] {
  const routes = role === "client-a"
    ? ["/user/signin", "/vault/create", "/vault/access"]
    : ["/user/signin", "/vault/list", "/vault/access"];
  const events: E2ENetworkEvent[] = [];
  const add = (event: Omit<E2ENetworkEvent, "sequence">): void => {
    events.push({ ...event, sequence: events.length + 1 } as E2ENetworkEvent);
  };
  for (const [index, pathname] of routes.entries()) {
    const requestId = `request-${index}`;
    const url = {
      scheme: "https:" as const,
      authority: "blackglass.example.com",
      hostname: "blackglass.example.com",
      port: "",
      pathname,
    };
    add({
      observedAt: "2026-07-28T10:00:01.100Z",
      kind: "request",
      requestId,
      method: "POST",
      url,
    } as Omit<Extract<E2ENetworkEvent, { kind: "request" }>, "sequence">);
    add({
      observedAt: "2026-07-28T10:00:01.200Z",
      kind: "response",
      requestId,
      status: 200,
      url,
    } as Omit<Extract<E2ENetworkEvent, { kind: "response" }>, "sequence">);
  }
  const socketUrl = {
    scheme: "wss:" as const,
    authority: "blackglass-data.example.com",
    hostname: "blackglass-data.example.com",
    port: "",
    pathname: "/",
  };
  add({
    observedAt: "2026-07-28T10:00:01.300Z",
    kind: "webSocketCreated",
    requestId: "socket-1",
    url: socketUrl,
  } as Omit<Extract<E2ENetworkEvent, { kind: "webSocketCreated" }>, "sequence">);
  add({
    observedAt: "2026-07-28T10:00:01.400Z",
    kind: "webSocketHandshake",
    requestId: "socket-1",
    status: 101,
    url: socketUrl,
  } as Omit<Extract<E2ENetworkEvent, { kind: "webSocketHandshake" }>, "sequence">);
  add({
    observedAt: "2026-07-28T10:00:01.600Z",
    kind: "webSocketCreated",
    requestId: "socket-2",
    url: socketUrl,
  } as Omit<Extract<E2ENetworkEvent, { kind: "webSocketCreated" }>, "sequence">);
  add({
    observedAt: "2026-07-28T10:00:01.700Z",
    kind: "webSocketHandshake",
    requestId: "socket-2",
    status: 101,
    url: socketUrl,
  } as Omit<Extract<E2ENetworkEvent, { kind: "webSocketHandshake" }>, "sequence">);
  return events;
}
