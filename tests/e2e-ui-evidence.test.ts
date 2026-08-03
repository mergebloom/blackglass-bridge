import { describe, expect, test } from "bun:test";
import { E2E_UI_EVIDENCE_SCHEMA_VERSION } from "../tools/e2e-ui-evidence";

describe("E2E UI evidence contract", () => {
  test("uses the current bound snapshot schema", () => {
    expect(E2E_UI_EVIDENCE_SCHEMA_VERSION).toBe(2);
  });
});
