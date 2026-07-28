import { join } from "node:path";
import type { ClientLaunchIdentity } from "./e2e-client";
import type { PreparedE2ERunManifest } from "./e2e-network";

export const E2E_NETWORK_EVIDENCE_SCHEMA_VERSION = 2;

export type E2EClientRole = "client-a" | "client-b" | "client-b-recovery";
export type E2ENetworkLifecyclePhase = "post-restart" | "cold-recovery";

export interface E2ENetworkCaptureFinalize {
  schemaVersion: 1;
  role: E2EClientRole;
  phase: E2ENetworkLifecyclePhase;
  requestedAt: string;
  handshakeNotBefore: string;
  runManifestSha256: string;
  context:
    | {
        serverRestartIdentitySha256: string;
        observationsSha256: Record<string, string>;
      }
    | {
        sourceLossResetSha256: string;
        recoveryLaunchSha256: string;
        recoveryReportSha256: string;
        recoveryUiStateSha256: string;
        recoveryScreenshotSha256: string;
      };
}

export interface SanitizedNetworkUrl {
  scheme: "http:" | "https:" | "ws:" | "wss:";
  authority: string;
  hostname: string;
  port: string;
  pathname: string;
}

export type E2ENetworkEvent =
  | {
      sequence: number;
      observedAt: string;
      kind: "request";
      requestId: string;
      method: string;
      url: SanitizedNetworkUrl;
    }
  | {
      sequence: number;
      observedAt: string;
      kind: "response";
      requestId: string;
      status: number;
      url: SanitizedNetworkUrl;
    }
  | {
      sequence: number;
      observedAt: string;
      kind: "webSocketCreated";
      requestId: string;
      url: SanitizedNetworkUrl;
    }
  | {
      sequence: number;
      observedAt: string;
      kind: "webSocketHandshake";
      requestId: string;
      status: number;
      url: SanitizedNetworkUrl;
    }
  | {
      sequence: number;
      observedAt: string;
      kind: "failure";
      requestId: string;
      errorText: string;
    };

export interface E2ENetworkEvidence {
  schemaVersion: typeof E2E_NETWORK_EVIDENCE_SCHEMA_VERSION;
  role: E2EClientRole;
  startedAt: string;
  completedAt: string;
  passed: boolean;
  finalize: {
    path: string;
    sha256: string;
    phase: E2ENetworkLifecyclePhase;
    requestedAt: string;
    handshakeNotBefore: string;
  };
  launch: {
    identityPath: string;
    identitySha256: string;
    runManifestSha256: string;
    releaseManifestSha256: string;
    launchedPid: number;
    debugPort: number;
    debugListenerPid: number;
    debugTargetId: string;
    debugTargetUrl: string;
    profilePath: string;
    vaultPath: string;
  };
  requirements: {
    controlOrigin: string;
    controlRoutes: string[];
    successfulControlRoutes: string[];
    dataAuthority: string;
    successfulDataHandshake: boolean;
    successfulLifecycleDataHandshake: boolean;
  };
  events: E2ENetworkEvent[];
}

const CONTROL_ROUTES: Record<E2EClientRole, readonly string[]> = {
  "client-a": ["/user/signin", "/vault/create", "/vault/access"],
  "client-b": ["/user/signin", "/vault/list", "/vault/access"],
  "client-b-recovery": ["/user/signin", "/vault/list", "/vault/access"],
};

export function requiredControlRoutes(role: E2EClientRole): string[] {
  return [...CONTROL_ROUTES[role]];
}

export function e2eNetworkEvidencePath(root: string, role: E2EClientRole): string {
  return join(root, "evidence", `network-${role}.json`);
}

export function e2eNetworkFinalizePath(root: string, role: E2EClientRole): string {
  return join(root, "evidence", `network-${role}.finalize.json`);
}

export function sanitizeNetworkUrl(value: string): SanitizedNetworkUrl | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    return undefined;
  }
  if (parsed.username || parsed.password) {
    throw new Error("Network evidence URL unexpectedly contained credentials");
  }
  return {
    scheme: parsed.protocol as SanitizedNetworkUrl["scheme"],
    authority: parsed.host,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
  };
}

