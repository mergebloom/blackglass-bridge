import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  computeTreeIdentity,
  TREE_IDENTITY_FORMAT_VERSION,
  type TreeIdentity,
} from "./tree-identity";

export const PINNED_BUN_VERSION = "1.3.8";
export const MACOS_PACKAGING_TOOLCHAIN_FORMAT_VERSION = 3;
const FIXED_XCRUN_EXECUTABLE = "/usr/bin/xcrun";

export const MACOS_PACKAGING_EXECUTABLES = {
  PlistBuddy: "/usr/libexec/PlistBuddy",
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  get lipo(): string {
    return resolveMacOSDeveloperTool("lipo");
  },
  ls: "/bin/ls",
  plutil: "/usr/bin/plutil",
  stat: "/usr/bin/stat",
  sw_vers: "/usr/bin/sw_vers",
  xattr: "/usr/bin/xattr",
  get xcodebuild(): string {
    return resolveMacOSDeveloperTool("xcodebuild");
  },
  xcrun: FIXED_XCRUN_EXECUTABLE,
} as const;

type MacOSPackagingExecutableName = keyof typeof MACOS_PACKAGING_EXECUTABLES;
type MacOSPackagingToolName = "bun" | "git" | MacOSPackagingExecutableName;
type ReleaseRuntimeDependencyName = "playwright-core" | "typescript";

export const RELEASE_RUNTIME_DEPENDENCY_IMPORTS = [
  {
    name: "playwright-core",
    importer: "tools/e2e-ui.mjs",
    specifier: "#release-playwright-core",
    entry: "index.mjs",
  },
  {
    name: "typescript",
    importer: "tools/release-compatibility.ts",
    specifier: "#release-typescript",
    entry: "lib/typescript.js",
  },
] as const;

const developerToolExecutables = new Map<string, string>();

export interface MacOSPackagingToolchain {
  formatVersion: typeof MACOS_PACKAGING_TOOLCHAIN_FORMAT_VERSION;
  platform: "darwin";
  architecture: "arm64";
  bunVersion: typeof PINNED_BUN_VERSION;
  operatingSystem: {
    productVersion: string;
    buildVersion: string;
  };
  developerTools: {
    xcodeVersion: string;
    xcodeBuildVersion: string;
    gitVersion: string;
  };
  tools: Array<{
    name: MacOSPackagingToolName;
    sha256: string;
  }>;
  runtimeDependencies: Array<{
    name: ReleaseRuntimeDependencyName;
    version: string;
    lockIntegrity: string;
    entry: string;
    entrySha256: string;
    tree: TreeIdentity;
  }>;
}

export function resolveReleaseGitExecutable(): string {
  if (process.platform === "darwin") return resolveMacOSDeveloperTool("git");
  const selected = "/usr/bin/git";
  if (!isAbsolute(selected)) {
    throw new Error("The release Git executable path is not absolute");
  }
  const canonical = realpathSync(selected);
  if (!isAbsolute(canonical) || !canonical.endsWith("/usr/bin/git")) {
    throw new Error("The release Git executable has an unexpected canonical path");
  }
  return canonical;
}

function resolveMacOSDeveloperTool(name: "git" | "lipo" | "xcodebuild"): string {
  const cached = developerToolExecutables.get(name);
  if (cached) return cached;
  if (process.platform !== "darwin") {
    throw new Error(`The ${name} developer-tool backend can only be resolved on macOS`);
  }
  const selected = runText([FIXED_XCRUN_EXECUTABLE, "-f", name]);
  if (!isAbsolute(selected)) {
    throw new Error(`xcrun returned a non-absolute ${name} backend`);
  }
  const canonical = realpathSync(selected);
  if (!isAbsolute(canonical) || !canonical.endsWith(`/usr/bin/${name}`)) {
    throw new Error(`xcrun returned an unexpected ${name} backend`);
  }
  developerToolExecutables.set(name, canonical);
  return canonical;
}

export function assertPinnedBunVersion(): void {
  if (Bun.version !== PINNED_BUN_VERSION) {
    throw new Error(
      `Blackglass Bridge requires Bun ${PINNED_BUN_VERSION}; found ${Bun.version}`,
    );
  }
}

