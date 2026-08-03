import { describe, expect, test } from "bun:test";
import {
  DEFAULT_E2E_SCENARIO,
  E2E_SCENARIO_IDS,
  e2eScenarioCheckpointDefinition,
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

  test("gives every phase checkpoint an executable client and UI contract", () => {
    for (const scenarioId of E2E_SCENARIO_IDS.filter(
      (value) => value !== "E2E-RELEASE-SYNC-RECOVERY",
    )) {
      const scenario = e2eScenarioDefinition(scenarioId);
      for (const checkpoint of scenario.checkpoints) {
        const contract = e2eScenarioCheckpointDefinition(scenarioId, checkpoint);
        expect(scenario.clients).toContain(contract.client);
        expect(contract.path).toBe(checkpoint);
        expect(Array.isArray(contract.requiredText)).toBe(true);
        expect(Array.isArray(contract.forbiddenText)).toBe(true);
      }
    }
  });

  test("binds password rejection, managed no-password, and outsider isolation", () => {
    expect(
      e2eScenarioCheckpointDefinition(
        "E2E-P4-CUSTOM-E2EE",
        "phase-4-custom/wrong-password",
      ),
    ).toMatchObject({
      client: "client-b",
      connected: false,
      requiredText: ["Unable to access vault", "Unlock your remote vault"],
    });
    expect(
      e2eScenarioCheckpointDefinition(
        "E2E-P4-MANAGED-ENCRYPTION",
        "phase-4-managed/connected-without-password",
      ).forbiddenText,
    ).toContain("Encryption password");
    expect(
      e2eScenarioCheckpointDefinition(
        "E2E-P4-CUSTOM-E2EE",
        "phase-4-custom/outsider-isolated",
      ),
    ).toMatchObject({ client: "client-c", connected: false });
  });
});
