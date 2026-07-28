import { describe, expect, test } from "bun:test";
import { parseStrictFlags } from "../tools/cli-flags";

describe("strict command-line flags", () => {
  test("parses value and boolean flags", () => {
    const parsed = parseStrictFlags(["--name", "value", "--force"], {
      valueFlags: ["--name"],
      booleanFlags: ["--force"],
    });
    expect(parsed.values.get("--name")).toBe("value");
    expect(parsed.booleans.has("--force")).toBe(true);
  });

  test("rejects unknown, duplicate, and missing flags", () => {
    expect(() => parseStrictFlags(["--unknown"], {})).toThrow("Unknown");
    expect(() =>
      parseStrictFlags(["--force", "--force"], { booleanFlags: ["--force"] }),
    ).toThrow("Duplicate");
    expect(() => parseStrictFlags(["--name"], { valueFlags: ["--name"] })).toThrow(
      "Missing value",
    );
  });
});
