import { createHash } from "node:crypto";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AsarArchive } from "./asar";
import { parseStrictFlags } from "./cli-flags";
import {
  type ClientLaunchIdentity,
  resolvePreparedClientLayout,
} from "./e2e-client";
import { readVerifiedE2ETls } from "./e2e-tls";
import {
  inspectMacOSArtifact,
  publicMacOSArtifact,
  type MacOSArtifact,
} from "./macos-artifact";
import {
  assertNoSymlinkSegments,
  assertNonOverlappingPaths,
  assertPathWithin,
  canonicalExistingPath,
  canonicalOutputPath,
  pathsEqual,
} from "./path-safety";
import { readBridgeReleaseManifest } from "./release-manifest";

const [asarArgument, profileArgument, vaultArgument, ...flagArguments] = Bun.argv.slice(2);
if (!asarArgument || !profileArgument || !vaultArgument) usage();
if (process.platform !== "darwin") {
  throw new Error("The first client launcher supports macOS only");
}
const flags = parseStrictFlags(flagArguments, {
  valueFlags: [
    "--app",
    "--debug-port",
    "--e2e-tls-metadata",
    "--identity-out",
  ],
  booleanFlags: ["--replace-adapter", "--prepare-only", "--allow-upstream-wrapper"],
});
const debugPortValue = flags.values.get("--debug-port");
const tlsMetadataArgument = flags.values.get("--e2e-tls-metadata");
const identityArgument = flags.values.get("--identity-out");
const prepareOnly = flags.booleans.has("--prepare-only");
const e2eRequested = Boolean(debugPortValue || tlsMetadataArgument || identityArgument);
if (
  e2eRequested &&
  (!debugPortValue || !tlsMetadataArgument || !identityArgument || prepareOnly)
) {
  throw new Error(
    "E2E launches require --debug-port, --e2e-tls-metadata, and --identity-out together",
  );
}

const asar = await canonicalExistingPath(asarArgument, "Compatibility ASAR", "file");
const profile = await canonicalExistingPath(profileArgument, "Client profile", "directory");
const vault = await canonicalExistingPath(vaultArgument, "Client vault", "directory");
const appBundle = await canonicalExistingPath(
  flags.values.get("--app") ?? "/Applications/Blackglass Bridge.app",
  "macOS app bundle",
  "directory",
);
if (!appBundle.endsWith(".app")) throw new Error("macOS app bundle must end in .app");
assertNonOverlappingPaths([
  { label: "Client profile", path: profile },
  { label: "Client vault", path: vault },
  { label: "macOS app bundle", path: appBundle },
  { label: "Compatibility ASAR", path: asar },
]);
assertNonOverlappingPaths([
  { label: "Client profile", path: profile },
  {
    label: "Obsidian normal profile",
    path: resolve(homedir(), "Library/Application Support/obsidian"),
  },
]);

const archive = await AsarArchive.open(asar);
const packageMetadata = JSON.parse(archive.read("package.json").toString("utf8")) as {
  version?: string;
};
if (!packageMetadata.version || !/^\d+\.\d+\.\d+$/u.test(packageMetadata.version)) {
  throw new Error("Compatibility ASAR has no semantic package version");
}
archive.read("app.js");
const adapterSha256 = await fileSha256(asar);
const infoPlist = join(appBundle, "Contents/Info.plist");
const bundleIdentifier = plistString(infoPlist, "CFBundleIdentifier");
if (
  bundleIdentifier !== "com.blackglass.bridge" &&
  !flags.booleans.has("--allow-upstream-wrapper")
) {
  throw new Error(
    `Refusing non-Blackglass app ${bundleIdentifier}; pass --allow-upstream-wrapper only for isolated compatibility testing`,
  );
}
if (e2eRequested && bundleIdentifier !== "com.blackglass.bridge") {
  throw new Error("Prepared E2E launches require the Blackglass Bridge bundle identity");
}
const executableName = plistString(infoPlist, "CFBundleExecutable");
const executable = await canonicalExistingPath(
  join(appBundle, "Contents/MacOS", executableName),
  "macOS app executable",
  "file",
);
const executableSha256 = await fileSha256(executable);
const appArtifact =
  bundleIdentifier === "com.blackglass.bridge"
    ? await inspectMacOSArtifact(appBundle)
    : undefined;
if (appArtifact && appArtifact.embeddedAsarSha256 !== adapterSha256) {
  throw new Error(
    "Blackglass Bridge always loads its embedded renderer; the supplied ASAR must match it",
  );
}

let targetAsar = join(profile, `obsidian-${packageMetadata.version}.asar`);
let launchBinding:
  | {
      identityPath: string;
      runManifestSha256: string;
      releaseManifestSha256: string;
      tlsMetadataPath: string;
      tlsMetadataSha256: string;
      tlsSpkiSha256Base64: string;
    }
  | undefined;
