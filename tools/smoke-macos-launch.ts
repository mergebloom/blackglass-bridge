import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  inspectMacOSArtifact,
  publicMacOSArtifact,
  type MacOSArtifact,
} from "./macos-artifact";
import {
  FINDER_LAUNCH_MINIMUM_HEALTH_MS,
  FINDER_LAUNCH_DEBUG_PORT,
  FINDER_LAUNCH_SMOKE_SCHEMA_VERSION,
  assertFinderLaunchSmokeEvidence,
  finderLaunchCommand,
  finderLaunchSmokeLayout,
  macOSArtifactBindingSha256,
  type FinderLaunchSmokeEvidence,
} from "./macos-launch-smoke";
import { readPreparedE2ERun } from "./e2e-network";
import { readVerifiedE2ETls } from "./e2e-tls";
import {
  assertNoSymlinkSegments,
  canonicalExistingPath,
} from "./path-safety";

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
if (await Bun.file(layout.evidencePath).exists() || await Bun.file(layout.smokeRoot).exists()) {
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

await mkdir(layout.smokeRoot, { recursive: false, mode: 0o700 });
await Promise.all([
  mkdir(layout.homePath, { recursive: true, mode: 0o700 }),
  mkdir(layout.vaultPath, { recursive: true, mode: 0o700 }),
]);
await Promise.all([
  writeFile(layout.stdoutPath, "", { flag: "wx", mode: 0o600 }),
  writeFile(layout.stderrPath, "", { flag: "wx", mode: 0o600 }),
]);
if (await Bun.file(layout.profilePath).exists()) {
  throw new Error("Finder smoke profile must not exist before the no-vault launch");
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
  join(homedir(), "Library/Application Support/Blackglass Bridge"),
  join(homedir(), "Library/Application Support/obsidian"),
];
const realProfileFingerprintsBefore = await Promise.all(
  realProfiles.map(metadataTreeFingerprint),
);
const diagnosticBefore = await diagnosticReportSnapshot();
const launchCommand = finderLaunchCommand({
  appPath,
  ...layout,
  debugPort: FINDER_LAUNCH_DEBUG_PORT,
  chromiumHostResolverRules: tls.metadata.chromiumHostResolverRules,
  tlsSpkiSha256Base64: tls.metadata.spkiSha256Base64,
});
const baselineProcesses = listProcesses();
const baselineAppPids = new Set(
  baselineProcesses
    .filter((process) => process.command.includes(appPath))
    .map((process) => process.pid),
);

let mainPid: number | undefined;
let rendererPid: number | undefined;
let debugListenerPid: number | undefined;
let debugTargetId: string | undefined;
let debugTargetUrl: string | undefined;
let starterControlOrigin: string | undefined;
let starterControlRequests: FinderLaunchSmokeEvidence["starterControlRequests"] | undefined;
let cliSocketPath: string | undefined;
let cliForwardedResponse: FinderLaunchSmokeEvidence["cliForwardedResponse"] | undefined;
let healthyAt: string | undefined;
let healthyForMs: number | undefined;
const startedAt = new Date().toISOString();
const startedAtMs = Date.now();
try {
  const opened = Bun.spawnSync(launchCommand, { stdout: "pipe", stderr: "pipe" });
  if (opened.exitCode !== 0) {
    throw new Error(
      `LaunchServices refused the exact packaged app: ${opened.stderr.toString().trim()}`,
    );
  }
  mainPid = await waitForMainProcess(executablePath, baselineAppPids, 15_000);
  const target = await waitForStarterTarget(
    FINDER_LAUNCH_DEBUG_PORT,
    mainPid,
    appPath,
    15_000,
  );
  debugTargetId = target.id;
  debugTargetUrl = target.url;
  debugListenerPid = await waitForDebugListener(
    FINDER_LAUNCH_DEBUG_PORT,
    mainPid,
    appPath,
  );
  const starterProof = await exerciseStarterControlFlow({
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    controlOrigin: run.manifest.endpoints.controlOrigin,
    email: credentials.email,
    password: credentials.password,
  });
  starterControlOrigin = starterProof.controlOrigin;
  starterControlRequests = starterProof.requests;
  const healthDeadline = startedAtMs + FINDER_LAUNCH_MINIMUM_HEALTH_MS;
  while (Date.now() < healthDeadline) {
    assertProcessAlive(mainPid, "LaunchServices main process");
    const renderer = rendererDescendant(mainPid, appPath);
    if (renderer) rendererPid = renderer.pid;
    await Bun.sleep(200);
  }
  assertProcessAlive(mainPid, "LaunchServices main process");
  rendererPid = rendererDescendant(mainPid, appPath)?.pid ?? rendererPid;
  if (!rendererPid) {
    throw new Error("LaunchServices app stayed alive but never created a renderer UI process");
  }
  for (const marker of ["obsidian.log", "id"]) {
    const path = join(layout.profilePath, marker);
    if (!(await Bun.file(path).exists()) || !(await lstat(path)).isFile()) {
      throw new Error(`LaunchServices default profile did not create ${marker}`);
    }
  }
  const profileStat = await lstat(layout.profilePath);
  if (
    profileStat.isSymbolicLink() ||
    !profileStat.isDirectory() ||
    (profileStat.mode & 0o777) !== 0o700
  ) {
    throw new Error("LaunchServices default profile is not a real mode-0700 directory");
  }
  if (!processUsesPath(mainPid, layout.profilePath)) {
    throw new Error("LaunchServices process tree did not open the disposable default profile");
  }
  if (await registeredVaultCount(layout.profilePath) !== 0) {
    throw new Error("No-vault starter smoke unexpectedly registered a local vault");
  }
  if ((await readdir(layout.vaultPath)).length !== 0) {
    throw new Error("No-vault starter smoke unexpectedly wrote to its disposable vault");
  }
  const cliProof = await exercisePackagedCli({
    cliExecutablePath,
    homePath: layout.homePath,
    socketName: currentClient.cliSocketName,
    mainStdoutPath: layout.stdoutPath,
  });
  cliSocketPath = cliProof.socketPath;
  cliForwardedResponse = cliProof.response;
  healthyAt = new Date().toISOString();
  healthyForMs = Date.now() - startedAtMs;
} catch (error) {
  const crashReports = await newDiagnosticReports(diagnosticBefore, appPath);
  if (crashReports.length > 0) {
    throw new Error(
      `${String(error)}; matching macOS crash reports: ${crashReports.map((path) => basename(path)).join(", ")}`,
    );
  }
  throw error;
} finally {
  if (mainPid) {
    await terminateNewAppProcessTree(
      appPath,
      baselineAppPids,
      FINDER_LAUNCH_DEBUG_PORT,
    );
  }
}

if (
  mainPid === undefined ||
  rendererPid === undefined ||
  debugListenerPid === undefined ||
  debugTargetId === undefined ||
  debugTargetUrl === undefined ||
  starterControlOrigin === undefined ||
  starterControlRequests === undefined ||
  cliSocketPath === undefined ||
  cliForwardedResponse === undefined ||
  healthyAt === undefined ||
  healthyForMs === undefined
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
  cliExecutablePath,
  cliExecutableSha256: artifact.cliExecutableSha256,
  cliSocketPath,
  cliSocketName: artifact.cliSocketName,
  homePath: layout.homePath,
  profilePath: layout.profilePath,
  vaultPath: layout.vaultPath,
  launchCommand,
  debugPort: FINDER_LAUNCH_DEBUG_PORT,
  debugListenerPid,
  debugTargetId,
  debugTargetUrl,
  startedAt,
  healthyAt,
  completedAt: new Date().toISOString(),
  mainPid,
  rendererPid,
  healthyForMs,
  defaultProfilePathObserved: true,
  profileMode: 0o700,
  profileRealDirectoryObserved: true,
  profileActivityObserved: true,
  environmentHomeObserved: true,
  cliSocketObserved: true,
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
  earlyExit: false,
  diagnosticReportsChecked: true,
  crashReportsCreated: 0,
  realProfilesUnchanged: true,
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
  socketPath: string;
  response: "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.";
}> {
  const socketPath = join(input.homePath, input.socketName);
  const socketStat = await lstat(socketPath).catch(() => undefined);
  if (!socketStat?.isSocket()) {
    throw new Error(`Packaged main process did not create CLI socket ${socketPath}`);
  }
  const upstreamSocketPath = join(input.homePath, ".obsidian-cli.sock");
  if (await Bun.file(upstreamSocketPath).exists()) {
    throw new Error("Packaged main process created the upstream Obsidian CLI socket");
  }

  const forwardedCommand = "blackglass-smoke-probe";
  const child = Bun.spawn([input.cliExecutablePath, forwardedCommand], {
    env: { ...process.env, HOME: input.homePath },
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
      return { socketPath, response };
    }
    await Bun.sleep(50);
  }
  throw new Error("Packaged main process did not log the forwarded CLI command");
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
  while (Date.now() < deadline) {
    assertProcessAlive(mainPid, "LaunchServices main process");
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
      if (error instanceof Error && error.message.includes("more than one")) throw error;
      if (error instanceof Error && error.message.includes("not backed")) throw error;
    }
    await Bun.sleep(100);
  }
  throw new Error("Fresh default profile never opened the native starter.html renderer");
}

