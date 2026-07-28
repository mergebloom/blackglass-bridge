import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import { BRIDGE_CLI_SOCKET_NAME } from "./cli-binary";
import {
  inspectMacOSArtifact,
  publicMacOSArtifact,
  type MacOSArtifact,
} from "./macos-artifact";
import { readPreparedE2ERun } from "./e2e-network";
import { readVerifiedE2ETls } from "./e2e-tls";
import {
  assertNoSymlinkSegments,
  assertPathWithin,
  canonicalExistingPath,
  pathExists,
  pathsEqual,
} from "./path-safety";
import { stableJson } from "./stable-json";

export interface ClientLaunchIdentity {
  schemaVersion: 4;
  runManifestSha256: string;
  releaseManifestSha256: string;
  startedAt: string;
  pid: number;
  launchCommand: string;
  debugPort: number;
  debugListenerPid: number;
  debugListenerCommand: string;
  debugTargetId: string;
  debugTargetUrl: string;
  executablePath: string;
  executableSha256: string;
  appBundlePath: string;
  appArtifactSha256: string;
  appArtifact: Omit<MacOSArtifact, "appPath">;
  adapterPath: string;
  adapterSha256: string;
  profilePath: string;
  blackglassHomePath: string;
  blackglassHomeEnvironment: typeof BLACKGLASS_HOME_ENVIRONMENT;
  blackglassHomeMode: 448;
  blackglassHomeCanonical: true;
  cliSocketPath: string;
  nativeHomePath: string;
  nativeHomeEnvironmentPreserved: true;
  vaultPath: string;
  tlsMetadataPath: string;
  tlsMetadataSha256: string;
  tlsSpkiSha256Base64: string;
}

export interface LiveClientLaunchBinding {
  identityPath: string;
  identitySha256: string;
  identity: ClientLaunchIdentity;
  run: Awaited<ReturnType<typeof readPreparedE2ERun>>;
  listenerPid: number;
  launchCommand: string;
  listenerCommand: string;
  rendererTarget: {
    id: string;
    url: string;
    webSocketDebuggerUrl?: string;
  };
}

export async function resolvePreparedClientLayout(
  profile: string,
  vault: string,
): Promise<{
  run: Awaited<ReturnType<typeof readPreparedE2ERun>>;
  clientRoot: string;
  clientName: "client-a" | "client-b";
}> {
  if (basename(profile) !== "user-data" || basename(vault) !== "vault") {
    throw new Error("Prepared E2E client paths must end in user-data and vault");
  }
  const clientRoot = dirname(profile);
  if (!pathsEqual(dirname(vault), clientRoot)) {
    throw new Error("Prepared E2E profile and vault must belong to the same client");
  }
  const clientName = basename(clientRoot);
  if (clientName !== "client-a" && clientName !== "client-b") {
    throw new Error("Prepared E2E client must be client-a or client-b");
  }
  const run = await readPreparedE2ERun(dirname(clientRoot));
  const expectedProfile = join(run.root, clientName, "user-data");
  const expectedVault = join(run.root, clientName, "vault");
  if (!pathsEqual(profile, expectedProfile) || !pathsEqual(vault, expectedVault)) {
    throw new Error("Prepared E2E client paths do not match their run manifest");
  }
  await assertNoSymlinkSegments(run.root, profile, "Prepared E2E profile");
  await assertNoSymlinkSegments(run.root, vault, "Prepared E2E vault");
  return { run, clientRoot, clientName };
}

export async function readClientLaunchIdentity(
  path: string,
): Promise<ClientLaunchIdentity> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertClientLaunchIdentity(value);
  return value;
}