if (e2eRequested) {
  if (!appArtifact) throw new Error("Prepared E2E app identity is unavailable");
  const layout = await resolvePreparedClientLayout(profile, vault);
  const run = layout.run;
  if (run.manifest.compatibilityAsarSha256 !== adapterSha256) {
    throw new Error("Compatibility ASAR is not bound to the selected prepared run");
  }
  targetAsar = await canonicalExistingPath(
    join(profile, run.manifest.adapterFileName),
    "Prepared client adapter",
    "file",
  );
  if ((await fileSha256(targetAsar)) !== adapterSha256) {
    throw new Error("Prepared client adapter no longer matches the run manifest");
  }
  if (flags.booleans.has("--replace-adapter")) {
    throw new Error("Prepared E2E adapters are immutable and cannot be replaced at launch");
  }
  const artifactPath = await canonicalExistingPath(
    join(run.root, "client-artifact.json"),
    "Prepared client artifact identity",
    "file",
  );
  await assertNoSymlinkSegments(run.root, artifactPath, "Prepared client artifact identity");
  const recordedArtifact = JSON.parse(await readFile(artifactPath, "utf8")) as MacOSArtifact;
  if (
    recordedArtifact.appPath !== appBundle ||
    stableJson(publicMacOSArtifact(recordedArtifact)) !==
      stableJson(publicMacOSArtifact(appArtifact))
  ) {
    throw new Error("Launched app does not match the selected prepared run");
  }
  const releaseManifestPath = await canonicalExistingPath(
    join(run.root, run.manifest.releaseManifestFileName),
    "Prepared release manifest",
    "file",
  );
  await assertNoSymlinkSegments(run.root, releaseManifestPath, "Prepared release manifest");
  if ((await fileSha256(releaseManifestPath)) !== run.manifest.releaseManifestSha256) {
    throw new Error("Prepared release manifest no longer matches the run manifest");
  }
  const { manifest: releaseManifest } = await readBridgeReleaseManifest(releaseManifestPath);
  if (
    stableJson(releaseManifest.macOS) !== stableJson(publicMacOSArtifact(appArtifact)) ||
    releaseManifest.renderer.patchedSha256 !== adapterSha256
  ) {
    throw new Error("Prepared release manifest does not bind the launched app and adapter");
  }
  const tls = await readVerifiedE2ETls(run.root, tlsMetadataArgument);
  const identityPath = await canonicalOutputPath(identityArgument as string, "Client identity");
  assertPathWithin(identityPath, run.root, "Client identity");
  await assertNoSymlinkSegments(run.root, dirname(identityPath), "Client identity parent");
  launchBinding = {
    identityPath,
    runManifestSha256: run.manifestSha256,
    releaseManifestSha256: run.manifest.releaseManifestSha256,
    tlsMetadataPath: tls.metadataPath,
    tlsMetadataSha256: tls.metadataSha256,
    tlsSpkiSha256Base64: tls.metadata.spkiSha256Base64,
  };
} else {
  if (await Bun.file(targetAsar).exists()) {
    const same = (await fileSha256(targetAsar)) === adapterSha256;
    if (!same && !flags.booleans.has("--replace-adapter")) {
      throw new Error(
        `A different adapter already exists at ${targetAsar}; pass --replace-adapter to replace it`,
      );
    }
    if (!same) {
      const temporary = `${targetAsar}.next`;
      await copyFile(asar, temporary);
      await rename(temporary, targetAsar);
    }
  } else {
    await copyFile(asar, targetAsar);
  }
}

const vaultId = createHash("sha256").update(vault).digest("hex").slice(0, 16);
const profileConfigPath = join(profile, "obsidian.json");
let profileConfig: Record<string, any> = {};
if (await Bun.file(profileConfigPath).exists()) {
  profileConfig = JSON.parse(await readFile(profileConfigPath, "utf8"));
}
profileConfig.updateDisabled = true;
profileConfig.vaults = {
  ...(profileConfig.vaults ?? {}),
  [vaultId]: { path: vault, ts: Date.now(), open: true },
};
await writeJsonAtomic(profileConfigPath, profileConfig);
const vaultState = join(profile, `${vaultId}.json`);
if (!(await Bun.file(vaultState).exists())) await writeJsonAtomic(vaultState, {});