async function waitForDebugListener(
  port: number,
  mainPid: number,
  appPath: string,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = Bun.spawnSync([
      "/usr/sbin/lsof",
      "-nP",
      "-a",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    const listenerPids = result.stdout.toString().split("\n").flatMap((line) => {
      const match = /^p(\d+)$/u.exec(line);
      return match ? [Number(match[1])] : [];
    });
    const processes = listProcesses();
    const bound = [...new Set(listenerPids)].filter((pid) => {
      const process = processes.find((candidate) => candidate.pid === pid);
      return Boolean(
        process &&
        process.command.includes(appPath) &&
        isDescendant(pid, mainPid, processes),
      );
    });
    if (bound.length === 1) return bound[0]!;
    if (bound.length > 1) {
      throw new Error("More than one launched app process owns the smoke debugging port");
    }
    await Bun.sleep(100);
  }
  throw new Error("The exact launched app does not own its DevTools listener");
}

async function exerciseStarterControlFlow(input: {
  webSocketDebuggerUrl: string;
  controlOrigin: string;
  email: string;
  password: string;
}): Promise<{
  controlOrigin: string;
  requests: FinderLaunchSmokeEvidence["starterControlRequests"];
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
      try {
        const url = new URL(String(params.request?.url ?? ""));
        if (!["/user/signin", "/vault/list"].includes(url.pathname)) return;
        requests.set(String(params.requestId), {
          method: String(params.request?.method ?? ""),
          origin: url.origin,
          path: url.pathname,
        });
      } catch {
        // Ignore non-URL DevTools events.
      }
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
    const openedLogin = await evaluate(`(()=>{
      if (!location.href.includes("starter.html")) return false;
      const rows=[...document.querySelectorAll(".open-vault-options.mod-open-vault .setting-item")];
      const syncRow=rows[2];
      const button=syncRow?.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    if (openedLogin !== true) {
      throw new Error("Native starter Sync sign-in entry point is unavailable");
    }

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
      throw new Error("Native starter control requests were missing or duplicated");
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
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = listProcesses().filter(
      (process) =>
        !baselinePids.has(process.pid) &&
        (process.command === executablePath || process.command.startsWith(`${executablePath} `)),
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

async function terminateNewAppProcessTree(
  appPath: string,
  baselinePids: Set<number>,
  debugPort: number,
): Promise<void> {
  const scopedProcesses = (): ProcessRow[] =>
    listProcesses().filter(
      (process) =>
        !baselinePids.has(process.pid) &&
        process.command.startsWith(`${appPath}/Contents/`),
    );

  if (scopedProcesses().length === 0) return;
  try {
    await requestDevToolsBrowserClose(debugPort);
  } catch {
    // A startup failure may occur before DevTools is available. The exact
    // generated-app process set still receives the scoped signal fallback.
  }
  if (await waitForProcessExit(scopedProcesses, 5_000)) return;

  const termProcesses = scopedProcesses().sort((left, right) => right.pid - left.pid);
  for (const process of termProcesses) {
    try {
      globalThis.process.kill(process.pid, "SIGTERM");
    } catch {
      // The process may have exited between the process-table read and signal.
    }
  }
  if (await waitForProcessExit(scopedProcesses, 10_000)) return;

  const forcedProcesses = scopedProcesses().sort((left, right) => right.pid - left.pid);
  for (const process of forcedProcesses) {
    try {
      globalThis.process.kill(process.pid, "SIGKILL");
    } catch {
      // The process may have exited between the process-table read and cleanup.
    }
  }
  throw new Error(
    "Packaged app required forced termination after its launch smoke: " +
      forcedProcesses
        .map((process) => `${process.pid} ${process.command}`)
        .join("; "),
  );
}

async function requestDevToolsBrowserClose(port: number): Promise<void> {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`DevTools returned ${response.status}`);
    return await response.json() as { webSocketDebuggerUrl?: unknown };
  });
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("DevTools browser target has no WebSocket endpoint");
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolveClose, rejectClose) => {
    let commandSent = false;
    const timer = setTimeout(() => {
      socket.close();
      rejectClose(new Error("Timed out requesting DevTools browser shutdown"));
    }, 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (error) rejectClose(error);
      else resolveClose();
    };
    socket.addEventListener("open", () => {
      commandSent = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: unknown;
        error?: unknown;
      };
      if (message.id !== 1) return;
      if (message.error) finish(new Error("DevTools rejected browser shutdown"));
      else finish();
    });
    socket.addEventListener("close", () => {
      if (commandSent) finish();
      else finish(new Error("DevTools browser target closed before shutdown request"));
    }, { once: true });
    socket.addEventListener("error", () => {
      if (commandSent) finish();
      else finish(new Error("Unable to connect to the DevTools browser target"));
    }, { once: true });
  });
  if (socket.readyState === WebSocket.OPEN) socket.close();
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

async function diagnosticReportSnapshot(): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const directory of diagnosticReportDirectories()) {
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
): Promise<string[]> {
  const after = await diagnosticReportSnapshot();
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
      body.includes("com.blackglass.bridge") ||
      name.includes("blackglass bridge") ||
      name.includes("blackglass_bridge")
    ) {
      candidates.push(path);
    }
  }
  return candidates.sort();
}

function diagnosticReportDirectories(): string[] {
  return [
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
