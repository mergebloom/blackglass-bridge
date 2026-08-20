import { createHash } from "node:crypto";
import { stableJson } from "./stable-json";
import type { TreeIdentity } from "./tree-identity";

export const LINUX_CLIENT_CONFIG_SCHEMA_VERSION = 1;

export interface LinuxClientConfig {
  schemaVersion: typeof LINUX_CLIENT_CONFIG_SCHEMA_VERSION;
  blackglassVersion: string;
  bridgeRevision: string;
  rendererVersion: "1.13.4";
  architecture: "amd64" | "arm64";
  endpoints: { controlOrigin: string; dataHost: string };
  upstream: {
    archiveSha256: string;
    runtimeTree: TreeIdentity;
    rendererAsarSha256: string;
    wrapperAsarSha256: string;
    executableSha256: string;
    cliExecutableSha256: string;
  };
  generated: {
    rendererSha256: string;
    cliExecutableSha256: string;
    bridgeExecutableSha256: string;
  };
  paths: {
    runtime: "runtime";
    renderer: "resources/blackglass.asar";
    cliExecutable: "libexec/blackglass-cli";
    cliShim: "libexec/blackglass-cli-shim";
    bridgeExecutable: "libexec/blackglass-bridge";
    icon: "share/blackglass-prism.png";
  };
  launchPolicy: {
    profileDirectory: "Blackglass";
    profileMode: 448;
    updateDisabled: true;
    cliEnabled: true;
    exactRuntimeVerifiedAtEveryLaunch: true;
    isolatedCliSocket: ".blackglass-c.sock";
  };
}

export function assertLinuxClientConfig(value: unknown): asserts value is LinuxClientConfig {
  if (!isRecord(value)) throw new Error("Linux client configuration is not an object");
  if (
    value.schemaVersion !== LINUX_CLIENT_CONFIG_SCHEMA_VERSION ||
    typeof value.blackglassVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.blackglassVersion) ||
    typeof value.bridgeRevision !== "string" || !/^[a-f0-9]{40}$/u.test(value.bridgeRevision) ||
    value.rendererVersion !== "1.13.4" ||
    (value.architecture !== "amd64" && value.architecture !== "arm64") ||
    !isEndpoints(value.endpoints) || !isUpstream(value.upstream) || !isGenerated(value.generated) ||
    !isRecord(value.paths) ||
    value.paths.runtime !== "runtime" ||
    value.paths.renderer !== "resources/blackglass.asar" ||
    value.paths.cliExecutable !== "libexec/blackglass-cli" ||
    value.paths.cliShim !== "libexec/blackglass-cli-shim" ||
    value.paths.bridgeExecutable !== "libexec/blackglass-bridge" ||
    value.paths.icon !== "share/blackglass-prism.png" ||
    !isRecord(value.launchPolicy) ||
    value.launchPolicy.profileDirectory !== "Blackglass" ||
    value.launchPolicy.profileMode !== 0o700 ||
    value.launchPolicy.updateDisabled !== true ||
    value.launchPolicy.cliEnabled !== true ||
    value.launchPolicy.exactRuntimeVerifiedAtEveryLaunch !== true ||
    value.launchPolicy.isolatedCliSocket !== ".blackglass-c.sock"
  ) throw new Error("Linux client configuration is malformed");
}

export function linuxClientConfigSha256(value: LinuxClientConfig): string {
  assertLinuxClientConfig(value);
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function isEndpoints(value: unknown): boolean {
  return isRecord(value) && typeof value.controlOrigin === "string" &&
    typeof value.dataHost === "string";
}
function isUpstream(value: unknown): boolean {
  return isRecord(value) && isSha256(value.archiveSha256) && isTree(value.runtimeTree) &&
    ["rendererAsarSha256", "wrapperAsarSha256", "executableSha256", "cliExecutableSha256"]
      .every((key) => isSha256(value[key]));
}
function isGenerated(value: unknown): boolean {
  return isRecord(value) &&
    ["rendererSha256", "cliExecutableSha256", "bridgeExecutableSha256"]
      .every((key) => isSha256(value[key]));
}
function isTree(value: unknown): boolean {
  return isRecord(value) && value.formatVersion === 1 && isSha256(value.sha256) &&
    ["entries", "files", "directories", "symlinks", "fileBytes"]
      .every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}
function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