export async function inspectMacOSPackagingToolchain(): Promise<MacOSPackagingToolchain> {
  assertPinnedBunVersion();
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS packaging requires Apple Silicon macOS");
  }
  const tools: MacOSPackagingToolchain["tools"] = [
    { name: "bun", sha256: await sha256File(process.execPath) },
  ];
  for (const [name, path] of Object.entries(MACOS_PACKAGING_EXECUTABLES) as Array<
    [MacOSPackagingExecutableName, string]
  >) {
    tools.push({ name, sha256: await sha256File(path) });
  }
  const gitExecutable = resolveReleaseGitExecutable();
  tools.push({ name: "git", sha256: await sha256File(gitExecutable) });
  tools.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const xcodeVersion = runText([
    MACOS_PACKAGING_EXECUTABLES.xcodebuild,
    "-version",
  ]);
  const xcodeMatch = /^Xcode (\d+(?:\.\d+){0,2})\nBuild version ([A-Za-z0-9.]+)$/u.exec(
    xcodeVersion,
  );
  if (!xcodeMatch) {
    throw new Error("xcodebuild returned an unsupported version identity");
  }
  const gitVersion = runText([gitExecutable, "--version"]);
  const gitMatch = /^git version ([0-9]+(?:\.[0-9]+){1,3}(?: \(Apple Git-[^)]+\))?)$/u.exec(
    gitVersion,
  );
  if (!gitMatch) {
    throw new Error("Git returned an unsupported version identity");
  }
  const value: MacOSPackagingToolchain = {
    formatVersion: MACOS_PACKAGING_TOOLCHAIN_FORMAT_VERSION,
    platform: "darwin",
    architecture: "arm64",
    bunVersion: PINNED_BUN_VERSION,
    operatingSystem: {
      productVersion: runText([
        MACOS_PACKAGING_EXECUTABLES.sw_vers,
        "-productVersion",
      ]),
      buildVersion: runText([
        MACOS_PACKAGING_EXECUTABLES.sw_vers,
        "-buildVersion",
      ]),
    },
    developerTools: {
      xcodeVersion: xcodeMatch[1]!,
      xcodeBuildVersion: xcodeMatch[2]!,
      gitVersion: gitMatch[1]!,
    },
    tools,
    runtimeDependencies: await inspectReleaseRuntimeDependencies(),
  };
  assertMacOSPackagingToolchain(value);
  return value;
}

export function assertMacOSPackagingToolchain(
  value: unknown,
): asserts value is MacOSPackagingToolchain {
  if (
    !isRecord(value) ||
    value.formatVersion !== MACOS_PACKAGING_TOOLCHAIN_FORMAT_VERSION ||
    value.platform !== "darwin" ||
    value.architecture !== "arm64" ||
    value.bunVersion !== PINNED_BUN_VERSION ||
    !isRecord(value.operatingSystem) ||
    typeof value.operatingSystem.productVersion !== "string" ||
    !/^\d+(?:\.\d+){1,2}$/u.test(value.operatingSystem.productVersion) ||
    typeof value.operatingSystem.buildVersion !== "string" ||
    !/^[A-Za-z0-9.]+$/u.test(value.operatingSystem.buildVersion) ||
    !isRecord(value.developerTools) ||
    typeof value.developerTools.xcodeVersion !== "string" ||
    !/^\d+(?:\.\d+){0,2}$/u.test(value.developerTools.xcodeVersion) ||
    typeof value.developerTools.xcodeBuildVersion !== "string" ||
    !/^[A-Za-z0-9.]+$/u.test(value.developerTools.xcodeBuildVersion) ||
    typeof value.developerTools.gitVersion !== "string" ||
    !/^[0-9]+(?:\.[0-9]+){1,3}(?: \(Apple Git-[^)]+\))?$/u.test(
      value.developerTools.gitVersion,
    ) ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.runtimeDependencies)
  ) {
    throw new Error("Invalid macOS packaging toolchain evidence");
  }
  const expectedNames = [
    "bun",
    "git",
    ...Object.keys(MACOS_PACKAGING_EXECUTABLES),
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (value.tools.length !== expectedNames.length) {
    throw new Error("Invalid macOS packaging tool inventory");
  }
  for (let index = 0; index < expectedNames.length; index += 1) {
    const item = value.tools[index];
    if (
      !isRecord(item) ||
      item.name !== expectedNames[index] ||
      !isSha256(item.sha256)
    ) {
      throw new Error("Invalid macOS packaging tool identity");
    }
  }
  if (
    value.runtimeDependencies.length !==
    RELEASE_RUNTIME_DEPENDENCY_IMPORTS.length
  ) {
    throw new Error("Invalid release runtime dependency inventory");
  }
  for (
    let index = 0;
    index < RELEASE_RUNTIME_DEPENDENCY_IMPORTS.length;
    index += 1
  ) {
    const dependency = value.runtimeDependencies[index];
    const expected = RELEASE_RUNTIME_DEPENDENCY_IMPORTS[index]!;
    if (
      !isRecord(dependency) ||
      dependency.name !== expected.name ||
      typeof dependency.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(dependency.version) ||
      typeof dependency.lockIntegrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(dependency.lockIntegrity) ||
      dependency.entry !== expected.entry ||
      !isSha256(dependency.entrySha256)
    ) {
      throw new Error("Invalid release runtime dependency identity");
    }
    assertTreeIdentity(dependency.tree, dependency.name as string);
  }
}

