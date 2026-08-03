import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseStrictFlags } from "./cli-flags";
import { verifyLiveClientLaunchBinding } from "./e2e-client";
import {
  buildNetworkRequirements,
  expectsSuccessfulDataHandshake,
  assertNetworkCaptureFinalize,
  e2eNetworkEvidencePath,
  e2eNetworkFinalizePath,
  e2eNetworkLaunchIdentityFile,
  type E2EClientRole,
  type E2ENetworkCaptureFinalize,
  type E2ENetworkEvent,
  type E2ENetworkEvidence,
  isControlPlanePath,
  sanitizeNetworkUrl,
} from "./e2e-network-evidence";
import { readPreparedE2ERun } from "./e2e-network";

const [rootArgument, roleArgument, ...flagArguments] = Bun.argv.slice(2);
if (
  !rootArgument ||
  ![
    "client-a", "client-b", "client-c", "client-b-initial", "client-b-cold",
    "client-b-recovery",
  ].includes(roleArgument ?? "")
) {
  throw new Error(
    "Usage: bun run tools/capture-e2e-network.ts <run-directory> " +
      "<client-a|client-b|client-c|client-b-initial|client-b-cold|client-b-recovery> " +
      "[--timeout-ms <ms>] [--drain-ms <ms>]",
  );
}
const role = roleArgument as E2EClientRole;
const flags = parseStrictFlags(flagArguments, {
  valueFlags: ["--timeout-ms", "--drain-ms"],
  booleanFlags: [],
});
const timeoutMs = parseTimeout(flags.values.get("--timeout-ms") ?? "3600000");
const drainMs = parseDrain(flags.values.get("--drain-ms") ?? "5000");
const run = await readPreparedE2ERun(rootArgument);
const identityPath = resolve(run.root, e2eNetworkLaunchIdentityFile(role));
const launch = await verifyLiveClientLaunchBinding(identityPath);
if (launch.run.manifestSha256 !== run.manifestSha256) {
  throw new Error("Live client launch belongs to a different E2E run");
}
if (!launch.rendererTarget.webSocketDebuggerUrl) {
  throw new Error("Bound renderer target has no DevTools WebSocket URL");
}
const outputPath = e2eNetworkEvidencePath(run.root, role);
const finalizePath = e2eNetworkFinalizePath(run.root, role);
await mkdir(dirname(outputPath), { recursive: true });
if (await Bun.file(outputPath).exists()) {
  throw new Error(`Refusing to overwrite E2E network evidence: ${outputPath}`);
}

const events: E2ENetworkEvent[] = [];
type UnsequencedNetworkEvent = E2ENetworkEvent extends infer Event
  ? Event extends E2ENetworkEvent
    ? Omit<Event, "sequence">
    : never
  : never;
const webSocketUrls = new Map<string, ReturnType<typeof sanitizeNetworkUrl>>();
const startedAt = new Date().toISOString();
let settled = false;
let drainTimer: ReturnType<typeof setTimeout> | undefined;
let finalizePollInFlight = false;
let finalizeBinding:
  | {
      bytes: Buffer;
      sha256: string;
      record: E2ENetworkCaptureFinalize;
    }
  | undefined;
let nextCommandId = 1;
const socket = new WebSocket(launch.rendererTarget.webSocketDebuggerUrl);

await new Promise<void>((resolveOpen, rejectOpen) => {
  const timer = setTimeout(
    () => rejectOpen(new Error("Timed out opening the bound DevTools target")),
    5_000,
  );
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    resolveOpen();
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    rejectOpen(new Error("Failed to open the bound DevTools target"));
  }, { once: true });
});

