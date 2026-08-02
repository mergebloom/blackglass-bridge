import { describe, expect, test } from "bun:test";
import {
  DEFAULT_E2E_SCENARIO,
  E2E_SCENARIO_IDS,
  e2eScenarioDefinition,
  parseE2EScenarioId,
  preparedE2EScenarioId,
  scenarioValidationFileName,
} from "../tools/e2e-scenario";

describe("E2E scenario identity", () => {
  test("accepts every named release scenario", () => {
    for (const scenario of E2E_SCENARIO_IDS) {
      expect(parseE2EScenarioId(scenario)).toBe(scenario);
    }
  });

  test("keeps old prepared runs on the generic release gate", () => {
    expect(preparedE2EScenarioId(undefined)).toBe(DEFAULT_E2E_SCENARIO);
  });

  test("rejects ambiguous, empty, and unknown scenarios", () => {
    for (const value of [null, "", "custom-e2ee", "E2E-P4-CUSTOM-E2EE "]) {
      expect(() => parseE2EScenarioId(value)).toThrow("Unsupported E2E scenario");
    }
  });

  test("binds the required three-client checkpoints and canonical result name", () => {
    const definition = e2eScenarioDefinition("E2E-P4-CUSTOM-E2EE");
    expect(definition.clients).toEqual(["client-a", "client-b", "client-c"]);
    expect(definition.checkpoints).toContain("phase-4-custom/wrong-password");
    expect(
      scenarioValidationFileName(
        definition.id,
        "1.13.4",
        "a".repeat(40),
      ),
    ).toBe(`phase-4-custom-e2ee-obsidian-1.13.4-${"a".repeat(40)}.json`);
  });
});
