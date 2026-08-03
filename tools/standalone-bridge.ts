import type { ToolingSourceIdentity } from "./tooling-source";
import { assertToolingSourceIdentity } from "./tooling-source";
import { isSupportedSemver } from "./semver";

export const STANDALONE_BRIDGE_BUILD_INFO_SCHEMA_VERSION = 1;

export interface StandaloneBridgeBuildInfo {
  schemaVersion: typeof STANDALONE_BRIDGE_BUILD_INFO_SCHEMA_VERSION;
  name: "blackglass-bridge";
  version: string;
  sourceRevision: string;
  target: { operatingSystem: "macOS"; architecture: "arm64" };
  toolingSource: ToolingSourceIdentity;
}

export function assertStandaloneBridgeBuildInfo(
  value: unknown,
): asserts value is StandaloneBridgeBuildInfo {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STANDALONE_BRIDGE_BUILD_INFO_SCHEMA_VERSION ||
    value.name !== "blackglass-bridge" ||
    !isSupportedSemver(value.version) ||
    typeof value.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.sourceRevision) ||
    !isRecord(value.target) ||
    value.target.operatingSystem !== "macOS" ||
    value.target.architecture !== "arm64"
  ) {
    throw new Error("Standalone Bridge build information is malformed");
  }
  assertToolingSourceIdentity(value.toolingSource);
  if (
    value.toolingSource.gitRevision !== value.sourceRevision ||
    value.toolingSource.worktreeClean !== true
  ) {
    throw new Error("Standalone Bridge is not bound to an exact clean tooling source");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