const enableId = nextCommandId++;
const enabled = new Promise<void>((resolveEnabled, rejectEnabled) => {
  const timer = setTimeout(
    () => rejectEnabled(new Error("Timed out enabling DevTools Network events")),
    5_000,
  );
  const listener = (message: MessageEvent) => {
    const value = JSON.parse(String(message.data)) as { id?: number; error?: unknown };
    if (value.id !== enableId) return;
    socket.removeEventListener("message", listener);
    clearTimeout(timer);
    if (value.error) rejectEnabled(new Error("DevTools rejected Network.enable"));
    else resolveEnabled();
  };
  socket.addEventListener("message", listener);
});
socket.send(JSON.stringify({ id: enableId, method: "Network.enable" }));
await enabled;

socket.addEventListener("message", (message) => {
  if (settled) return;
  const value = JSON.parse(String(message.data)) as {
    method?: string;
    params?: Record<string, any>;
  };
  const params = value.params ?? {};
  const observedAt = new Date().toISOString();
  if (value.method === "Network.requestWillBeSent") {
    const url = sanitizeNetworkUrl(String(params.request?.url ?? ""));
    if (url && relevantUrl(url)) record({
      observedAt,
      kind: "request",
      requestId: String(params.requestId ?? ""),
      method: String(params.request?.method ?? ""),
      url,
    });
  } else if (value.method === "Network.responseReceived") {
    const url = sanitizeNetworkUrl(String(params.response?.url ?? ""));
    if (url && relevantUrl(url)) record({
      observedAt,
      kind: "response",
      requestId: String(params.requestId ?? ""),
      status: Number(params.response?.status),
      url,
    });
  } else if (value.method === "Network.webSocketCreated") {
    const url = sanitizeNetworkUrl(String(params.url ?? ""));
    if (url && relevantUrl(url)) {
      webSocketUrls.set(String(params.requestId ?? ""), url);
      record({
        observedAt,
        kind: "webSocketCreated",
        requestId: String(params.requestId ?? ""),
        url,
      });
    }
  } else if (value.method === "Network.webSocketHandshakeResponseReceived") {
    const requestId = String(params.requestId ?? "");
    const url = webSocketUrls.get(requestId);
    if (url) record({
      observedAt,
      kind: "webSocketHandshake",
      requestId,
      status: Number(params.response?.status),
      url,
    });
  } else if (value.method === "Network.loadingFailed") {
    record({
      observedAt,
      kind: "failure",
      requestId: String(params.requestId ?? "unknown"),
      errorText: String(params.errorText ?? "unknown network failure").slice(0, 500),
    });
  }
  if (finalizeBinding && criteriaPassed()) scheduleSuccessfulFinish();
});

console.log(JSON.stringify({
  ready: true,
  role,
  outputPath,
  launchIdentitySha256: launch.identitySha256,
  targetId: launch.rendererTarget.id,
}, null, 2));

const timeout = setTimeout(() => void finish(false), timeoutMs);
const finalizePoll = setInterval(() => {
  void pollFinalize().catch((error) => {
    console.error(error);
    void finish(false);
  });
}, 100);
process.on("SIGINT", () => void finish(false));
process.on("SIGTERM", () => void finish(false));
await new Promise<void>((resolveFinished) => {
  const interval = setInterval(() => {
    if (!settled) return;
    clearInterval(interval);
    resolveFinished();
  }, 50);
});
clearTimeout(timeout);
clearInterval(finalizePoll);

function record(event: UnsequencedNetworkEvent): void {
  if (events.length >= 10_000) {
    void finish(false);
    return;
  }
  events.push({ ...event, sequence: events.length + 1 } as E2ENetworkEvent);
  if (finalizeBinding && criteriaPassed()) scheduleSuccessfulFinish();
}

function scheduleSuccessfulFinish(): void {
  if (settled) return;
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => void finish(true), drainMs);
}

function relevantUrl(url: NonNullable<ReturnType<typeof sanitizeNetworkUrl>>): boolean {
  const controlHostname = new URL(run.manifest.endpoints.controlOrigin).hostname;
  const dataHostname = new URL(`wss://${run.manifest.endpoints.dataHost}`).hostname;
  return (
    isControlPlanePath(url.pathname) ||
    url.scheme === "ws:" ||
    url.scheme === "wss:" ||
    url.hostname === controlHostname ||
    url.hostname === dataHostname ||
    [
      "127.0.0.1:3000",
      "127.0.0.1:3003",
      "localhost:3000",
      "localhost:3003",
      "[::1]:3000",
      "[::1]:3003",
    ].includes(url.authority)
  );
}