async function inspectReleaseRuntimeDependencies(): Promise<
  MacOSPackagingToolchain["runtimeDependencies"]
> {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const lock = JSON.parse(
    await readFile(resolve(repositoryRoot, "package-lock.json"), "utf8"),
  ) as { packages?: Record<string, { version?: unknown; integrity?: unknown }> };
  if (!isRecord(lock.packages)) {
    throw new Error("package-lock.json has no package inventory");
  }
  const dependencies: MacOSPackagingToolchain["runtimeDependencies"] = [];
  for (const dependency of RELEASE_RUNTIME_DEPENDENCY_IMPORTS) {
    const { name } = dependency;
    const locked = lock.packages[`node_modules/${name}`];
    if (
      !isRecord(locked) ||
      typeof locked.version !== "string" ||
      typeof locked.integrity !== "string"
    ) {
      throw new Error(`package-lock.json does not bind ${name}`);
    }
    const packageRoot = resolve(repositoryRoot, "node_modules", name);
    const resolvedEntry = realpathSync(
      Bun.resolveSync(
        dependency.specifier,
        resolve(repositoryRoot, dependency.importer),
      ),
    );
    const expectedEntry = realpathSync(resolve(packageRoot, dependency.entry));
    if (resolvedEntry !== expectedEntry) {
      throw new Error(
        `Pinned ${name} import does not resolve to its attested root entry`,
      );
    }
    const installed = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (installed.name !== name || installed.version !== locked.version) {
      throw new Error(`Installed ${name} does not match package-lock.json`);
    }
    dependencies.push({
      name,
      version: locked.version,
      lockIntegrity: locked.integrity,
      entry: dependency.entry,
      entrySha256: await sha256File(resolvedEntry),
      tree: await computeTreeIdentity(packageRoot),
    });
  }
  return dependencies;
}

function assertTreeIdentity(value: unknown, label: string): asserts value is TreeIdentity {
  if (
    !isRecord(value) ||
    value.formatVersion !== TREE_IDENTITY_FORMAT_VERSION ||
    !isSha256(value.sha256)
  ) {
    throw new Error(`Invalid ${label} runtime dependency tree`);
  }
  for (const field of [
    "entries",
    "files",
    "directories",
    "symlinks",
    "fileBytes",
  ] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new Error(`Invalid ${label} runtime dependency ${field}`);
    }
  }
  if (
    value.entries !==
    (value.files as number) +
      (value.directories as number) +
      (value.symlinks as number)
  ) {
    throw new Error(`Inconsistent ${label} runtime dependency tree counts`);
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function runText(arguments_: string[]): string {
  const result = Bun.spawnSync(arguments_, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8").trim());
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
