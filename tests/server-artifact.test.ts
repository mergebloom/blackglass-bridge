import { describe, expect, test } from "bun:test";
import { parseArchitecture } from "../tools/server-artifact";

describe("server artifact metadata", () => {
  test("normalizes common executable architecture descriptions", () => {
    expect(parseArchitecture("Mach-O 64-bit executable arm64")).toBe("arm64");
    expect(parseArchitecture("ELF 64-bit LSB pie executable, x86-64")).toBe("x86_64");
    expect(
      parseArchitecture("Mach-O universal binary with 2 architectures: [x86_64] [arm64]"),
    ).toBe("universal");
    expect(parseArchitecture("POSIX shell script")).toBe("unknown");
  });
});
