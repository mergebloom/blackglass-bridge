import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { stableJson } from "./stable-json";
import { MACOS_PACKAGING_EXECUTABLES } from "./packaging-toolchain";

export const MACOS_CODE_INVENTORY_FORMAT_VERSION = 1;

const CODE_BUNDLE_SUFFIXES = [
  ".app",
  ".appex",
  ".bundle",
  ".framework",
  ".plugin",
  ".xpc",
] as const;

const MACH_O_MAGICS = new Set([
  "cafebabe",
  "cafebabf",
  "cefaedfe",
  "cffaedfe",
  "feedface",
  "feedfacf",
  "bebafeca",
  "bfbafeca",
]);

export interface MacOSCodeInventoryEntry {
  path: string;
  kind: "bundle" | "mach-o";
  architectures: string[];
}

export interface MacOSCodeInventory {
  formatVersion: typeof MACOS_CODE_INVENTORY_FORMAT_VERSION;
  sha256: string;
  entries: MacOSCodeInventoryEntry[];
}

export type MacOSCodeInventoryVerification =
  | "source-contract"
  | "strict-all-architectures";

/**
 * Discovers every real code bundle and Mach-O in an application without
 * following symlinks. Framework aliases therefore do not duplicate their
 * canonical targets, while the app tree identity continues to bind the aliases.
 */
export async function inspectMacOSCodeInventory(
  appArgument: string,
  verification: MacOSCodeInventoryVerification,
): Promise<MacOSCodeInventory> {
  const appPath = resolve(appArgument);
  const appStat = await lstat(appPath);
  if (appStat.isSymbolicLink() || !appStat.isDirectory()) {
    throw new Error(`macOS code inventory root must be a real app directory: ${appPath}`);
  }
  const entries: MacOSCodeInventoryEntry[] = [];
  await walk(appPath, appPath, entries, verification);
  entries.sort((left, right) => compareStrings(left.path, right.path));
  const inventory = {
    formatVersion: MACOS_CODE_INVENTORY_FORMAT_VERSION,
    sha256: sha256(stableJson(entries)),
    entries,
  } satisfies MacOSCodeInventory;
  assertMacOSCodeInventory(inventory);
  return inventory;
}

export function assertMacOSCodeInventory(
  value: unknown,
): asserts value is MacOSCodeInventory {
  if (
    !isRecord(value) ||
    value.formatVersion !== MACOS_CODE_INVENTORY_FORMAT_VERSION ||
    !isSha256(value.sha256) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    throw new Error("Invalid macOS code inventory");
  }
  let previous = "";
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !isSafeInventoryPath(entry.path) ||
      (entry.kind !== "bundle" && entry.kind !== "mach-o") ||
      !Array.isArray(entry.architectures) ||
      entry.architectures.some(
        (architecture) =>
          typeof architecture !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(architecture),
      ) ||
      entry.architectures.some(
        (architecture, index, architectures) =>
          index > 0 && compareStrings(architectures[index - 1]!, architecture) >= 0,
      ) ||
      (entry.kind === "bundle" && entry.architectures.length !== 0) ||
      (entry.kind === "mach-o" && entry.architectures.length === 0) ||
      (previous && compareStrings(previous, entry.path) >= 0)
    ) {
      throw new Error("Invalid macOS code inventory entry");
    }
    previous = entry.path;
  }
  if (value.entries[0]?.path !== "." || value.entries[0]?.kind !== "bundle") {
    throw new Error("macOS code inventory does not bind the outer app bundle");
  }
  if (value.sha256 !== sha256(stableJson(value.entries))) {
    throw new Error("macOS code inventory digest is inconsistent");
  }
}

export function macOSCodeInventoriesEqual(
  left: MacOSCodeInventory,
  right: MacOSCodeInventory,
): boolean {
  assertMacOSCodeInventory(left);
  assertMacOSCodeInventory(right);
  return stableJson(left) === stableJson(right);
}

export function verifyMacOSCodeInventorySignatures(
  appArgument: string,
  inventory: MacOSCodeInventory,
): void {
  const appPath = resolve(appArgument);
  assertMacOSCodeInventory(inventory);
  for (const entry of inventory.entries) {
    assertSignedCode(
      entry.path === "." ? appPath : join(appPath, entry.path),
      entry.path,
      "strict-all-architectures",
    );
  }
}

async function walk(
  appPath: string,
  directory: string,
  output: MacOSCodeInventoryEntry[],
  verification: MacOSCodeInventoryVerification,
): Promise<void> {
  const relativeDirectory = inventoryPath(appPath, directory);
  if (relativeDirectory === "." || isCodeBundleName(basename(directory))) {
    assertSignedCode(directory, relativeDirectory, verification);
    output.push({ path: relativeDirectory, kind: "bundle", architectures: [] });
  }

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));
  const normalizedNames = new Set<string>();
  for (const entry of entries) {
    const normalizedName = entry.name.normalize("NFC");
    if (normalizedNames.has(normalizedName)) {
      throw new Error(`Duplicate normalized app path in code inventory: ${normalizedName}`);
    }
    normalizedNames.add(normalizedName);
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      // Framework aliases are covered by the exact application tree and their
      // canonical targets below. Never follow an untrusted link while scanning.
      continue;
    }
    if (stat.isDirectory()) {
      await walk(appPath, path, output, verification);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported app entry in macOS code inventory: ${path}`);
    }
    if (!(await isMachO(path))) continue;
    const relativePath = inventoryPath(appPath, path);
    assertSignedCode(path, relativePath, verification);
    output.push({
      path: relativePath,
      kind: "mach-o",
      architectures: machOArchitectures(path, relativePath),
    });
  }
}

async function isMachO(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytesRead === bytes.length && MACH_O_MAGICS.has(bytes.toString("hex"));
  } finally {
    await file.close();
  }
}

function assertSignedCode(
  path: string,
  label: string,
  verification: MacOSCodeInventoryVerification,
): void {
  const arguments_ = verification === "strict-all-architectures"
    ? [
        MACOS_PACKAGING_EXECUTABLES.codesign,
        "--verify",
        "--strict",
        "--all-architectures",
        path,
      ]
    : [
        MACOS_PACKAGING_EXECUTABLES.codesign,
        "--display",
        "--verbose=1",
        "--all-architectures",
        path,
      ];
  const result = Bun.spawnSync(
    arguments_,
    { stdout: "ignore", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Unsigned or invalid ${verification} macOS code inventory target ${label}: ${Buffer.from(
        result.stderr,
      ).toString("utf8").trim()}`,
    );
  }
}

function machOArchitectures(path: string, label: string): string[] {
  const result = Bun.spawnSync([MACOS_PACKAGING_EXECUTABLES.lipo, "-archs", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Cannot inspect macOS code architectures for ${label}: ${Buffer.from(
        result.stderr,
      ).toString("utf8").trim()}`,
    );
  }
  const architectures = Buffer.from(result.stdout)
    .toString("utf8")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .sort(compareStrings);
  if (
    architectures.length === 0 ||
    new Set(architectures).size !== architectures.length
  ) {
    throw new Error(`Invalid macOS code architecture inventory for ${label}`);
  }
  return architectures;
}

function inventoryPath(appPath: string, path: string): string {
  const value = relative(appPath, path);
  return value ? value.split(sep).join("/").normalize("NFC") : ".";
}

function isCodeBundleName(name: string): boolean {
  const lower = name.toLowerCase();
  return CODE_BUNDLE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isSafeInventoryPath(value: string): boolean {
  return (
    value === "." ||
    (value === value.normalize("NFC") &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."))
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function compareStrings(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
