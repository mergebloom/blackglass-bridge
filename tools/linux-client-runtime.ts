import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AsarArchive } from "./asar";
import { canonicalExistingPath } from "./path-safety";
import { stableJson } from "./stable-json";
import { computeTreeIdentity } from "./tree-identity";
import { assertLinuxClientConfig, type LinuxClientConfig } from "./linux-client-config";
import { BLACKGLASS_HOME_ENVIRONMENT } from "../packages/client-adapter/src/runtime-home";
import { BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT } from "../packages/client-adapter/src/patch";

export async function launchLinuxClient(bundleArgument: string, runtimeArguments: string[]): Promise<number> {
  const layout = await verifiedLayout(bundleArgument);
  const state = await prepareState(layout);
  if (await socketAcceptsConnections(state.socket)) return 0;
  await removeStaleSocket(state.socket);
  const allowed = validateRuntimeArguments(runtimeArguments);
  const child = Bun.spawn([
    layout.executable,
    `--user-data-dir=${state.profile}`,
    ...allowed,
  ], {
    cwd: homedir(),
    env: {
      ...process.env,
      [BLACKGLASS_HOME_ENVIRONMENT]: state.runtimeHome,
      [BLACKGLASS_CLI_EXECUTABLE_ENVIRONMENT]: layout.cliShim,
      BLACKGLASS_ICON: layout.icon,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forward = (signal: NodeJS.Signals): void => {
    try { child.kill(signal); } catch { /* already exited */ }
  };
  const sigint = (): void => forward("SIGINT");
  const sigterm = (): void => forward("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  try {
    await waitForSocket(state.socket, child, 30_000);
    return await child.exited;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}

export async function runLinuxCli(bundleArgument: string, cliArguments: string[]): Promise<number> {
  const layout = await verifiedLayout(bundleArgument);
  const state = await prepareState(layout);
  if (!(await socketAcceptsConnections(state.socket))) {
    await removeStaleSocket(state.socket);
    const launcher = Bun.spawn([
      layout.bridge,
      "__linux-launch",
      layout.root,
    ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    launcher.unref();
    await waitForSocket(state.socket, launcher, 30_000);
  }
  const child = Bun.spawn([layout.cli, ...cliArguments], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_RUNTIME_DIR: state.runtimeHome },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

interface VerifiedLayout {
  root: string;
  config: LinuxClientConfig;
  runtime: string;
  executable: string;
  renderer: string;
  cli: string;
  cliShim: string;
  bridge: string;
  icon: string;
}

async function verifiedLayout(bundleArgument: string): Promise<VerifiedLayout> {
  if (process.platform !== "linux") throw new Error("The Linux client runtime requires Linux");
  const root = await canonicalExistingPath(bundleArgument, "Blackglass Linux client", "directory");
  const configPath = await canonicalExistingPath(join(root, "blackglass-client.json"), "Linux client configuration", "file");
  const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  assertLinuxClientConfig(config);
  const currentArchitecture = process.arch === "x64" ? "amd64" : process.arch;
  if (config.architecture !== currentArchitecture) {
    throw new Error(`Linux client architecture ${config.architecture} cannot run on ${process.arch}`);
  }
  const runtime = await realFile(root, config.paths.runtime, "Official Linux runtime", "directory");
  const executable = await realFile(runtime, "obsidian", "Official Linux executable", "file");
  const renderer = await realFile(root, config.paths.renderer, "Blackglass renderer", "file");
  const cli = await realFile(root, config.paths.cliExecutable, "Blackglass native CLI", "file");
  const cliShim = await realFile(root, config.paths.cliShim, "Blackglass CLI shim", "file");
  const bridge = await realFile(root, config.paths.bridgeExecutable, "Blackglass launcher", "file");
  const icon = await realFile(root, config.paths.icon, "Blackglass icon", "file");
  const runtimeTree = await computeTreeIdentity(runtime);
  if (stableJson(runtimeTree) !== stableJson(config.upstream.runtimeTree)) {
    throw new Error("Official Linux runtime changed after adaptation");
  }
  for (const [path, expected, label] of [
    [executable, config.upstream.executableSha256, "official executable"],
    [join(runtime, "resources/obsidian.asar"), config.upstream.rendererAsarSha256, "official renderer"],
    [join(runtime, "resources/app.asar"), config.upstream.wrapperAsarSha256, "official wrapper"],
    [join(runtime, "obsidian-cli"), config.upstream.cliExecutableSha256, "official CLI"],
    [renderer, config.generated.rendererSha256, "Blackglass renderer"],
    [cli, config.generated.cliExecutableSha256, "Blackglass CLI"],
    [bridge, config.generated.bridgeExecutableSha256, "Blackglass launcher"],
  ] as const) {
    if (await sha256File(path) !== expected) throw new Error(`${label} identity changed`);
  }
  return { root, config, runtime, executable, renderer, cli, cliShim, bridge, icon };
}

async function prepareState(layout: VerifiedLayout): Promise<{
  profile: string;
  runtimeHome: string;
  socket: string;
}> {
  const configBase = absoluteEnvironmentDirectory("XDG_CONFIG_HOME", join(homedir(), ".config"));
  const profile = resolve(configBase, layout.config.launchPolicy.profileDirectory);
  await ensureOwnerDirectory(profile, "Blackglass profile");
  const rendererAlias = join(profile, "obsidian-1.13.5.asar");
  if (!(await pathExists(rendererAlias)) || await sha256File(rendererAlias) !== layout.config.generated.rendererSha256) {
    const temporary = `${rendererAlias}.next-${process.pid}`;
    await copyFile(layout.renderer, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, rendererAlias);
  }
  const archive = await AsarArchive.open(rendererAlias);
  const metadata = JSON.parse(archive.read("package.json").toString("utf8")) as { version?: unknown };
  if (metadata.version !== layout.config.rendererVersion) throw new Error("Installed renderer version changed");
  const settingsPath = join(profile, "obsidian.json");
  let settings: Record<string, unknown> = {};
  if (await pathExists(settingsPath)) {
    const existing = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("Blackglass profile configuration is malformed");
    }
    settings = existing as Record<string, unknown>;
  }
  settings.updateDisabled = true;
  settings.cli = true;
  const nextSettings = `${settingsPath}.next-${process.pid}`;
  await writeFile(nextSettings, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(nextSettings, settingsPath);
  const runtimeBase = absoluteEnvironmentDirectory(
    "XDG_RUNTIME_DIR",
    join(tmpdir(), `blackglass-${process.getuid!()}`),
  );
  const runtimeHome = resolve(runtimeBase, "blackglass");
  await ensureOwnerDirectory(runtimeHome, "Blackglass runtime directory");
  return { profile, runtimeHome, socket: join(runtimeHome, ".blackglass-c.sock") };
}

function absoluteEnvironmentDirectory(name: string, fallback: string): string {
  const value = process.env[name];
  if (value && !value.startsWith("/")) throw new Error(`${name} must be absolute`);
  return resolve(value || fallback);
}

async function ensureOwnerDirectory(path: string, label: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid!() || (metadata.mode & 0o777) !== 0o700 ||
    await realpath(path) !== path
  ) throw new Error(`${label} must be canonical, owner-controlled, and mode 0700`);
}

function validateRuntimeArguments(arguments_: string[]): string[] {
  const testSandbox = process.env.BLACKGLASS_TEST_ALLOW_NO_SANDBOX === "1";
  for (const argument of arguments_) {
    if (argument === "--no-sandbox" && testSandbox) continue;
    if (!argument.startsWith("-") || argument.startsWith("obsidian://")) continue;
    throw new Error(`Unsupported Linux runtime argument: ${argument}`);
  }
  return [...arguments_];
}

async function waitForSocket(
  socket: string,
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketAcceptsConnections(socket)) return;
    const exit = await Promise.race([
      child.exited.then((code) => ({ exited: true as const, code })),
      Bun.sleep(100).then(() => ({ exited: false as const, code: undefined })),
    ]);
    if (exit.exited) throw new Error(`Blackglass Linux client exited before its CLI socket was ready (${exit.code})`);
  }
  throw new Error("Timed out waiting for the Blackglass Linux CLI socket");
}

async function removeStaleSocket(path: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const metadata = await lstat(path);
  if (!metadata.isSocket()) throw new Error(`Refusing non-socket CLI lease: ${path}`);
  if (await socketAcceptsConnections(path)) return;
  await unlink(path);
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  if (!(await pathExists(path))) return false;
  return await new Promise<boolean>((resolveConnection) => {
    const socket = createConnection({ path });
    const timer = setTimeout(() => { socket.destroy(); resolveConnection(false); }, 500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveConnection(true); });
    socket.once("error", () => { clearTimeout(timer); socket.destroy(); resolveConnection(false); });
  });
}

async function realFile(
  root: string,
  relative: string,
  label: string,
  kind: "file" | "directory",
): Promise<string> {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error(`${label} escapes the client root`);
  return canonicalExistingPath(path, label, kind);
}
async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