export function assertClientLaunchIdentity(
  value: unknown,
): asserts value is ClientLaunchIdentity {
  if (!isRecord(value) || value.schemaVersion !== 4) {
    throw new Error("Unsupported client launch identity schema");
  }
  for (const field of [
    "runManifestSha256",
    "releaseManifestSha256",
    "executableSha256",
    "appArtifactSha256",
    "adapterSha256",
    "tlsMetadataSha256",
  ] as const) {
    if (!isSha256(value[field])) throw new Error(`Client launch identity ${field} is invalid`);
  }
  for (const field of [
    "startedAt",
    "executablePath",
    "appBundlePath",
    "adapterPath",
    "profilePath",
    "blackglassHomePath",
    "cliSocketPath",
    "nativeHomePath",
    "vaultPath",
    "tlsMetadataPath",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Client launch identity ${field} is invalid`);
    }
  }
  const startedAt = Date.parse(value.startedAt as string);
  if (
    !Number.isFinite(startedAt) ||
    new Date(startedAt).toISOString() !== value.startedAt ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    !Number.isSafeInteger(value.debugPort) ||
    (value.debugPort as number) < 1024 ||
    (value.debugPort as number) > 65_535 ||
    !Number.isSafeInteger(value.debugListenerPid) ||
    (value.debugListenerPid as number) < 1 ||
    typeof value.debugListenerCommand !== "string" ||
    value.debugListenerCommand.length === 0 ||
    typeof value.launchCommand !== "string" ||
    value.launchCommand.length === 0 ||
    typeof value.debugTargetId !== "string" ||
    value.debugTargetId.length === 0 ||
    typeof value.debugTargetUrl !== "string" ||
    !value.debugTargetUrl.includes("index.html") ||
    typeof value.tlsSpkiSha256Base64 !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(value.tlsSpkiSha256Base64) ||
    value.blackglassHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    value.blackglassHomeMode !== 0o700 ||
    value.blackglassHomeCanonical !== true ||
    value.cliSocketPath !==
      join(value.blackglassHomePath as string, BRIDGE_CLI_SOCKET_NAME) ||
    value.nativeHomeEnvironmentPreserved !== true ||
    !/^\/private\/tmp\/blackglass-client-[A-Za-z0-9]{6}\/h$/u.test(
      value.blackglassHomePath as string,
    ) ||
    Buffer.byteLength(
      join(value.blackglassHomePath as string, ".blackglass-b.sock"),
      "utf8",
    ) > 103 ||
    value.nativeHomePath === value.blackglassHomePath ||
    !isRecord(value.appArtifact)
  ) {
    throw new Error("Client launch identity process or artifact binding is invalid");
  }
}

export async function verifyLiveClientLaunchBinding(
  identityPathArgument: string,
): Promise<LiveClientLaunchBinding> {
  const identityPath = await canonicalExistingPath(
    identityPathArgument,
    "Client launch identity",
    "file",
  );
  const identityBytes = await readFile(identityPath);
  const identity = JSON.parse(identityBytes.toString("utf8")) as unknown;
  assertClientLaunchIdentity(identity);
  const layout = await resolvePreparedClientLayout(identity.profilePath, identity.vaultPath);
  const { run } = layout;
  assertPathWithin(identityPath, run.root, "Client launch identity");
  await assertNoSymlinkSegments(run.root, identityPath, "Client launch identity");
  if (
    identity.runManifestSha256 !== run.manifestSha256 ||
    identity.releaseManifestSha256 !== run.manifest.releaseManifestSha256 ||
    identity.adapterSha256 !== run.manifest.compatibilityAsarSha256 ||
    identity.blackglassHomeEnvironment !== BLACKGLASS_HOME_ENVIRONMENT ||
    identity.nativeHomeEnvironmentPreserved !== true ||
    identity.tlsMetadataPath !== join(run.root, "tls-metadata.json") ||
    ((await stat(identityPath)).mode & 0o777) !== 0o600
  ) {
    throw new Error("Client launch identity is not bound to its prepared run");
  }
  const runtimeRoot = dirname(identity.blackglassHomePath);
  const [runtimeRootStat, runtimeHomeStat, cliSocketStat] = await Promise.all([
    lstat(runtimeRoot),
    lstat(identity.blackglassHomePath),
    lstat(identity.cliSocketPath),
  ]);
  if (
    !runtimeRootStat.isDirectory() ||
    runtimeRootStat.isSymbolicLink() ||
    (runtimeRootStat.mode & 0o777) !== 0o700 ||
    runtimeRootStat.uid !== process.getuid!() ||
    !runtimeHomeStat.isDirectory() ||
    runtimeHomeStat.isSymbolicLink() ||
    (runtimeHomeStat.mode & 0o777) !== identity.blackglassHomeMode ||
    runtimeHomeStat.uid !== process.getuid!() ||
    await realpath(identity.blackglassHomePath) !== identity.blackglassHomePath ||
    !cliSocketStat.isSocket() ||
    await pathExists(join(identity.blackglassHomePath, ".obsidian-cli.sock"))
  ) {
    throw new Error("Live client BLACKGLASS_HOME or CLI socket is unsafe");
  }
  const tls = await readVerifiedE2ETls(run.root, identity.tlsMetadataPath);
  if (
    identity.tlsMetadataSha256 !== tls.metadataSha256 ||
    identity.tlsSpkiSha256Base64 !== tls.metadata.spkiSha256Base64
  ) {
    throw new Error("Client launch identity has mismatched TLS metadata");
  }
  const [adapterSha256, executableSha256, currentArtifact] = await Promise.all([
    fileSha256(identity.adapterPath),
    fileSha256(identity.executablePath),
    inspectMacOSArtifact(identity.appBundlePath),
  ]);
  const publicArtifact = publicMacOSArtifact(currentArtifact);
  if (
    adapterSha256 !== identity.adapterSha256 ||
    executableSha256 !== identity.executableSha256 ||
    stableJson(publicArtifact) !== stableJson(identity.appArtifact) ||
    sha256(Buffer.from(stableJson(publicArtifact))) !== identity.appArtifactSha256
  ) {
    throw new Error("Live client files changed after launch identity was recorded");
  }
  assertProcessAlive(identity.pid, "launched client");
  const listenerPid = listenerOwner(identity.debugPort);
  const launchCommand = processInfo(identity.pid).command;
  const listenerCommand = processInfo(listenerPid).command;
  if (
    listenerPid !== identity.debugListenerPid ||
    !isProcessOrDescendant(listenerPid, identity.pid) ||
    launchCommand !== identity.launchCommand ||
    listenerCommand !== identity.debugListenerCommand
  ) {
    throw new Error("DevTools listener is not owned by the recorded client process");
  }
  for (const expectedArgument of [
    identity.executablePath,
    `--user-data-dir=${identity.profilePath}`,
    `--remote-debugging-port=${identity.debugPort}`,
    `--host-resolver-rules=${run.manifest.network.tlsProxy.chromiumHostResolverRules}`,
    `--ignore-certificate-errors-spki-list=${identity.tlsSpkiSha256Base64}`,
  ]) {
    if (!launchCommand.includes(expectedArgument)) {
      throw new Error(`Live client command is missing ${expectedArgument}`);
    }
  }
  const targets = await fetch(`http://127.0.0.1:${identity.debugPort}/json/list`, {
    signal: AbortSignal.timeout(2_000),
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
      target.url.includes("index.html"),
  );
  if (
    renderers.length !== 1 ||
    renderers[0]!.id !== identity.debugTargetId ||
    renderers[0]!.url !== identity.debugTargetUrl
  ) {
    throw new Error("Live renderer target does not match the client launch identity");
  }
  const target = renderers[0]!;
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("Live renderer target has no DevTools WebSocket endpoint");
  }
  const runtimeHome = await readRendererRuntimeHome(target.webSocketDebuggerUrl);
  if (
    runtimeHome.nativeHomePath !== identity.nativeHomePath ||
    runtimeHome.blackglassHomePath !== identity.blackglassHomePath ||
    runtimeHome.nativeHomePath === runtimeHome.blackglassHomePath
  ) {
    throw new Error("Live renderer runtime home split does not match its identity");
  }
  return {
    identityPath,
    identitySha256: sha256(identityBytes),
    identity,
    run,
    listenerPid,
    launchCommand,
    listenerCommand,
    rendererTarget: {
      id: target.id as string,
      url: target.url as string,
      ...(typeof target.webSocketDebuggerUrl === "string"
        ? { webSocketDebuggerUrl: target.webSocketDebuggerUrl }
        : {}),
    },
  };
}

