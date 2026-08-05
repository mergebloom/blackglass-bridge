import { createHash } from "node:crypto";
import type { MacOSCodeInventory } from "./macos-code-inventory";
import type { TreeIdentity } from "./tree-identity";
import { stableJson } from "./stable-json";

export const BRIDGE_LAUNCH_CONFIG_SCHEMA_VERSION = 1;
export const BRIDGE_BUNDLE_NAME = "Blackglass.app" as const;
export const LEGACY_BRIDGE_BUNDLE_NAME = "Blackglass Bridge.app" as const;
export const BRIDGE_APPLICATION_NAME = "Blackglass" as const;
export const BRIDGE_BUNDLE_IDENTIFIER = "com.blackglass.bridge" as const;
export const BRIDGE_EXECUTABLE_NAME = "blackglass-bridge" as const;
export const BRIDGE_ICON_FILE = "blackglass-prism.icns" as const;
export const BRIDGE_PROFILE_DIRECTORY = "Blackglass Profile" as const;

export interface BridgeLaunchConfig {
  schemaVersion: typeof BRIDGE_LAUNCH_CONFIG_SCHEMA_VERSION;
  blackglassVersion: string;
  rendererVersion: string;
  adapterFileName: "blackglass.asar";
  adapterSha256: string;
  adapterProfileFileName: string;
  officialAppPath: string;
  officialBundleIdentifier: "md.obsidian";
  officialExecutableName: "Obsidian";
  officialAppTree: TreeIdentity;
  officialCodeInventory: MacOSCodeInventory;
  profileDirectory: typeof BRIDGE_PROFILE_DIRECTORY;
  profileMode: 448;
  updateDisabled: true;
  requireExclusiveOfficialInstance: true;
}

export function adapterProfileFileName(rendererVersion: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(rendererVersion);
  if (!match) throw new Error("Renderer version must be a stable semantic version");
  const patch = Number.parseInt(match[3]!, 10);
  if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Renderer patch version cannot be incremented safely");
  }
  return `obsidian-${match[1]}.${match[2]}.${patch + 1}.asar`;
}

export function assertBridgeLaunchConfig(
  value: unknown,
): asserts value is BridgeLaunchConfig {
  if (
    !isRecord(value) ||
    value.schemaVersion !== BRIDGE_LAUNCH_CONFIG_SCHEMA_VERSION ||
    typeof value.blackglassVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.blackglassVersion) ||
    typeof value.rendererVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(value.rendererVersion) ||
    value.adapterFileName !== "blackglass.asar" ||
    !isSha256(value.adapterSha256) ||
    value.adapterProfileFileName !== adapterProfileFileName(value.rendererVersion) ||
    typeof value.officialAppPath !== "string" ||
    !value.officialAppPath.startsWith("/") ||
    !value.officialAppPath.endsWith("/Obsidian.app") ||
    value.officialBundleIdentifier !== "md.obsidian" ||
    value.officialExecutableName !== "Obsidian" ||
    !isTreeIdentity(value.officialAppTree) ||
    !isCodeInventory(value.officialCodeInventory) ||
    value.profileDirectory !== BRIDGE_PROFILE_DIRECTORY ||
    value.profileMode !== 0o700 ||
    value.updateDisabled !== true ||
    value.requireExclusiveOfficialInstance !== true
  ) {
    throw new Error("Invalid Blackglass Bridge launch configuration");
  }
}

export function bridgeLaunchConfigSha256(value: BridgeLaunchConfig): string {
  assertBridgeLaunchConfig(value);
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function packagedLauncherArguments(arguments_: string[]): {
  profilePath?: string;
  vaultPath?: string;
  blackglassHomePath?: string;
  receiptPath?: string;
  runtimeArguments: string[];
} {
  const values = new Map<string, string>();
  const runtimeArguments: string[] = [];
  const reserved = new Set([
    "--blackglass-profile",
    "--blackglass-vault",
    "--blackglass-home",
    "--blackglass-runtime-receipt",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!reserved.has(argument)) {
      runtimeArguments.push(argument);
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) {
      throw new Error(`Invalid or duplicate packaged launcher option: ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }
  return {
    ...(values.get("--blackglass-profile") ? { profilePath: values.get("--blackglass-profile")! } : {}),
    ...(values.get("--blackglass-vault") ? { vaultPath: values.get("--blackglass-vault")! } : {}),
    ...(values.get("--blackglass-home") ? { blackglassHomePath: values.get("--blackglass-home")! } : {}),
    ...(values.get("--blackglass-runtime-receipt") ? { receiptPath: values.get("--blackglass-runtime-receipt")! } : {}),
    runtimeArguments,
  };
}

function isTreeIdentity(value: unknown): boolean {
  return isRecord(value) && value.formatVersion === 1 && isSha256(value.sha256) &&
    ["entries", "files", "directories", "symlinks", "fileBytes"].every(
      (field) => Number.isSafeInteger(value[field]) && (value[field] as number) >= 0,
    );
}

function isCodeInventory(value: unknown): boolean {
  return isRecord(value) && value.formatVersion === 1 && isSha256(value.sha256) &&
    Array.isArray(value.entries) && value.entries.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
