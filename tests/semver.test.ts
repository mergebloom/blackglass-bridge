import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  isSupportedSemver,
  isSupportedStableSemver,
} from "../tools/semver";
import { releaseValidationRecordFileName } from "../tools/release-validation";
import { isGeneratedValidationRecordPath } from "../tools/tooling-source";

const semverScript = resolve(import.meta.dir, "../scripts/semver.sh");

const supported = [
  "0.0.0",
  "1.2.3",
  "1.2.3-0",
  "1.2.3-alpha",
  "1.2.3-alpha.1",
  "1.2.3-0A.01alpha",
  "1.2.3---",
] as const;

const unsupported = [
  "",
  "1.2",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3-01",
  "1.2.3-alpha.01",
  "1.2.3-alpha..1",
  "1.2.3-alpha.",
  "1.2.3-.alpha",
  "1.2.3-",
  "1.2.3+build",
  "1.2.3-alpha+build",
  "v1.2.3",
] as const;

describe("supported semantic versions", () => {
  test("accepts the supported no-build SemVer grammar", () => {
    for (const version of supported) {
      expect(isSupportedSemver(version), version).toBe(true);
      expect(bashAccepts("is_supported_semver", version), version).toBe(true);
    }
  });

  test("rejects leading zeros, empty identifiers, and build metadata", () => {
    for (const version of unsupported) {
      expect(isSupportedSemver(version), version).toBe(false);
      expect(bashAccepts("is_supported_semver", version), version).toBe(false);
      expect(() => releaseValidationRecordFileName(version, "1.12.7"), version)
        .toThrow();
    }
  });

  test("keeps stable renderer versions and release tags strict", () => {
    expect(isSupportedStableSemver("1.12.7")).toBe(true);
    expect(isSupportedStableSemver("01.12.7")).toBe(false);
    expect(isSupportedStableSemver("1.12.7-alpha")).toBe(false);
    expect(bashAccepts("is_supported_release_tag", "v1.2.3-alpha.1")).toBe(
      true,
    );
    for (const tag of ["1.2.3", "vv1.2.3", ...unsupported.map((v) => `v${v}`)]) {
      expect(bashAccepts("is_supported_release_tag", tag), tag).toBe(false);
    }
  });

  test("recognizes generated validation paths only for canonical versions", () => {
    expect(
      isGeneratedValidationRecordPath(
        "docs/validation/blackglass-1.2.3-alpha.1-" +
          "obsidian-1.12.7-qualification.json",
      ),
    ).toBe(true);
    for (const version of unsupported) {
      expect(
        isGeneratedValidationRecordPath(
          `docs/validation/blackglass-${version}-` +
            "obsidian-1.12.7-qualification.json",
        ),
        version,
      ).toBe(false);
    }
  });
});

function bashAccepts(
  functionName: "is_supported_semver" | "is_supported_release_tag",
  value: string,
): boolean {
  return (
    Bun.spawnSync(
      [
        "bash",
        "-c",
        `source "$1"; ${functionName} "$2"`,
        "blackglass-semver-test",
        semverScript,
        value,
      ],
      { stdout: "ignore", stderr: "pipe" },
    ).exitCode === 0
  );
}
