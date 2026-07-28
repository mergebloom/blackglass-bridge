const CORE_IDENTIFIER = String.raw`(?:0|[1-9]\d*)`;
const NON_NUMERIC_PRERELEASE_IDENTIFIER =
  String.raw`(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const PRERELEASE_IDENTIFIER =
  String.raw`(?:${CORE_IDENTIFIER}|${NON_NUMERIC_PRERELEASE_IDENTIFIER})`;

export const SUPPORTED_SEMVER_PATTERN = new RegExp(
  String.raw`^${CORE_IDENTIFIER}\.${CORE_IDENTIFIER}\.${CORE_IDENTIFIER}` +
    String.raw`(?:-${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*)?$`,
  "u",
);

export const SUPPORTED_STABLE_SEMVER_PATTERN = new RegExp(
  String.raw`^${CORE_IDENTIFIER}\.${CORE_IDENTIFIER}\.${CORE_IDENTIFIER}$`,
  "u",
);

/** SemVer 2.0 without build metadata, which Blackglass does not publish. */
export function isSupportedSemver(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_SEMVER_PATTERN.test(value);
}

/** A supported SemVer with no prerelease or build component. */
export function isSupportedStableSemver(value: unknown): value is string {
  return (
    typeof value === "string" && SUPPORTED_STABLE_SEMVER_PATTERN.test(value)
  );
}