async function readRendererRuntimeHome(webSocketDebuggerUrl: string): Promise<{
  nativeHomePath: string;
  blackglassHomePath: string;
}> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  return await new Promise((resolveRuntime, rejectRuntime) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(undefined, new Error("Timed out reading live renderer environment"));
    }, 5_000);
    const finish = (
      value?: { nativeHomePath: string; blackglassHomePath: string },
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
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
        finish(undefined, new Error("Live renderer environment is unavailable"));
        return;
      }
      finish({
        nativeHomePath: value.nativeHomePath,
        blackglassHomePath: value.blackglassHomePath,
      });
    });
    socket.addEventListener("error", () => {
      finish(undefined, new Error("Failed to inspect live renderer environment"));
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
  if (result.exitCode !== 0) throw new Error(`Cannot inspect DevTools listener on ${port}`);
  const pids = Buffer.from(result.stdout)
    .toString("utf8")
    .split("\n")
    .filter((line) => /^p\d+$/u.test(line))
    .map((line) => Number(line.slice(1)));
  const unique = [...new Set(pids)];
  if (unique.length !== 1) {
    throw new Error(`Expected one DevTools listener owner on ${port}, found ${unique.length}`);
  }
  return unique[0]!;
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

function assertProcessAlive(pid: number, label: string): void {
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`The ${label} process ${pid} is not running`);
  }
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