function criteriaPassed(): boolean {
  if (!finalizeBinding) return false;
  const requirements = buildNetworkRequirements(
    role,
    run.manifest,
    events,
    finalizeBinding.record.handshakeNotBefore,
  );
  const expectedHandshake = expectsSuccessfulDataHandshake(role, run.manifest);
  return (
    requirements.successfulControlRoutes.length === requirements.controlRoutes.length &&
    requirements.successfulDataHandshake === expectedHandshake &&
    requirements.successfulLifecycleDataHandshake === expectedHandshake
  );
}

async function pollFinalize(): Promise<void> {
  if (settled || finalizeBinding || finalizePollInFlight) return;
  finalizePollInFlight = true;
  try {
    if (!(await Bun.file(finalizePath).exists())) return;
    const bytes = await readFile(finalizePath);
    const record = JSON.parse(bytes.toString("utf8")) as unknown;
    assertNetworkCaptureFinalize(record, {
      role,
      runManifestSha256: run.manifestSha256,
    });
    finalizeBinding = { bytes, sha256: sha256(bytes), record };
    if (criteriaPassed()) scheduleSuccessfulFinish();
  } finally {
    finalizePollInFlight = false;
  }
}

async function finish(passed: boolean): Promise<void> {
  if (settled) return;
  settled = true;
  if (drainTimer) clearTimeout(drainTimer);
  if (!finalizeBinding) {
    socket.close();
    console.error("Network capture ended before an explicit lifecycle finalizer was recorded");
    process.exitCode = 1;
    return;
  }
  const requirements = buildNetworkRequirements(
    role,
    run.manifest,
    events,
    finalizeBinding.record.handshakeNotBefore,
  );
  const expectedHandshake = expectsSuccessfulDataHandshake(role, run.manifest);
  const evidence: E2ENetworkEvidence = {
    schemaVersion: 2,
    role,
    startedAt,
    completedAt: new Date().toISOString(),
    passed: passed &&
      requirements.successfulControlRoutes.length === requirements.controlRoutes.length &&
      requirements.successfulDataHandshake === expectedHandshake &&
      requirements.successfulLifecycleDataHandshake === expectedHandshake,
    finalize: {
      path: finalizePath,
      sha256: finalizeBinding.sha256,
      phase: finalizeBinding.record.phase,
      requestedAt: finalizeBinding.record.requestedAt,
      handshakeNotBefore: finalizeBinding.record.handshakeNotBefore,
    },
    launch: {
      identityPath: launch.identityPath,
      identitySha256: launch.identitySha256,
      runManifestSha256: run.manifestSha256,
      releaseManifestSha256: launch.identity.releaseManifestSha256,
      launchedPid: launch.identity.pid,
      debugPort: launch.identity.debugPort,
      debugListenerPid: launch.identity.debugListenerPid,
      debugTargetId: launch.identity.debugTargetId,
      debugTargetUrl: launch.identity.debugTargetUrl,
      profilePath: launch.identity.profilePath,
      vaultPath: launch.identity.vaultPath,
    },
    requirements,
    events,
  };
  socket.close();
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  if (((await stat(outputPath)).mode & 0o777) !== 0o600) {
    throw new Error("E2E network evidence permissions are not owner-only");
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseTimeout(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("--timeout-ms must be numeric");
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 3_600_000) {
    throw new Error("--timeout-ms must be between 1000 and 3600000");
  }
  return timeout;
}

function parseDrain(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("--drain-ms must be numeric");
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > 60_000) {
    throw new Error("--drain-ms must be between 1000 and 60000");
  }
  return duration;
}