export function buildNetworkRequirements(
  role: E2EClientRole,
  run: PreparedE2ERunManifest,
  events: E2ENetworkEvent[],
  handshakeNotBefore: string,
): E2ENetworkEvidence["requirements"] {
  const required = requiredControlRoutes(role);
  const control = new URL(run.endpoints.controlOrigin);
  const successfulControlRoutes = required.filter((pathname) =>
    events.some(
      (event) =>
        event.kind === "response" &&
        event.status >= 200 &&
        event.status < 300 &&
        event.url.scheme === "https:" &&
        event.url.authority === control.host &&
        event.url.pathname === pathname &&
        events.some(
          (candidate) =>
            candidate.kind === "request" &&
            candidate.requestId === event.requestId &&
            candidate.method === "POST" &&
            candidate.url.scheme === "https:" &&
            candidate.url.authority === control.host &&
            candidate.url.pathname === pathname,
        ),
    ),
  );
  const successfulDataHandshake = events.some(
    (event) =>
      event.kind === "webSocketHandshake" &&
      event.status === 101 &&
      event.url.scheme === "wss:" &&
      event.url.authority === run.endpoints.dataHost &&
      hasCreatedSocket(events, event),
  );
  const successfulLifecycleDataHandshake = events.some(
    (event) =>
      event.kind === "webSocketHandshake" &&
      event.status === 101 &&
      event.url.scheme === "wss:" &&
      event.url.authority === run.endpoints.dataHost &&
      hasCreatedSocket(events, event) &&
      Date.parse(event.observedAt) >= Date.parse(handshakeNotBefore),
  );
  return {
    controlOrigin: run.endpoints.controlOrigin,
    controlRoutes: required,
    successfulControlRoutes,
    dataAuthority: run.endpoints.dataHost,
    successfulDataHandshake,
    successfulLifecycleDataHandshake,
  };
}

function hasCreatedSocket(
  events: E2ENetworkEvent[],
  handshake: Extract<E2ENetworkEvent, { kind: "webSocketHandshake" }>,
): boolean {
  return events.some(
    (event) =>
      event.kind === "webSocketCreated" &&
      event.requestId === handshake.requestId &&
      event.sequence < handshake.sequence &&
      stableJson(event.url) === stableJson(handshake.url),
  );
}

export function assertNetworkCaptureFinalize(
  value: unknown,
  options: {
    role: E2EClientRole;
    runManifestSha256: string;
  },
): asserts value is E2ENetworkCaptureFinalize {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.role !== options.role ||
    value.runManifestSha256 !== options.runManifestSha256 ||
    !["post-restart", "cold-recovery"].includes(String(value.phase)) ||
    typeof value.requestedAt !== "string" ||
    typeof value.handshakeNotBefore !== "string" ||
    !Number.isFinite(Date.parse(value.requestedAt)) ||
    !Number.isFinite(Date.parse(value.handshakeNotBefore)) ||
    Date.parse(value.requestedAt) < Date.parse(value.handshakeNotBefore) ||
    ((options.role === "client-b-recovery") !== (value.phase === "cold-recovery")) ||
    !isRecord(value.context)
  ) {
    throw new Error("Malformed or mismatched network capture finalizer");
  }
  if (value.phase === "post-restart") {
    if (
      !isSha256(value.context.serverRestartIdentitySha256) ||
      !isRecord(value.context.observationsSha256) ||
      Object.keys(value.context.observationsSha256).length !== 4 ||
      Object.values(value.context.observationsSha256).some((hash) => !isSha256(hash))
    ) {
      throw new Error("Network finalizer lacks post-restart evidence bindings");
    }
  } else if (
    !isSha256(value.context.sourceLossResetSha256) ||
    !isSha256(value.context.recoveryLaunchSha256) ||
    !isSha256(value.context.recoveryReportSha256) ||
    !isSha256(value.context.recoveryUiStateSha256) ||
    !isSha256(value.context.recoveryScreenshotSha256)
  ) {
    throw new Error("Network finalizer lacks cold-recovery evidence bindings");
  }
}

