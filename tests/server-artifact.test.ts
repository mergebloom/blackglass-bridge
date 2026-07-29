import { describe, expect, test } from "bun:test";
import {
  assertServerArtifactSourceRevision,
  exactServerSourceRevision,
  parseArchitecture,
  parseServerBuildInfo,
} from "../tools/server-artifact";

describe("server artifact metadata", () => {
  test("requires the explicitly selected source revision", () => {
    const revision = "a".repeat(40);
    expect(exactServerSourceRevision(revision)).toBe(revision);
    for (const malformed of [undefined, "unknown", "A".repeat(40), "a".repeat(39)]) {
      expect(() => exactServerSourceRevision(malformed)).toThrow(
        "must be a full lowercase Git commit",
      );
    }
    expect(() =>
      assertServerArtifactSourceRevision({ sourceRevision: revision }, revision)
    ).not.toThrow();
    expect(() =>
      assertServerArtifactSourceRevision(
        { sourceRevision: "b".repeat(40) },
        revision,
      )
    ).toThrow(`expected ${revision}`);
  });

  test("normalizes common executable architecture descriptions", () => {
    expect(parseArchitecture("Mach-O 64-bit executable arm64")).toBe("arm64");
    expect(parseArchitecture("ELF 64-bit LSB pie executable, x86-64")).toBe("x86_64");
    expect(
      parseArchitecture("Mach-O universal binary with 2 architectures: [x86_64] [arm64]"),
    ).toBe("universal");
    expect(parseArchitecture("POSIX shell script")).toBe("unknown");
  });

  test("requires build metadata bound to an exact source revision", () => {
    const sourceRevision = "a".repeat(40);
    expect(
      parseServerBuildInfo(
        JSON.stringify({
          name: "blackglass-server",
          version: "0.2.2",
          sourceRevision,
        }),
        "0.2.2",
      ),
    ).toEqual({ name: "blackglass-server", version: "0.2.2", sourceRevision });
    for (const value of [
      { name: "blackglass-server", version: "0.2.1", sourceRevision },
      { name: "blackglass-server", version: "0.2.2", sourceRevision: "unknown" },
      { name: "other", version: "0.2.2", sourceRevision },
    ]) {
      expect(() => parseServerBuildInfo(JSON.stringify(value), "0.2.2")).toThrow();
    }
    for (const version of ["01.2.3", "1.2.3-01", "1.2.3+build"]) {
      expect(() =>
        parseServerBuildInfo(
          JSON.stringify({
            name: "blackglass-server",
            version,
            sourceRevision,
          }),
          version,
        ),
      ).toThrow();
    }
  });
});