const debugPort = debugPortValue ? parseDebugPort(debugPortValue) : undefined;
const launchArguments = [executable, `--user-data-dir=${profile}`];
if (debugPort) launchArguments.push(`--remote-debugging-port=${debugPort}`);
if (launchBinding) {
  const tls = await readVerifiedE2ETls(dirname(dirname(profile)), launchBinding.tlsMetadataPath);
  launchArguments.push(
    `--host-resolver-rules=${tls.metadata.chromiumHostResolverRules}`,
    `--ignore-certificate-errors-spki-list=${tls.metadata.spkiSha256Base64}`,
  );
}
const summary = {
  version: packageMetadata.version,
  profile,
  vault,
  adapter: targetAsar,
  adapterSha256,
  appBundle,
  bundleIdentifier,
  executable,
  executableSha256,
};
if (prepareOnly) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const startedAt = new Date().toISOString();
const child = Bun.spawn(launchArguments, {
  cwd: vault,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
if (launchBinding && debugPort) {
  if (!appArtifact) throw new Error("Prepared E2E app identity is unavailable");
  const publicArtifact = publicMacOSArtifact(appArtifact);
  let debugBinding: Awaited<ReturnType<typeof waitForDebugBinding>>;
  try {
    debugBinding = await waitForDebugBinding(debugPort, child.pid, child);
  } catch (error) {
    child.kill("SIGTERM");
    await child.exited;
    throw error;
  }
  const identity: ClientLaunchIdentity = {
    schemaVersion: 2,
    runManifestSha256: launchBinding.runManifestSha256,
    releaseManifestSha256: launchBinding.releaseManifestSha256,
    startedAt,
    pid: child.pid,
    launchCommand: processInfo(child.pid).command,
    debugPort,
    debugListenerPid: debugBinding.listenerPid,
    debugListenerCommand: debugBinding.listenerCommand,
    debugTargetId: debugBinding.targetId,
    debugTargetUrl: debugBinding.targetUrl,
    executablePath: executable,
    executableSha256,
    appBundlePath: appBundle,
    appArtifactSha256: sha256(Buffer.from(stableJson(publicArtifact))),
    appArtifact: publicArtifact,
    adapterPath: targetAsar,
    adapterSha256,
    profilePath: profile,
    vaultPath: vault,
    tlsMetadataPath: launchBinding.tlsMetadataPath,
    tlsMetadataSha256: launchBinding.tlsMetadataSha256,
    tlsSpkiSha256Base64: launchBinding.tlsSpkiSha256Base64,
  };
  try {
    await writeFile(
      launchBinding.identityPath,
      `${JSON.stringify(identity, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    child.kill("SIGTERM");
    await child.exited;
    throw error;
  }
  console.log(JSON.stringify({ ...summary, identityPath: launchBinding.identityPath, identity }, null, 2));
} else {
  console.log(JSON.stringify(summary, null, 2));
}
process.exitCode = await child.exited;

async function fileSha256(path: string): Promise<string> {
  const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
  return sha256(bytes);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function parseDebugPort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("--debug-port must be numeric");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("--debug-port must be between 1024 and 65535");
  }
  return port;
}

async function waitForDebugBinding(
  port: number,
  launchedPid: number,
  child: ReturnType<typeof Bun.spawn>,
): Promise<{
  listenerPid: number;
  listenerCommand: string;
  targetId: string;
  targetUrl: string;
}> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Blackglass Bridge exited before DevTools became ready: ${child.exitCode}`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`DevTools returned ${response.status}`);
        return await response.json() as Array<{
          id?: unknown;
          type?: unknown;
          url?: unknown;
        }>;
      });
      const renderers = targets.filter(
        (target) =>
          target.type === "page" &&
          typeof target.id === "string" &&
          typeof target.url === "string" &&
          target.url.includes("index.html"),
      ) as Array<{ id: string; type: "page"; url: string }>;
      if (renderers.length !== 1) {
        throw new Error(`Expected one renderer target; found ${renderers.length}`);
      }
      const listenerPid = listenerOwner(port);
      if (!isProcessOrDescendant(listenerPid, launchedPid)) {
        throw new Error(
          `DevTools listener PID ${listenerPid} is unrelated to launched PID ${launchedPid}`,
        );
      }
      const listenerCommand = processInfo(listenerPid).command;
      return {
        listenerPid,
        listenerCommand,
        targetId: renderers[0]!.id,
        targetUrl: renderers[0]!.url,
      };
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Timed out binding DevTools to the launched Blackglass process");
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
  if (result.exitCode !== 0) throw new Error("Unable to resolve DevTools listener owner");
  const pids = Buffer.from(result.stdout)
    .toString("utf8")
    .split("\n")
    .filter((line) => /^p\d+$/u.test(line))
    .map((line) => Number(line.slice(1)));
  if (new Set(pids).size !== 1) {
    throw new Error(`Expected one DevTools listener owner; found ${new Set(pids).size}`);
  }
  return pids[0]!;
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

function plistString(infoPlist: string, key: string): string {
  const result = Bun.spawnSync(["plutil", "-extract", key, "raw", "-o", "-", infoPlist]);
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

function usage(): never {
  console.error(
    "Usage: bun run tools/launch-macos.ts <patched.asar> <existing-profile> <existing-vault> " +
      "[--app <Blackglass Bridge.app>] [--replace-adapter] [--prepare-only] " +
      "[--allow-upstream-wrapper] [--debug-port <port> --e2e-tls-metadata <metadata.json> " +
      "--identity-out <identity.json>]",
  );
  process.exit(2);
}