export function assertNetworkEvidence(
  value: unknown,
  options: {
    role: E2EClientRole;
    run: PreparedE2ERunManifest;
    runManifestSha256: string;
    identityPath: string;
    identitySha256: string;
    identity: ClientLaunchIdentity;
    finalizePath: string;
    finalizeSha256: string;
    finalize: E2ENetworkCaptureFinalize;
  },
): asserts value is E2ENetworkEvidence {
  if (!isRecord(value) || value.schemaVersion !== E2E_NETWORK_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Unsupported E2E network evidence schema");
  }
  if (
    value.role !== options.role ||
    value.passed !== true ||
    typeof value.startedAt !== "string" ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
    !isRecord(value.finalize) ||
    !isRecord(value.launch) ||
    !isRecord(value.requirements) ||
    !Array.isArray(value.events)
  ) {
    throw new Error("Malformed E2E network evidence");
  }
  const identity = options.identity;
  assertNetworkCaptureFinalize(options.finalize, {
    role: options.role,
    runManifestSha256: options.runManifestSha256,
  });
  if (
    value.launch.identityPath !== options.identityPath ||
    value.launch.identitySha256 !== options.identitySha256 ||
    value.launch.runManifestSha256 !== options.runManifestSha256 ||
    value.launch.releaseManifestSha256 !== identity.releaseManifestSha256 ||
    value.launch.launchedPid !== identity.pid ||
    value.launch.debugPort !== identity.debugPort ||
    value.launch.debugListenerPid !== identity.debugListenerPid ||
    value.launch.debugTargetId !== identity.debugTargetId ||
    value.launch.debugTargetUrl !== identity.debugTargetUrl ||
    value.launch.profilePath !== identity.profilePath ||
    value.launch.vaultPath !== identity.vaultPath ||
    Date.parse(value.startedAt) < Date.parse(identity.startedAt)
  ) {
    throw new Error("E2E network evidence is not bound to the live client launch");
  }
  if (
    value.finalize.path !== options.finalizePath ||
    value.finalize.sha256 !== options.finalizeSha256 ||
    value.finalize.phase !== options.finalize.phase ||
    value.finalize.requestedAt !== options.finalize.requestedAt ||
    value.finalize.handshakeNotBefore !== options.finalize.handshakeNotBefore ||
    Date.parse(value.completedAt) < Date.parse(options.finalize.requestedAt)
  ) {
    throw new Error("E2E network evidence is not bound to its lifecycle finalizer");
  }
  const events = value.events.map((event, index) => validateEvent(event, index));
  if (
    events.some(
      (event) =>
        Date.parse(event.observedAt) < Date.parse(value.startedAt as string) ||
        Date.parse(event.observedAt) > Date.parse(value.completedAt as string),
    )
  ) {
    throw new Error("E2E network event is outside the capture interval");
  }
  const reproduced = buildNetworkRequirements(
    options.role,
    options.run,
    events,
    options.finalize.handshakeNotBefore,
  );
  if (stableJson(value.requirements) !== stableJson(reproduced)) {
    throw new Error("E2E network evidence requirements do not match its events");
  }
  if (
    reproduced.controlOrigin !== options.run.endpoints.controlOrigin ||
    stableJson(reproduced.controlRoutes) !== stableJson(requiredControlRoutes(options.role)) ||
    stableJson(reproduced.successfulControlRoutes) !== stableJson(reproduced.controlRoutes) ||
    reproduced.dataAuthority !== options.run.endpoints.dataHost ||
    reproduced.successfulDataHandshake !== true ||
    reproduced.successfulLifecycleDataHandshake !== true
  ) {
    throw new Error("E2E network evidence did not exercise every required endpoint");
  }
  assertNoEndpointBypass(events, options.run);
}

function validateEvent(value: unknown, index: number): E2ENetworkEvent {
  if (
    !isRecord(value) ||
    value.sequence !== index + 1 ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.kind !== "string"
  ) {
    throw new Error("Malformed E2E network event");
  }
  if (value.kind === "failure") {
    if (typeof value.errorText !== "string" || value.errorText.length === 0) {
      throw new Error("Malformed E2E network failure event");
    }
    return value as unknown as E2ENetworkEvent;
  }
  assertSanitizedUrl(value.url);
  if (value.kind === "request") {
    if (typeof value.method !== "string" || value.method.length === 0) {
      throw new Error("Malformed E2E request event");
    }
  } else if (value.kind === "response" || value.kind === "webSocketHandshake") {
    if (
      typeof value.status !== "number" ||
      !Number.isInteger(value.status) ||
      value.status < 100 ||
      value.status > 599
    ) {
      throw new Error("Malformed E2E response event");
    }
  } else if (value.kind !== "webSocketCreated") {
    throw new Error("Unknown E2E network event kind");
  }
  return value as unknown as E2ENetworkEvent;
}

function assertSanitizedUrl(value: unknown): asserts value is SanitizedNetworkUrl {
  if (
    !isRecord(value) ||
    !["http:", "https:", "ws:", "wss:"].includes(String(value.scheme)) ||
    typeof value.authority !== "string" ||
    typeof value.hostname !== "string" ||
    typeof value.port !== "string" ||
    typeof value.pathname !== "string" ||
    value.pathname.includes("?") ||
    value.pathname.includes("#")
  ) {
    throw new Error("Malformed sanitized network URL");
  }
}

function assertNoEndpointBypass(
  events: E2ENetworkEvent[],
  run: PreparedE2ERunManifest,
): void {
  const control = new URL(run.endpoints.controlOrigin);
  for (const event of events) {
    if (event.kind === "failure") continue;
    const { url } = event;
    if (
      isControlPlanePath(url.pathname) &&
      (url.scheme !== "https:" || url.authority !== control.host)
    ) {
      throw new Error("E2E client used an unexpected control-plane authority");
    }
    if (
      (event.kind === "webSocketCreated" || event.kind === "webSocketHandshake") &&
      (url.scheme !== "wss:" || url.authority !== run.endpoints.dataHost)
    ) {
      throw new Error("E2E client used an unexpected Sync WebSocket authority");
    }
  }
}

export function isControlPlanePath(pathname: string): boolean {
  return /^\/(?:publish|subscription|user|vault)(?:\/|$)/u.test(pathname);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
