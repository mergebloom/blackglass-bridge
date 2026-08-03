import { describe, expect, test } from "bun:test";
import {
  compareCodeUnitStrings,
  stableJson,
  stableJsonFile,
} from "../tools/stable-json";

describe("locale-independent stable JSON", () => {
  test("uses code-unit ordering even for names with locale-specific collation", () => {
    expect(["path-safety.ts", "patch-client.ts"].sort(compareCodeUnitStrings)).toEqual([
      "patch-client.ts",
      "path-safety.ts",
    ]);
    expect(stableJson({ "path-safety.ts": 2, "patch-client.ts": 1 })).toBe(
      '{"patch-client.ts":1,"path-safety.ts":2}',
    );
  });

  test("canonicalizes nested object insertion order without reordering arrays", () => {
    expect(stableJson({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
    expect(stableJson({ a: true, z: [{ a: 1, b: 2 }] })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
  });

  test("rejects values that JSON cannot encode", () => {
    expect(() => stableJson(undefined)).toThrow("JSON-serializable");
  });

  test("emits canonical JSON file bytes independent of insertion order", () => {
    const first = stableJsonFile({ z: [{ b: 2, a: 1 }], a: true });
    const second = stableJsonFile({ a: true, z: [{ a: 1, b: 2 }] });
    expect(first).toBe('{"a":true,"z":[{"a":1,"b":2}]}\n');
    expect(second).toBe(first);
  });
});
